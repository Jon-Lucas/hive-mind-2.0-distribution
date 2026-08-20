import { describe, expect, it } from "vitest";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { StatusReporter, type StatusSink } from "../src/discord/status-reporter.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

class FakeSink implements StatusSink {
  posts: string[] = [];
  edits: string[] = [];
  pings: string[] = [];
  failEdits = false;

  async post(text: string): Promise<unknown | undefined> {
    this.posts.push(text);
    return { id: this.posts.length };
  }

  async edit(_handle: unknown, text: string): Promise<boolean> {
    if (this.failEdits) return false;
    this.edits.push(text);
    return true;
  }

  async ping(text: string): Promise<void> {
    this.pings.push(text);
  }
}

function seedRunningWorkItem(database: HiveDatabase): { workItemId: number; runId: number } {
  const workflow = new WorkflowService(database);
  const project = workflow.createProject("Status Lab");
  const item = workflow.createWorkItem(project.id, "Watch me");
  const plan = workflow.createPlan(item.id, {
    goal: "Be observable", assumptions: [], acceptanceCriteria: ["It reports"], testTargets: ["web"],
  });
  workflow.approvePlan(plan.id);
  workflow.startDeveloper(item.id);
  const run = database.sqlite.prepare(`
    INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
    VALUES (?, 'developer', 'claude', 'claude-opus-5', 'high', 'running')
  `).run(item.id);
  return { workItemId: item.id, runId: Number(run.lastInsertRowid) };
}

function assistantToolUseLine(name: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } })}\n`;
}

function bashCommandLine(command: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } })}\n`;
}

describe("status reporter", () => {
  it("posts one status message and edits it on later ticks", async () => {
    const database = createDatabase(":memory:");
    const { workItemId, runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    reporter.ingest({ role: "developer", runId, stream: "stdout", text: assistantToolUseLine("Bash") });
    reporter.ingest({ role: "developer", runId, stream: "stdout", text: assistantToolUseLine("Edit") });
    reporter.ingest({ role: "developer", runId, stream: "stdout", text: assistantToolUseLine("Read") });
    await reporter.tick();
    await reporter.tick();

    expect(sink.posts).toHaveLength(1);
    expect(sink.edits).toHaveLength(1);
    expect(sink.posts[0]).toContain(`work item #${workItemId}`);
    expect(sink.posts[0]).toContain("developer (claude-opus-5)");
    expect(sink.posts[0]).toContain("1 command · 1 file edit · 1 read");
    expect(sink.posts[0]).toContain("Status Lab");
    database.close();
  });

  it("ignores a brain conversation run when writing the status line", async () => {
    const database = createDatabase(":memory:");
    // Only a brain turn is in flight — the studio itself is idle, so the
    // status line must not spin up for a conversation.
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run();
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    await reporter.tick();

    expect(sink.posts).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
    database.close();
  });

  it("still announces idle while a brain conversation run is open", async () => {
    const database = createDatabase(":memory:");
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run();
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    await reporter.announceIfIdle();

    expect(sink.pings.filter((ping) => ping.includes("All jobs finished"))).toHaveLength(1);
    database.close();
  });

  it("assembles tool counters from split stream chunks", async () => {
    const database = createDatabase(":memory:");
    const { runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    const line = assistantToolUseLine("Bash");
    reporter.ingest({ role: "developer", runId, stream: "stdout", text: line.slice(0, 25) });
    reporter.ingest({ role: "developer", runId, stream: "stdout", text: line.slice(25) });
    await reporter.tick();

    expect(sink.posts[0]).toContain("1 command");
    database.close();
  });

  it("pings once when a run goes quiet past the threshold and once on recovery", async () => {
    const database = createDatabase(":memory:");
    const { runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, { quietWarnMs: 10 * 60_000, killAfterMs: 30 * 60_000 });

    database.sqlite.prepare("UPDATE agent_runs SET last_activity_at = datetime('now', '-12 minutes') WHERE id = ?").run(runId);
    await reporter.tick();
    await reporter.tick();
    expect(sink.pings.filter((ping) => ping.includes("no output"))).toHaveLength(1);
    expect(sink.pings[0]).toContain("30m");

    database.sqlite.prepare("UPDATE agent_runs SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);
    await reporter.tick();
    expect(sink.pings.filter((ping) => ping.includes("producing output again"))).toHaveLength(1);
    database.close();
  });

  it("pings each hour a chatty run keeps going, with spend and the ceiling for context", async () => {
    const database = createDatabase(":memory:");
    const { workItemId } = seedRunningWorkItem(database);
    database.sqlite.prepare("UPDATE agent_runs SET cost_usd = 12.5, status = 'done' WHERE work_item_id = ?").run(workItemId);
    // The live run under observation, started now.
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (?, 'developer', 'claude', 'claude-opus-5', 'high', 'running')
    `).run(workItemId);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, {
      quietWarnMs: 24 * 60 * 60_000, // quiet warnings out of the way: this run is chatty, not silent
      longRunWarnMs: 60 * 60_000,
      runCeilingMs: 24 * 60 * 60_000,
    });

    // Under an hour: the silently edited status line is enough.
    await reporter.tick(Date.now() + 30 * 60_000);
    expect(sink.pings).toHaveLength(0);

    // Past one hour: one push, carrying spend and the hard ceiling.
    await reporter.tick(Date.now() + 65 * 60_000);
    expect(sink.pings).toHaveLength(1);
    expect(sink.pings[0]).toContain("developer has been running 1h");
    expect(sink.pings[0]).toContain("$12.50");
    expect(sink.pings[0]).toContain("24h 00m");

    // Same hour again: no nag.
    await reporter.tick(Date.now() + 90 * 60_000);
    expect(sink.pings).toHaveLength(1);

    // Second hour: the next push.
    await reporter.tick(Date.now() + 125 * 60_000);
    expect(sink.pings).toHaveLength(2);
    expect(sink.pings[1]).toContain("2h");
    database.close();
  });

  it("flags a run repeating one command with no file edit between, once", async () => {
    const database = createDatabase(":memory:");
    const { runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, { loopRepeatThreshold: 12 });

    for (let i = 0; i < 12; i += 1) {
      reporter.ingest({ role: "developer", runId, stream: "stdout", text: bashCommandLine("npm test") });
    }
    await reporter.tick();

    const loopPings = sink.pings.filter((ping) => ping.includes("may be looping"));
    expect(loopPings).toHaveLength(1);
    expect(loopPings[0]).toContain("npm test");
    expect(loopPings[0]).toContain("ran 12×");
    expect(loopPings[0]).toContain("nothing was stopped");

    // Still looping on the next tick: no second nag for the same run.
    await reporter.tick();
    expect(sink.pings.filter((ping) => ping.includes("may be looping"))).toHaveLength(1);
    database.close();
  });

  it("treats a file edit as progress that resets both loop signals", async () => {
    const database = createDatabase(":memory:");
    const { runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, { loopRepeatThreshold: 12 });

    // Run-test/fix/run-test: the same command repeats, but an edit lands in
    // between — ordinary test-driven work, not a loop.
    for (let i = 0; i < 8; i += 1) {
      reporter.ingest({ role: "developer", runId, stream: "stdout", text: bashCommandLine("npm test") });
    }
    reporter.ingest({ role: "developer", runId, stream: "stdout", text: assistantToolUseLine("Edit") });
    for (let i = 0; i < 8; i += 1) {
      reporter.ingest({ role: "developer", runId, stream: "stdout", text: bashCommandLine("npm test") });
    }
    await reporter.tick();

    expect(sink.pings.filter((ping) => ping.includes("may be looping"))).toHaveLength(0);
    database.close();
  });

  it("flags a long edit-free churn even when no single command repeats", async () => {
    const database = createDatabase(":memory:");
    const { runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, { loopDroughtThreshold: 80 });

    for (let i = 0; i < 80; i += 1) {
      reporter.ingest({ role: "developer", runId, stream: "stdout", text: bashCommandLine(`echo probe-${i}`) });
    }
    await reporter.tick();

    const loopPings = sink.pings.filter((ping) => ping.includes("may be looping"));
    expect(loopPings).toHaveLength(1);
    expect(loopPings[0]).toContain("80 commands since the last file edit");
    database.close();
  });

  it("describes the agentless platform-script phase instead of looking idle", async () => {
    const database = createDatabase(":memory:");
    const { workItemId, runId } = seedRunningWorkItem(database);
    database.sqlite.prepare("UPDATE agent_runs SET status = 'done' WHERE id = ?").run(runId);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    reporter.phase({ workItemId, phase: "platform", cycle: 2, detail: "android-emulator" });
    await reporter.tick();

    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]).toContain("platform scripts (android-emulator)");
    expect(sink.posts[0]).toContain("not a hang");
    database.close();
  });

  it("pings once when the platform phase outlives its typical duration", async () => {
    const database = createDatabase(":memory:");
    const { workItemId, runId } = seedRunningWorkItem(database);
    database.sqlite.prepare("UPDATE agent_runs SET status = 'done' WHERE id = ?").run(runId);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink, { platformWarnMs: 45 * 60_000, platformKillAfterMs: 120 * 60_000 });

    reporter.phase({ workItemId, phase: "platform", cycle: 2, detail: "android-emulator" });
    // Inside the typical window: reassure, don't alarm.
    await reporter.tick(Date.now() + 20 * 60_000);
    expect(sink.pings).toHaveLength(0);

    // Past it: one warning ping, and the status line stops calling it normal.
    await reporter.tick(Date.now() + 50 * 60_000);
    expect(sink.pings).toHaveLength(1);
    expect(sink.pings[0]).toContain("longer than typical");
    expect(sink.pings[0]).toContain("2h 00m");
    expect(sink.edits.at(-1)).not.toContain("not a hang");

    // Still overdue on the next tick: no second ping for the same phase.
    await reporter.tick(Date.now() + 60 * 60_000);
    expect(sink.pings).toHaveLength(1);

    // A new phase re-arms the warning.
    reporter.phase({ workItemId, phase: "platform", cycle: 3, detail: "android-emulator" });
    await reporter.tick(Date.now() + 50 * 60_000);
    expect(sink.pings).toHaveLength(2);
    database.close();
  });

  it("announces the drained queue only when nothing is runnable or running", async () => {
    const database = createDatabase(":memory:");
    const { workItemId, runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    await reporter.announceIfIdle();
    expect(sink.pings).toHaveLength(0);

    database.sqlite.prepare("UPDATE agent_runs SET status = 'done' WHERE id = ?").run(runId);
    database.sqlite.prepare("UPDATE work_items SET state = 'complete' WHERE id = ?").run(workItemId);
    await reporter.announceIfIdle();
    expect(sink.pings).toHaveLength(1);
    expect(sink.pings[0]).toContain("All jobs finished");
    database.close();
  });

  it("reports blocked items as waiting in the idle announcement", async () => {
    const database = createDatabase(":memory:");
    const { workItemId, runId } = seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    database.sqlite.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").run(runId);
    database.sqlite.prepare("UPDATE work_items SET state = 'blocked' WHERE id = ?").run(workItemId);
    await reporter.announceIfIdle();
    expect(sink.pings).toHaveLength(1);
    expect(sink.pings[0]).toContain("1 blocked item");
    database.close();
  });

  it("reposts the status message when an edit fails", async () => {
    const database = createDatabase(":memory:");
    seedRunningWorkItem(database);
    const sink = new FakeSink();
    const reporter = new StatusReporter(database, sink);

    await reporter.tick();
    sink.failEdits = true;
    await reporter.tick();

    expect(sink.posts).toHaveLength(2);
    database.close();
  });
});
