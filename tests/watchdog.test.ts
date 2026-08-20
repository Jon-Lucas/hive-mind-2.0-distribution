import { afterEach, describe, expect, it } from "vitest";
import { evaluateWatchdog, waitingSignature, Watchdog, type PendingApproval, type WatchdogWaiting } from "../src/runtime/watchdog.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

const MINUTE = 60_000;

function waiting(overrides: Partial<WatchdogWaiting> = {}): WatchdogWaiting {
  return { approvals: [], blocked: [], drafts: [], stalled: [], completed: [], ...overrides };
}

const approval: PendingApproval = { planId: 7, version: 2, workItemId: 3, title: "v1 tracker" };

function input(overrides: Partial<Parameters<typeof evaluateWatchdog>[0]> = {}) {
  return {
    now: new Date("2026-07-31T12:00:00Z"),
    anyAgentRunning: false,
    waiting: waiting({ approvals: [approval] }),
    lastActivityAt: new Date("2026-07-31T11:00:00Z"),
    lastReminderAt: null,
    lastSignature: null,
    quietMs: 10 * MINUTE,
    repeatMs: 60 * MINUTE,
    ...overrides,
  };
}

describe("watchdog decision", () => {
  it("reminds about a plan that awaits approval once the studio has gone quiet", () => {
    const decision = evaluateWatchdog(input());
    if (!decision.remind) throw new Error("expected a reminder");
    expect(decision.message).toContain('Plan #7 (v2) for work item #3 "v1 tracker" awaits your approval');
    expect(decision.approvals).toEqual([approval]);
  });

  it("stays silent while an agent is running", () => {
    expect(evaluateWatchdog(input({ anyAgentRunning: true }))).toEqual({ remind: false });
  });

  it("stays silent while the engine is mid-phase with no agent process", () => {
    // The platform-script phase writes no agent_runs row and no events, so
    // without this flag a 20-minute emulator suite read as "idle, restart the
    // backend" from its tenth minute onward.
    expect(evaluateWatchdog(input({ engineBusy: true }))).toEqual({ remind: false });
  });

  it("stays silent when nothing is waiting on a human", () => {
    expect(evaluateWatchdog(input({ waiting: waiting() }))).toEqual({ remind: false });
  });

  it("stays silent during active conversation or workflow activity", () => {
    expect(evaluateWatchdog(input({
      lastActivityAt: new Date("2026-07-31T11:55:00Z"),
    }))).toEqual({ remind: false });
  });

  it("does not repeat the same reminder inside the repeat window", () => {
    const signature = waitingSignature(waiting({ approvals: [approval] }));
    expect(evaluateWatchdog(input({
      lastSignature: signature,
      lastReminderAt: new Date("2026-07-31T11:30:00Z"),
    }))).toEqual({ remind: false });
  });

  it("repeats the reminder once the repeat window has passed", () => {
    const signature = waitingSignature(waiting({ approvals: [approval] }));
    const decision = evaluateWatchdog(input({
      lastSignature: signature,
      lastReminderAt: new Date("2026-07-31T10:30:00Z"),
    }));
    expect(decision.remind).toBe(true);
  });

  it("reminds immediately when the waiting set changes, even inside the repeat window", () => {
    const decision = evaluateWatchdog(input({
      lastSignature: waitingSignature(waiting({ blocked: [{ workItemId: 9, title: "old", cycleCount: 1, stage: null }] })),
      lastReminderAt: new Date("2026-07-31T11:50:00Z"),
    }));
    expect(decision.remind).toBe(true);
  });

  it("describes blocked and stalled items with their next action", () => {
    const decision = evaluateWatchdog(input({
      waiting: waiting({
        blocked: [{ workItemId: 3, title: "old tracker", cycleCount: 1, stage: null }],
        stalled: [{ workItemId: 5, title: "approved tracker", state: "ready_to_build" }],
      }),
    }));
    if (!decision.remind) throw new Error("expected a reminder");
    expect(decision.message).toContain('Work item #3 "old tracker" is blocked after 1 cycle(s)');
    expect(decision.message).toContain('Work item #5 "approved tracker" is approved (ready_to_build) but nothing is running');
  });

  it("flags a harness-stage block as usually a quick fix", () => {
    const decision = evaluateWatchdog(input({
      waiting: waiting({ blocked: [{ workItemId: 3, title: "old tracker", cycleCount: 1, stage: "harness" }] }),
    }));
    if (!decision.remind) throw new Error("expected a reminder");
    expect(decision.message).toContain("harness stage");
  });

  it("reminds sooner for a harness-stage block than the general quiet window allows", () => {
    // 3 minutes of silence: past the 2-minute harness quiet window, still short of the 10-minute general one.
    const decision = evaluateWatchdog(input({
      waiting: waiting({ blocked: [{ workItemId: 3, title: "old tracker", cycleCount: 1, stage: "harness" }] }),
      lastActivityAt: new Date("2026-07-31T11:57:00Z"),
      harnessQuietMs: 2 * MINUTE,
    }));
    expect(decision.remind).toBe(true);
  });

  it("still waits out the general quiet window for a non-harness block", () => {
    const decision = evaluateWatchdog(input({
      waiting: waiting({ blocked: [{ workItemId: 3, title: "old tracker", cycleCount: 1, stage: "tester" }] }),
      lastActivityAt: new Date("2026-07-31T11:57:00Z"),
      harnessQuietMs: 2 * MINUTE,
    }));
    expect(decision).toEqual({ remind: false });
  });
});

describe("watchdog against the workspace database", () => {
  let database: HiveDatabase | undefined;
  afterEach(() => database?.close());

  it("reads waiting state from the database and spaces reminders", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    // The plan_drafted event just wrote "now"; start the clock past the quiet window.
    let now = Date.now() + 15 * MINUTE;
    const reminders: Array<{ message: string; approvals: PendingApproval[] }> = [];
    const watchdog = new Watchdog(database, async (message, approvals) => {
      reminders.push({ message, approvals });
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE }, () => new Date(now));

    await watchdog.tick();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.approvals).toEqual([
      { planId: plan.id, version: 1, workItemId: item.id, title: "v1 tracker" },
    ]);

    // Same waiting set five minutes later: no nag.
    now += 5 * MINUTE;
    await watchdog.tick();
    expect(reminders).toHaveLength(1);

    // Past the repeat window: remind again.
    now += 61 * MINUTE;
    await watchdog.tick();
    expect(reminders).toHaveLength(2);
  });

  it("is not silenced by a leaked running row once it goes stale", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    const now = Date.now() + 15 * MINUTE;
    // A row the process died on: still 'running', last touched two hours ago.
    const staleTouch = new Date(now - 120 * MINUTE).toISOString().slice(0, 19).replace("T", " ");
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status, started_at, last_activity_at)
      VALUES (?, 'developer', 'claude', 'claude-opus-5', 'high', 'running', ?, ?)
    `).run(item.id, staleTouch, staleTouch);
    const reminders: string[] = [];
    const notifier = async (message: string) => { reminders.push(message); };
    const options = { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE };

    // Without the staleness guard the zombie row mutes the watchdog forever.
    await new Watchdog(database, notifier, options, () => new Date(now)).tick();
    expect(reminders).toEqual([]);

    // With it, the leaked row no longer counts as a live agent.
    await new Watchdog(database, notifier, { ...options, staleRunMs: 60 * MINUTE }, () => new Date(now)).tick();
    expect(reminders).toHaveLength(1);
  });

  it("holds every reminder while isEngineBusy reports a live phase", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    let busy = true;
    const now = Date.now() + 15 * MINUTE;
    const reminders: string[] = [];
    const watchdog = new Watchdog(database, async (message) => {
      reminders.push(message);
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE, isEngineBusy: () => busy }, () => new Date(now));

    await watchdog.tick();
    expect(reminders).toEqual([]);

    // The phase ends; the same waiting set may now be reported.
    busy = false;
    await watchdog.tick();
    expect(reminders).toHaveLength(1);
  });

  it("remembers its last reminder across a backend restart", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    let now = Date.now() + 15 * MINUTE;
    const options = { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE };

    const reminders: string[] = [];
    const first = new Watchdog(database, async (message) => { reminders.push(message); }, options, () => new Date(now));
    await first.tick();
    expect(reminders).toHaveLength(1);

    // A restart used to forget the reminder and nag again on the next tick.
    // Fifteen quiet minutes clears the quiet gate, so only the restored
    // repeat clock stands between the restarted instance and a repeat nag.
    now += 15 * MINUTE;
    const restarted = new Watchdog(database, async (message) => { reminders.push(message); }, options, () => new Date(now));
    await restarted.tick();
    expect(reminders).toHaveLength(1);

    // Past the repeat window the restarted instance reminds as normal.
    now += 61 * MINUTE;
    await restarted.tick();
    expect(reminders).toHaveLength(2);
  });

  it("retries a reminder that was never delivered instead of banking it", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    let now = Date.now() + 15 * MINUTE;
    let delivers = false;
    const attempts: string[] = [];
    const watchdog = new Watchdog(database, async (message) => {
      attempts.push(message);
      return delivers;
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE }, () => new Date(now));

    // An undelivered reminder must not start the repeat clock — this is how
    // the studio sat blocked overnight behind a tidy row of "reminded" events.
    await watchdog.tick();
    now += MINUTE;
    await watchdog.tick();
    expect(attempts).toHaveLength(2);
    const undelivered = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'watchdog_reminder_undelivered'")
      .get() as { count: number };
    expect(undelivered.count).toBe(2);

    // Once it lands, the repeat window applies as normal.
    delivers = true;
    now += MINUTE;
    await watchdog.tick();
    expect(attempts).toHaveLength(3);
    now += 5 * MINUTE;
    await watchdog.tick();
    expect(attempts).toHaveLength(3);
  });

  it("treats a notifier that throws as undelivered", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    let now = Date.now() + 15 * MINUTE;
    let attempts = 0;
    const watchdog = new Watchdog(database, async () => {
      attempts += 1;
      throw new Error("discord gateway is down");
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE }, () => new Date(now));

    await watchdog.tick();
    now += MINUTE;
    await watchdog.tick();
    expect(attempts).toBe(2);
  });

  it("stays silent while a run is recorded as running", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (?, 'developer', 'claude', 'claude-opus-5', 'high', 'running')
    `).run(item.id);

    const reminders: string[] = [];
    const watchdog = new Watchdog(database, async (message) => {
      reminders.push(message);
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE }, () => new Date(Date.now() + 15 * MINUTE));

    await watchdog.tick();
    expect(reminders).toHaveLength(0);
  });

  it("is not silenced by a Brain conversation turn", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    // The operator chatting with Brain is a tracked run now, but it is not
    // engine work: the pending approval above must still be chased.
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run();

    const reminders: string[] = [];
    const watchdog = new Watchdog(database, async (message) => {
      reminders.push(message);
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE }, () => new Date(Date.now() + 15 * MINUTE));

    await watchdog.tick();
    expect(reminders).toHaveLength(1);
  });

  it("chases a finished work item until the operator says something, then stops", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Ebb — Offline Period Tracker");
    const item = workflow.createWorkItem(project.id, "M4 release candidate");
    // Finished: nothing waits on the operator, which is exactly why the
    // watchdog used to fall silent and let a completed build go unnoticed.
    database.sqlite.prepare(
      "UPDATE work_items SET state = 'complete', tested_commit = 'd792ce745c873062ab5c4e7311bd86ffacc58bda' WHERE id = ?",
    ).run(item.id);

    let now = Date.now() + 15 * MINUTE;
    const reminders: Array<{ message: string; completedIds: number[] }> = [];
    const watchdog = new Watchdog(database, async (message, _approvals, meta) => {
      reminders.push({ message, completedIds: meta.completedIds });
    }, { tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE, completionReminderLimit: 3 }, () => new Date(now));

    await watchdog.tick();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.message).toContain(`Work item #${item.id} "M4 release candidate" is complete — tested commit d792ce7`);
    expect(reminders[0]?.completedIds).toEqual([item.id]);
    // No open approval, draft, or block: the idle headline has no business here.
    expect(reminders[0]?.message).not.toContain("Hive Mind is idle");

    // Still silent an hour later: say it again.
    now += 61 * MINUTE;
    await watchdog.tick();
    expect(reminders).toHaveLength(2);

    // The operator answers. That is acknowledgement — stop.
    database.sqlite.prepare("INSERT INTO messages (role, source, text) VALUES ('user', 'discord', 'got it')").run();
    now += 61 * MINUTE;
    await watchdog.tick();
    expect(reminders).toHaveLength(2);
  });

  it("gives up on a finished work item after the announcement limit", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Ebb — Offline Period Tracker");
    const item = workflow.createWorkItem(project.id, "M4 release candidate");
    database.sqlite.prepare("UPDATE work_items SET state = 'complete' WHERE id = ?").run(item.id);

    let now = Date.now() + 15 * MINUTE;
    const reminders: string[] = [];
    const watchdog = new Watchdog(database, async (message) => { reminders.push(message); }, {
      tickMs: MINUTE, quietMs: 10 * MINUTE, repeatMs: 60 * MINUTE, completionReminderLimit: 2,
    }, () => new Date(now));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await watchdog.tick();
      now += 61 * MINUTE;
    }
    // An away operator gets told twice, not forever: unlike a blocked item, a
    // complete one costs nothing by waiting.
    expect(reminders).toHaveLength(2);
  });
});
