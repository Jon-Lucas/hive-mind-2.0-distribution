import type { HiveDatabase } from "../storage/database.js";
import type { WorkflowService } from "../workflow/workflow-service.js";
import { renderNotice } from "../discord/notice.js";

/**
 * The block reasons a retry has a real chance of clearing without any human
 * intervention: run-startup flakes, where the agent process died before doing
 * anything ("claude developer run cancelled: init / aborted_streaming — …").
 * Harness-stage blocks are eligible by stage instead — a retry rebuilds from
 * a clean boundary, so a rebase conflict or checkout hiccup gets one fresh
 * attempt. Everything else (tester schema drift, evidence validation, budget
 * exhaustion, cancels) waits for the operator as it always has.
 */
const TRANSIENT_RUN_FAILURE = /init \/ aborted_/;

const DEFAULT_DELAY_MS = 3 * 60_000;

export interface BlockedWorkItemAutoRetryDeps {
  database: HiveDatabase;
  workflow: WorkflowService;
  /** Provider-readiness gate — the same one the manual retry route runs. */
  ensureReady: () => Promise<void>;
  /** Hand the un-blocked item back to the scheduler. */
  schedule: (workItemId: number) => void;
  notify: (message: string) => void | Promise<void>;
  /** How long to sit on a block before retrying; production default 3 minutes. */
  delayMs?: number;
}

export interface BlockedWorkItemAutoRetry {
  /**
   * Called when a work item lands in `blocked`. Returns false when the block
   * is not auto-retryable; otherwise schedules one retry and resolves with
   * whether it actually fired (the operator may beat the timer).
   */
  observeBlocked(workItemId: number, reason: string): false | Promise<boolean>;
  stop(): void;
}

/**
 * One automatic retry for blocks that look transient, a few minutes after the
 * block lands. Production motivation: 23 blocks, 22 manual retries — the
 * operator was the retry button, once 11 hours after the fact. The block
 * notice still goes out first; if the retry fails and the item blocks again,
 * the policy stands down and the operator escalation works exactly as before.
 */
export function createBlockedWorkItemAutoRetry(deps: BlockedWorkItemAutoRetryDeps): BlockedWorkItemAutoRetry {
  const pending = new Map<number, NodeJS.Timeout>();
  let stopped = false;

  const lastRetryWasAutomatic = (workItemId: number): boolean => {
    const row = deps.database.sqlite.prepare(`
      SELECT detail_json AS detail FROM events
      WHERE kind = 'workflow_retried' AND json_extract(detail_json, '$.workItemId') = ?
      ORDER BY id DESC LIMIT 1
    `).get(workItemId) as { detail: string } | undefined;
    if (!row) return false;
    try {
      return (JSON.parse(row.detail) as { auto?: boolean }).auto === true;
    } catch {
      return false;
    }
  };

  const eligible = (workItemId: number, reason: string): boolean => {
    let item: ReturnType<WorkflowService["getWorkItem"]>;
    try {
      item = deps.workflow.getWorkItem(workItemId);
    } catch {
      return false;
    }
    if (item.state !== "blocked") return false;
    // A cancel is the operator's decision, never a flake.
    if (item.blockedStage === "cancelled") return false;
    if (item.blockedStage !== "harness" && !TRANSIENT_RUN_FAILURE.test(reason)) return false;
    // One automatic attempt per block: if the newest retry of this item was
    // already ours, this block is that retry failing — leave it to the operator.
    return !lastRetryWasAutomatic(workItemId);
  };

  return {
    observeBlocked(workItemId, reason) {
      if (stopped || pending.has(workItemId) || !eligible(workItemId, reason)) return false;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(workItemId);
          void (async () => {
            // Re-checked at fire time: the operator may have retried or the
            // state may have moved during the wait.
            if (stopped || !eligible(workItemId, reason)) return resolve(false);
            try {
              await deps.ensureReady();
              const { state } = deps.workflow.retryBlockedWorkItem(workItemId, { auto: true });
              deps.schedule(workItemId);
              await deps.notify(renderNotice({
                icon: "♻️",
                headline: `Auto-retrying work item #${workItemId} — the block looked transient`,
                body: [
                  "One automatic attempt per block. If it blocks again it will wait for you, as before.",
                ],
                meta: [`resuming at ${state}`],
              }));
              resolve(true);
            } catch {
              // Best effort only — the block notice already reached the
              // operator, so a failed auto-retry changes nothing for them.
              resolve(false);
            }
          })();
        }, deps.delayMs ?? DEFAULT_DELAY_MS);
        timer.unref?.();
        pending.set(workItemId, timer);
      });
    },
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
