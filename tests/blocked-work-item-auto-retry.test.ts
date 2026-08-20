import { afterEach, describe, expect, it } from "vitest";
import { createBlockedWorkItemAutoRetry, type BlockedWorkItemAutoRetry } from "../src/runtime/blocked-work-item-auto-retry.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowService, type BlockStage } from "../src/workflow/workflow-service.js";

const HARNESS_REASON = "Command failed: git rebase main\nRebasing (1/9)\nerror: could not apply 88797f0";
const TRANSIENT_REASON = 'claude developer run cancelled: init / aborted_streaming — "[ede_diagnostic';

describe("blocked work item auto-retry", () => {
  let database: HiveDatabase | undefined;
  let retryPolicy: BlockedWorkItemAutoRetry | undefined;
  afterEach(() => {
    retryPolicy?.stop();
    retryPolicy = undefined;
    database?.close();
    database = undefined;
  });

  function harness(delayMs = 0) {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Retry Lab");
    const item = workflow.createWorkItem(project.id, "flaky build");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    const scheduled: number[] = [];
    const notices: string[] = [];
    retryPolicy = createBlockedWorkItemAutoRetry({
      database,
      workflow,
      ensureReady: async () => {},
      schedule: (workItemId) => scheduled.push(workItemId),
      notify: (message) => { notices.push(message); },
      delayMs,
    });
    const block = (reason: string, stage: BlockStage | null) => workflow.block(item.id, reason, stage);
    return { workflow, itemId: item.id, scheduled, notices, policy: retryPolicy, block };
  }

  it("retries a harness-stage block once, after the delay", async () => {
    const { workflow, itemId, scheduled, notices, policy, block } = harness();
    block(HARNESS_REASON, "harness");

    const fired = policy.observeBlocked(itemId, HARNESS_REASON);
    expect(fired).not.toBe(false);
    await expect(fired).resolves.toBe(true);

    expect(workflow.getWorkItem(itemId).state).toBe("ready_to_build");
    expect(scheduled).toEqual([itemId]);
    expect(notices[0]).toContain(`Auto-retrying work item #${itemId}`);
    const detail = database!.sqlite.prepare(
      "SELECT detail_json AS detail FROM events WHERE kind = 'workflow_retried' ORDER BY id DESC LIMIT 1",
    ).get() as { detail: string };
    expect(JSON.parse(detail.detail)).toMatchObject({ workItemId: itemId, auto: true });
  });

  it("retries a run-startup flake even without a recorded stage", async () => {
    const { workflow, itemId, policy, block } = harness();
    block(TRANSIENT_REASON, null);

    await expect(policy.observeBlocked(itemId, TRANSIENT_REASON)).resolves.toBe(true);
    expect(workflow.getWorkItem(itemId).state).toBe("ready_to_build");
  });

  it("never touches a cancelled work item", () => {
    const { itemId, policy, block } = harness();
    block("stopped during the developer stage", "cancelled");

    expect(policy.observeBlocked(itemId, "stopped during the developer stage")).toBe(false);
  });

  it("leaves tester and budget blocks to the operator", () => {
    const { itemId, policy, block } = harness();

    block("agent reply contained no JSON object: **Verdict: passed.**", "tester");
    expect(policy.observeBlocked(itemId, "agent reply contained no JSON object: **Verdict: passed.**")).toBe(false);

    block("work item budget exhausted: $246.55 spent of $150.00 limit", "frontend");
    expect(policy.observeBlocked(itemId, "work item budget exhausted: $246.55 spent of $150.00 limit")).toBe(false);
  });

  it("stands down when a block follows its own auto-retry, and re-arms after a manual retry", async () => {
    const { workflow, itemId, scheduled, policy, block } = harness();
    block(HARNESS_REASON, "harness");
    await expect(policy.observeBlocked(itemId, HARNESS_REASON)).resolves.toBe(true);

    // The automatic retry hit the same conflict: this one is the operator's.
    block(HARNESS_REASON, "harness");
    expect(policy.observeBlocked(itemId, HARNESS_REASON)).toBe(false);

    // A manual retry resets the episode; the next block earns a fresh attempt.
    workflow.retryBlockedWorkItem(itemId);
    block(HARNESS_REASON, "harness");
    await expect(policy.observeBlocked(itemId, HARNESS_REASON)).resolves.toBe(true);
    expect(scheduled).toEqual([itemId, itemId]);
  });

  it("does not fire when the operator retries during the wait", async () => {
    const { workflow, itemId, scheduled, policy, block } = harness(20);
    block(HARNESS_REASON, "harness");
    const fired = policy.observeBlocked(itemId, HARNESS_REASON);
    expect(fired).not.toBe(false);

    workflow.retryBlockedWorkItem(itemId);

    await expect(fired).resolves.toBe(false);
    // Only the manual path scheduled anything; the timer stood down.
    expect(scheduled).toEqual([]);
    expect(workflow.getWorkItem(itemId).state).toBe("ready_to_build");
  });
});
