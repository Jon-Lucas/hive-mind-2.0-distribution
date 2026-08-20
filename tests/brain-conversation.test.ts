import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SoulRegistry } from "../src/agents/soul-registry.js";
import { DEFAULT_SOULS } from "../src/agents/default-souls.js";
import { BrainService, CONVERSATION_BUDGET, windowConversation } from "../src/conversation/brain-service.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";
import type { AgentGateway, AgentRequest, AgentResponse } from "../src/agents/agent-gateway.js";

class FakeGateway implements AgentGateway {
  requests: AgentRequest[] = [];
  constructor(private readonly responses: AgentResponse[]) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("no fake response available");
    return response;
  }
}

class RecordingGateway implements AgentGateway {
  lastConversation: Array<{ role: string; text: string }> = [];

  async run(request: AgentRequest): Promise<AgentResponse> {
    this.lastConversation = request.conversation.map((message) => ({ ...message }));
    return { text: JSON.stringify({ kind: "message", text: "ack" }) };
  }
}

describe("shared Brain conversation", () => {
  let database: HiveDatabase | undefined;
  afterEach(() => database?.close());

  it("stores GUI and Discord messages in one ordered conversation", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([
      { text: JSON.stringify({ kind: "message", text: "Let’s define the app." }) },
      { text: JSON.stringify({ kind: "message", text: "I remember our app discussion." }) },
    ]);
    const brain = new BrainService(database, new WorkflowService(database), gateway);

    await brain.send("gui", "I want to build an app");
    await brain.send("discord", "What were we discussing?");

    expect(brain.listMessages().map((message) => [message.source, message.role, message.text])).toEqual([
      ["gui", "user", "I want to build an app"],
      ["gui", "assistant", "Let’s define the app."],
      ["discord", "user", "What were we discussing?"],
      ["discord", "assistant", "I remember our app discussion."],
    ]);
    expect(gateway.requests[1]?.conversation).toHaveLength(3);
  });

  it("turns a structured Brain response into an unapproved plan", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "plan",
      text: "The complete plan is ready for approval.",
      projectName: "Pocket Studio",
      workItemTitle: "Build version one",
      plan: {
        goal: "A tested local application",
        assumptions: ["Fresh managed workspace"],
        acceptanceCriteria: ["The app launches", "The primary workflow succeeds"],
        testTargets: ["web", "ios-simulator", "android-emulator", "electron"],
      },
    }) }]);
    const workflow = new WorkflowService(database);
    const brain = new BrainService(database, workflow, gateway);

    const result = await brain.send("discord", "Use your judgment and draft the plan");

    expect(result.plan).toMatchObject({ version: 1, frozenAt: null });
    expect(workflow.getWorkItem(result.workItem!.id).state).toBe("awaiting_plan_approval");
    expect(brain.listMessages().at(-1)?.text).toBe("The complete plan is ready for approval.");
  });

  it("accepts a plain-text Brain response without treating it as a plan envelope", async () => {
    database = createDatabase(":memory:");
    const brain = new BrainService(
      database,
      new WorkflowService(database),
      new FakeGateway([{ text: "HIVE_BRAIN_HTTP_OK" }]),
    );

    const result = await brain.send("gui", "health check");

    expect(result).toEqual({ message: "HIVE_BRAIN_HTTP_OK" });
    expect(database.sqlite.prepare("SELECT text FROM messages WHERE role = 'assistant'").pluck().get()).toBe("HIVE_BRAIN_HTTP_OK");
  });

  it("unwraps an envelope the model wrapped in a markdown fence", async () => {
    database = createDatabase(":memory:");
    const fenced = "```json\n" + JSON.stringify({ kind: "message", text: "M4 is close.", knowledgeUpdates: [] }) + "\n```";
    const brain = new BrainService(database, new WorkflowService(database), new FakeGateway([{ text: fenced }]));

    await expect(brain.send("gui", "how are we doing")).resolves.toEqual({ message: "M4 is close." });
    expect(database.sqlite.prepare("SELECT text FROM messages WHERE role = 'assistant'").pluck().get()).toBe("M4 is close.");
  });

  it("unwraps an envelope the model surrounded with prose", async () => {
    database = createDatabase(":memory:");
    const noisy = `Here you go:\n${JSON.stringify({ kind: "message", text: "Cycle 3 is still running." })}\nHope that helps.`;
    const brain = new BrainService(database, new WorkflowService(database), new FakeGateway([{ text: noisy }]));

    await expect(brain.send("gui", "status")).resolves.toEqual({ message: "Cycle 3 is still running." });
  });

  it("keeps a JSON object without an envelope kind as ordinary Brain text", async () => {
    database = createDatabase(":memory:");
    const brain = new BrainService(
      database,
      new WorkflowService(database),
      new FakeGateway([{ text: "{\"note\":\"not an envelope\"}" }]),
    );

    await expect(brain.send("gui", "respond plainly")).resolves.toEqual({ message: "{\"note\":\"not an envelope\"}" });
  });

  it("keeps a JSON scalar provider response as ordinary Brain text", async () => {
    database = createDatabase(":memory:");
    const brain = new BrainService(
      database,
      new WorkflowService(database),
      new FakeGateway([{ text: "\"quoted provider text\"" }]),
    );

    await expect(brain.send("gui", "respond plainly")).resolves.toEqual({ message: "\"quoted provider text\"" });
  });

  it("keeps the whole conversation while it fits the replay budget", () => {
    const messages = [
      { role: "user" as const, text: "Build a notes app" },
      { role: "assistant" as const, text: "Understood." },
    ];

    expect(windowConversation(messages)).toEqual(messages);
  });

  it("drops the middle of a long conversation but keeps the original objective and recent turns", () => {
    const messages = [
      { role: "user" as const, text: "ORIGINAL OBJECTIVE" },
      ...Array.from({ length: 40 }, (_, index) => ({ role: "assistant" as const, text: `filler ${index} ${"x".repeat(2_000)}` })),
      { role: "user" as const, text: "MOST RECENT" },
    ];

    const windowed = windowConversation(messages);

    expect(windowed.length).toBeLessThan(messages.length);
    expect(windowed[0]?.text).toBe("ORIGINAL OBJECTIVE");
    expect(windowed.at(-1)?.text).toBe("MOST RECENT");
    expect(windowed.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(CONVERSATION_BUDGET);
  });

  it("replays a bounded conversation no matter how long the session runs", async () => {
    database = createDatabase(":memory:");
    const gateway = new RecordingGateway();
    const brain = new BrainService(database, new WorkflowService(database), gateway);
    for (let turn = 0; turn < 12; turn += 1) {
      await brain.send("gui", `turn ${turn} ${"y".repeat(4_000)}`);
    }

    const replayed = gateway.lastConversation.reduce((sum, message) => sum + message.text.length, 0);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 24 });
    expect(gateway.lastConversation.length).toBeLessThan(24);
    expect(replayed).toBeLessThanOrEqual(CONVERSATION_BUDGET);
  });

  it("tells Brain what the studio is actually doing, since approval never enters the conversation", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1 tracker");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship v1", assumptions: [], acceptanceCriteria: ["It launches"],
      testTargets: ["ios-simulator", "android-emulator"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (?, 'developer', 'claude', 'claude-opus-5', 'high', 'running')
    `).run(item.id);
    const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
    const brain = new BrainService(database, workflow, gateway);

    await brain.send("gui", "has the build started?");

    const prompt = gateway.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("# STUDIO STATE");
    expect(prompt).toContain(`Work item #${item.id} "v1 tracker" [Local Period Tracker]: building (cycle 1)`);
    expect(prompt).toContain(`Running now: developer (claude-opus-5) on work item #${item.id}`);
    expect(prompt).toContain("ios-simulator, android-emulator");
    expect(prompt).toContain("never infer progress from the conversation");
  });

  it("shows Brain every work item, so a completed item is never hidden behind a blocked one", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");

    const done = workflow.createWorkItem(project.id, "Android v1");
    const donePlan = workflow.createPlan(done.id, {
      goal: "Ship Android v1", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    workflow.approvePlan(donePlan.id);
    workflow.startDeveloper(done.id);
    workflow.finishDeveloper(done.id, "abc123def");
    workflow.startTester(done.id);
    workflow.passTesting(done.id, "abc123def");

    const pending = workflow.createWorkItem(project.id, "iOS v1");
    const pendingPlan = workflow.createPlan(pending.id, {
      goal: "Ship iOS v1", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["ios-simulator"],
    });

    const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
    const brain = new BrainService(database, workflow, gateway);
    await brain.send("gui", "where are we?");

    const prompt = gateway.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain(`Work item #${done.id} "Android v1" [Local Period Tracker]: complete after 1 cycle(s); tested commit abc123def`);
    expect(prompt).toContain(`Work item #${pending.id} "iOS v1" [Local Period Tracker]: awaiting_plan_approval — plan #${pendingPlan.id} (v1) awaits the user's approval`);
    expect(prompt).toContain("No agent is currently running.");
  });

  it("executes a typed approval through the runtime's approval path", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "Android v1");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"],
    });
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "approve_plan", planId: plan.id, text: "Approving plan #1 as requested.",
    }) }]);
    const brain = new BrainService(database, workflow, gateway);
    const started: number[] = [];
    brain.setPlanApprovalExecutor(async (planId) => {
      const approved = workflow.approvePlan(planId);
      started.push(approved.workItemId);
      return approved;
    });

    const result = await brain.send("discord", "i approve the android work lets do it");

    expect(started).toEqual([item.id]);
    expect(workflow.getWorkItem(item.id).state).toBe("ready_to_build");
    expect(result.approval).toEqual({ planId: plan.id, workItemId: item.id });
    expect(result.message).toContain(`✅ Plan #${plan.id} approved — Developer is starting on work item #${item.id}.`);
    expect(brain.listMessages().at(-1)?.text).toContain("approved — Developer is starting");
  });

  it("reports a failed approval in the reply instead of silently doing nothing", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "approve_plan", planId: 999, text: "Approving.",
    }) }]);
    const brain = new BrainService(database, workflow, gateway);
    brain.setPlanApprovalExecutor(async (planId) => workflow.approvePlan(planId));

    const result = await brain.send("discord", "approve it");

    expect(result.approval).toBeUndefined();
    expect(result.message).toContain("⚠️ Plan #999 was not approved: plan not found");
  });

  it("reports approval as unavailable when no executor is wired", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "approve_plan", planId: 1, text: "Approving.",
    }) }]);
    const brain = new BrainService(database, new WorkflowService(database, "/tmp/hive-test-workspace"), gateway);

    const result = await brain.send("gui", "approve the plan");

    expect(result.message).toContain("was not approved: plan approval is not wired up");
  });

  it("states plainly when nothing is running rather than leaving Brain to guess", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
    const brain = new BrainService(database, new WorkflowService(database, "/tmp/hive-test-workspace"), gateway);

    await brain.send("gui", "anything running?");

    expect(gateway.requests[0]?.systemPrompt).toContain("No work item exists yet");
  });

  it("lets a soul replace Brain's identity while the contract stays authoritative", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-brain-souls-"));
    try {
      const souls = new SoulRegistry(root);
      souls.ensureSeeded(DEFAULT_SOULS);
      fs.writeFileSync(souls.soulPath("brain"), "# Brain\n\nMy name is Ada. I am terse and dry.");
      database = createDatabase(":memory:");
      const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
      const brain = new BrainService(
        database,
        new WorkflowService(database, "/tmp/hive-test-workspace"),
        gateway,
        undefined,
        souls,
      );

      await brain.send("gui", "hello");

      const prompt = gateway.requests[0]?.systemPrompt ?? "";
      expect(prompt).toContain("My name is Ada. I am terse and dry.");
      // The built-in identity must be gone entirely: a second identity claim
      // in the prompt is what made a named persona lose to the role label.
      expect(prompt).not.toContain("You are Brain in Hive Mind 2.0");
      expect(prompt).toContain("# OPERATIONAL CONTRACT");
      expect(prompt.indexOf("My name is Ada.")).toBeLessThan(prompt.indexOf("When discussing, return strict JSON"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells Brain exactly which test targets are accepted", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
    const brain = new BrainService(database, new WorkflowService(database), gateway);

    await brain.send("gui", "hello");

    const prompt = gateway.requests[0]?.systemPrompt ?? "";
    for (const target of ["web", "ios-simulator", "android-emulator", "electron"]) {
      expect(prompt, target).toContain(target);
    }
    expect(prompt).toContain("iPhone");
  });

  it("rejects an unsupported test target without leaving an orphaned project or work item", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "plan", text: "Plan ready.", projectName: "Local Period Tracker",
      workItemTitle: "v1 offline encrypted period tracker",
      plan: { goal: "Build it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["ios", "android"] },
    }) }]);
    const brain = new BrainService(database, new WorkflowService(database, "/tmp/hive-test-workspace"), gateway);

    await expect(brain.send("gui", "build a period tracker")).rejects.toThrow(/unsupported test target: ios/i);

    // The whole planning write rolls back together.
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM plan_versions").get()).toEqual({ count: 0 });
  });

  it("creates the project against an existing repository the plan names", async () => {
    database = createDatabase(":memory:");
    const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-brain-repo-")));
    try {
      fs.mkdirSync(path.join(repository, ".git"));
      const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
      const gateway = new FakeGateway([{ text: JSON.stringify({
        kind: "plan", text: "Plan ready for your existing app.", projectName: "Old App",
        repositoryPath: repository, workItemTitle: "Wire the step service",
        plan: { goal: "Wire it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["android-emulator"] },
      }) }]);
      const brain = new BrainService(database, workflow, gateway);

      const result = await brain.send("discord", "work on my existing app");

      expect(result.plan).toBeDefined();
      expect(workflow.projectWorkspacePath(result.project!.slug)).toBe(repository);
      expect(gateway.requests[0]?.systemPrompt).toContain("repositoryPath");
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  it("answers a bad repository path conversationally without creating anything", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{ text: JSON.stringify({
      kind: "plan", text: "Plan ready.", projectName: "Ghost App",
      repositoryPath: "/nowhere/that/exists", workItemTitle: "v1",
      plan: { goal: "Build it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["web"] },
    }) }]);
    const brain = new BrainService(database, new WorkflowService(database, "/tmp/hive-test-workspace"), gateway);

    const result = await brain.send("discord", "work on my app at /nowhere/that/exists");

    expect(result.plan).toBeUndefined();
    expect(result.message).toContain("not an existing git repository");
    expect(brain.listMessages().at(-1)?.text).toContain("not an existing git repository");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({ count: 0 });
  });

  it("refuses to switch an existing project's repository from chat", async () => {
    database = createDatabase(":memory:");
    const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-brain-switch-")));
    try {
      fs.mkdirSync(path.join(repository, ".git"));
      const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
      workflow.createProject("Pocket Studio");
      const gateway = new FakeGateway([{ text: JSON.stringify({
        kind: "plan", text: "Plan ready.", projectName: "Pocket Studio",
        repositoryPath: repository, workItemTitle: "v2",
        plan: { goal: "Build it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["web"] },
      }) }]);
      const brain = new BrainService(database, workflow, gateway);

      const result = await brain.send("gui", "continue pocket studio from my local checkout");

      expect(result.plan).toBeUndefined();
      expect(result.message).toContain("won't switch an existing project's repository");
      expect(workflow.projectWorkspacePath("pocket-studio")).toBe("/tmp/hive-test-workspace/projects/pocket-studio");
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM plan_versions").get()).toEqual({ count: 0 });
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  it("creates plan version N+1 on the same planning work item", async () => {
    database = createDatabase(":memory:");
    const envelope = (goal: string) => ({ text: JSON.stringify({
      kind: "plan", text: "Revised plan ready.", projectName: "Pocket Studio", workItemTitle: "Build version one",
      plan: { goal, assumptions: [], acceptanceCriteria: ["The app launches"], testTargets: ["web"] },
    }) });
    const workflow = new WorkflowService(database);
    const brain = new BrainService(database, workflow, new FakeGateway([envelope("First draft"), envelope("Revised draft")]));

    const first = await brain.send("gui", "Draft it");
    const second = await brain.send("gui", "Revise the goal");

    expect(second.project?.id).toBe(first.project?.id);
    expect(second.workItem?.id).toBe(first.workItem?.id);
    expect(second.plan?.version).toBe(2);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({ count: 1 });
  });

  it("records each conversation turn as a brain run with its cost", async () => {
    database = createDatabase(":memory:");
    const gateway = new FakeGateway([{
      text: JSON.stringify({ kind: "message", text: "ack" }),
      usage: { costUSD: 0.42, durationMs: 1_234 },
    }]);
    const brain = new BrainService(database, new WorkflowService(database), gateway);

    await brain.send("discord", "how is the build going?");

    const run = database.sqlite.prepare(`
      SELECT id, work_item_id AS workItemId, role, status, cost_usd AS costUsd, duration_ms AS durationMs
      FROM agent_runs
    `).get() as { id: number; workItemId: number | null; role: string; status: string; costUsd: number; durationMs: number };
    expect(run).toMatchObject({ workItemId: null, role: "brain", status: "done", costUsd: 0.42, durationMs: 1_234 });
    expect(gateway.requests[0]?.runId).toBe(run.id);
  });

  it("records a turn the gateway rejected as a failed run", async () => {
    database = createDatabase(":memory:");
    const brain = new BrainService(database, new WorkflowService(database), new FakeGateway([]));

    await expect(brain.send("gui", "hello?")).rejects.toThrow("no fake response available");

    const run = database.sqlite.prepare("SELECT role, status, error FROM agent_runs").get();
    expect(run).toEqual({ role: "brain", status: "failed", error: "no fake response available" });
  });

  it("keeps brain runs out of the studio state it reports on", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    workflow.createWorkItem(project.id, "v1 tracker");
    // A leaked brain row from a crashed turn: without the role filter it
    // would surface as "Running now: brain … on work item #null".
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run();
    const gateway = new FakeGateway([{ text: JSON.stringify({ kind: "message", text: "ok" }) }]);
    const brain = new BrainService(database, workflow, gateway);

    await brain.send("gui", "anything running?");

    expect(gateway.requests[0]?.systemPrompt).toContain("No agent is currently running.");
  });
});
