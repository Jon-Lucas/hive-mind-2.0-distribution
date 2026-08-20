import type { HiveDatabase } from "../storage/database.js";

export interface PendingApproval { planId: number; version: number; workItemId: number; title: string }

/**
 * Everything the studio is waiting on a human for. The workflow is purely
 * event-driven — no approval click, no run — so any item listed here sits
 * forever unless someone is told about it.
 */
export interface WatchdogWaiting {
  approvals: PendingApproval[];
  blocked: Array<{ workItemId: number; title: string; cycleCount: number; stage: string | null }>;
  drafts: Array<{ workItemId: number; title: string }>;
  /** Approved and runnable, yet nothing is running: the scheduler lost it. */
  stalled: Array<{ workItemId: number; title: string; state: string }>;
  /**
   * Finished, and the operator has not said a word since. "Done" was the one
   * outcome nothing ever chased: the orchestrator announced PRODUCT READY once,
   * fire-and-forget, and because a complete item waits on nobody the watchdog
   * fell silent the moment it landed. Work item #11 finished at 17:09 and the
   * operator found out four hours later by asking.
   */
  completed: Array<{ workItemId: number; title: string; testedCommit: string | null }>;
}

export interface WatchdogOptions {
  tickMs: number;
  /** Minimum silence (no events, no chat) before a reminder may fire. */
  quietMs: number;
  /** Minimum spacing between reminders about the same waiting set. */
  repeatMs: number;
  /**
   * A "harness" block (git rebase/setup failure before the developer stage
   * even starts) is mechanical and usually a quick fix, unlike a stuck plan
   * or a genuine tester/developer judgment call — so it gets a much shorter
   * quiet window instead of waiting behind the general reminder cadence.
   */
  harnessQuietMs?: number;
  /**
   * How many times a finished work item may be re-announced before the
   * watchdog accepts that the operator is away. Unlike a blocked item, a
   * complete one is not costing anything by waiting, so this stops rather
   * than nags forever.
   */
  completionReminderLimit?: number;
  /**
   * Whether the orchestrator is mid-phase right now. The agent_runs check
   * cannot see the platform-script phase — those run as harness code with no
   * agent row — so for the length of an emulator suite the database read
   * "item in testing, nothing running", and the watchdog told the operator
   * to restart the backend while the status line said the same run was
   * normal. Every platform phase past the quiet window fired one.
   */
  isEngineBusy?: () => boolean;
  /**
   * A `running` row whose last liveness touch is older than this is treated
   * as leaked, not live. One such zombie row — a crash between the run ending
   * and its status being recorded — otherwise silences every reminder the
   * watchdog will ever send, because anyAgentRunning short-circuits the whole
   * evaluation. Set comfortably above the runner's inactivity kill ceiling: a
   * genuine run can never sit silent longer than that before being ended.
   */
  staleRunMs?: number;
}

export interface WatchdogInput {
  now: Date;
  anyAgentRunning: boolean;
  /** True while the orchestrator is mid-phase — covers the agentless platform-script stretch. */
  engineBusy?: boolean;
  waiting: WatchdogWaiting;
  lastActivityAt: Date | null;
  lastReminderAt: Date | null;
  lastSignature: string | null;
  quietMs: number;
  repeatMs: number;
  harnessQuietMs?: number;
}

export type WatchdogDecision =
  | { remind: false }
  | { remind: true; message: string; approvals: PendingApproval[]; signature: string; completedIds: number[] };

export function waitingSignature(waiting: WatchdogWaiting): string {
  return JSON.stringify({
    approvals: waiting.approvals.map((entry) => entry.planId),
    blocked: waiting.blocked.map((entry) => entry.workItemId),
    drafts: waiting.drafts.map((entry) => entry.workItemId),
    stalled: waiting.stalled.map((entry) => entry.workItemId),
    completed: waiting.completed.map((entry) => entry.workItemId),
  });
}

export function evaluateWatchdog(input: WatchdogInput): WatchdogDecision {
  if (input.anyAgentRunning || input.engineBusy) return { remind: false };
  const { waiting } = input;
  const count = waiting.approvals.length + waiting.blocked.length + waiting.drafts.length
    + waiting.stalled.length + waiting.completed.length;
  if (count === 0) return { remind: false };
  const hasHarnessBlock = waiting.blocked.some((entry) => entry.stage === "harness");
  const effectiveQuietMs = hasHarnessBlock && input.harnessQuietMs !== undefined
    ? Math.min(input.quietMs, input.harnessQuietMs)
    : input.quietMs;
  if (input.lastActivityAt && input.now.getTime() - input.lastActivityAt.getTime() < effectiveQuietMs) {
    return { remind: false };
  }
  const signature = waitingSignature(waiting);
  if (
    input.lastSignature === signature
    && input.lastReminderAt
    && input.now.getTime() - input.lastReminderAt.getTime() < input.repeatMs
  ) {
    return { remind: false };
  }
  const lines: string[] = [];
  // A finished item leads, and gets its own headline: "idle, nothing will run"
  // reads as bad news, and burying "your build is done" under it is how a
  // completion goes unread even when it was delivered.
  if (waiting.completed.length > 0) {
    lines.push("**✅ Finished and waiting to be seen**");
    for (const entry of waiting.completed) {
      const commit = entry.testedCommit ? ` — tested commit ${entry.testedCommit.slice(0, 7)}` : "";
      lines.push(`• Work item #${entry.workItemId} "${entry.title}" is complete${commit}.`);
    }
    lines.push("_Repeats until you reply here._");
  }
  if (count > waiting.completed.length) {
    if (lines.length > 0) lines.push("");
    lines.push("**⏳ Hive Mind is idle**", "Nothing will run until one of these is resolved:");
  }
  for (const entry of waiting.approvals) {
    lines.push(`• Plan #${entry.planId} (v${entry.version}) for work item #${entry.workItemId} "${entry.title}" awaits your approval.`);
  }
  for (const entry of waiting.blocked) {
    const hint = entry.stage === "harness" ? " (harness stage — often just a git rebase conflict, usually quick to fix)" : "";
    lines.push(`• Work item #${entry.workItemId} "${entry.title}" is blocked after ${entry.cycleCount} cycle(s)${hint} — retry it from the GUI once the cause is addressed.`);
  }
  for (const entry of waiting.stalled) {
    lines.push(`• Work item #${entry.workItemId} "${entry.title}" is approved (${entry.state}) but nothing is running — a backend restart will re-schedule it.`);
  }
  for (const entry of waiting.drafts) {
    lines.push(`• Work item #${entry.workItemId} "${entry.title}" is a draft with no plan submitted.`);
  }
  return {
    remind: true,
    message: lines.join("\n"),
    approvals: waiting.approvals,
    signature,
    completedIds: waiting.completed.map((entry) => entry.workItemId),
  };
}

/** SQLite CURRENT_TIMESTAMP is naive UTC ("YYYY-MM-DD HH:MM:SS"). */
function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolves false when the reminder reached nobody. The watchdog's clock is
 * driven by delivery, not by intent: a send that silently failed used to still
 * consume the repeat window, so the studio could sit blocked for hours with a
 * tidy row of "reminded" events and an operator who had heard nothing.
 */
export type WatchdogNotifier = (
  message: string,
  approvals: PendingApproval[],
  meta: { completedIds: number[] },
) => Promise<boolean | void>;

export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private lastReminderAt: Date | null = null;
  private lastSignature: string | null = null;
  private restoredFromLog = false;

  constructor(
    private readonly database: HiveDatabase,
    private readonly notifier: WatchdogNotifier,
    private readonly options: WatchdogOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error("[watchdog] tick failed:", error));
    }, this.options.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const decision = evaluateWatchdog(this.read());
    if (!decision.remind) return;
    // A notifier that throws is as undelivered as one that returns false, and
    // must not be allowed to look like a delivered reminder.
    const delivered = await this.notifier(decision.message, decision.approvals, { completedIds: decision.completedIds })
      .then((result) => result !== false)
      .catch(() => false);
    if (!delivered) {
      // Leave the clock untouched so the next tick tries again, and record the
      // silence — an undelivered reminder is the failure that costs whole
      // nights, and it deserves to be visible in the event log.
      try {
        this.database.sqlite
          .prepare("INSERT INTO events (kind, actor, detail_json) VALUES ('watchdog_reminder_undelivered', 'system', ?)")
          .run(JSON.stringify({ signature: decision.signature }));
      } catch { /* reminder bookkeeping must never break the loop */ }
      console.error("[watchdog] idle reminder was not delivered; will retry next tick");
      return;
    }
    this.lastReminderAt = this.now();
    this.lastSignature = decision.signature;
    // One row per finished item, so the announcement cap survives a restart
    // and is not confused by other items joining or leaving the waiting set.
    for (const workItemId of decision.completedIds) {
      try {
        this.database.sqlite
          .prepare("INSERT INTO events (kind, actor, detail_json) VALUES ('watchdog_completion_announced', 'system', ?)")
          .run(JSON.stringify({ workItemId }));
      } catch { /* reminder bookkeeping must never break the loop */ }
    }
    // The reminder clock must survive restarts: with it only in memory, every
    // backend restart re-armed an immediate reminder and the operator got
    // nagged far more often than the repeat window promises.
    try {
      this.database.sqlite
        .prepare("INSERT INTO events (kind, actor, detail_json) VALUES ('watchdog_reminded', 'system', ?)")
        .run(JSON.stringify({ signature: decision.signature }));
    } catch { /* reminder bookkeeping must never break the loop */ }
  }

  /** Rehydrates the reminder clock from the event log after a restart. */
  private restoreLastReminder(): void {
    this.restoredFromLog = true;
    const row = this.database.sqlite.prepare(`
      SELECT created_at AS at, detail_json AS detail FROM events
      WHERE kind = 'watchdog_reminded' ORDER BY id DESC LIMIT 1
    `).get() as { at: string; detail: string } | undefined;
    if (!row) return;
    this.lastReminderAt = parseUtc(row.at);
    try {
      const parsed = JSON.parse(row.detail) as { signature?: string };
      this.lastSignature = parsed.signature ?? null;
    } catch { this.lastSignature = null; }
  }

  private read(): WatchdogInput {
    if (!this.restoredFromLog) this.restoreLastReminder();
    // SQLite timestamps are naive UTC strings; compare lexicographically.
    const staleCutoff = this.options.staleRunMs !== undefined
      ? new Date(this.now().getTime() - this.options.staleRunMs).toISOString().slice(0, 19).replace("T", " ")
      : "";
    // A Brain conversation turn is a tracked run but not engine work; letting
    // it count here would mute reminders every time the operator chats.
    const running = this.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running' AND role != 'brain' AND last_activity_at > ?")
      .get(staleCutoff) as { count: number };
    const approvals = this.database.sqlite.prepare(`
      SELECT pv.id AS planId, pv.version, wi.id AS workItemId, wi.title
      FROM work_items wi
      JOIN plan_versions pv ON pv.id = (
        SELECT id FROM plan_versions WHERE work_item_id = wi.id ORDER BY version DESC LIMIT 1
      )
      WHERE wi.state = 'awaiting_plan_approval'
      ORDER BY wi.id
    `).all() as PendingApproval[];
    const blocked = this.database.sqlite.prepare(`
      SELECT id AS workItemId, title, cycle_count AS cycleCount, blocked_stage AS stage FROM work_items WHERE state = 'blocked' ORDER BY id
    `).all() as Array<{ workItemId: number; title: string; cycleCount: number; stage: string | null }>;
    const drafts = this.database.sqlite.prepare(`
      SELECT id AS workItemId, title FROM work_items WHERE state = 'draft_plan' ORDER BY id
    `).all() as Array<{ workItemId: number; title: string }>;
    const stalled = this.database.sqlite.prepare(`
      SELECT id AS workItemId, title, state FROM work_items
      WHERE state IN ('ready_to_build', 'building', 'ready_to_test', 'testing', 'needs_fix') ORDER BY id
    `).all() as Array<{ workItemId: number; title: string; state: string }>;
    // Anything the operator has spoken since is acknowledged: they were here
    // after it landed. Without the message floor every historically complete
    // item would be re-announced the first time this runs.
    const completed = this.database.sqlite.prepare(`
      SELECT wi.id AS workItemId, wi.title, wi.tested_commit AS testedCommit FROM work_items wi
      WHERE wi.state = 'complete'
        AND wi.updated_at > COALESCE((SELECT MAX(created_at) FROM messages WHERE role = 'user'), '')
        AND (
          SELECT COUNT(*) FROM events
          WHERE kind = 'watchdog_completion_announced'
            AND json_extract(detail_json, '$.workItemId') = wi.id
        ) < ?
      ORDER BY wi.id
    `).all(this.options.completionReminderLimit ?? 3) as Array<{ workItemId: number; title: string; testedCommit: string | null }>;
    // The watchdog's own bookkeeping rows are not studio activity. Counting
    // them let a reminder push the quiet window forward by writing about
    // itself — most damagingly after a failed delivery, where the retry is
    // the whole point.
    const activity = this.database.sqlite.prepare(`
      SELECT MAX(at) AS at FROM (
        SELECT MAX(created_at) AS at FROM events WHERE kind NOT LIKE 'watchdog\\_%' ESCAPE '\\'
        UNION ALL
        SELECT MAX(created_at) AS at FROM messages
      )
    `).get() as { at: string | null };
    return {
      now: this.now(),
      anyAgentRunning: running.count > 0,
      engineBusy: this.options.isEngineBusy?.() ?? false,
      waiting: { approvals, blocked, drafts, stalled, completed },
      lastActivityAt: parseUtc(activity.at),
      lastReminderAt: this.lastReminderAt,
      lastSignature: this.lastSignature,
      quietMs: this.options.quietMs,
      repeatMs: this.options.repeatMs,
      harnessQuietMs: this.options.harnessQuietMs,
    };
  }
}
