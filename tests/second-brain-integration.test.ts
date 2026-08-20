import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway, AgentRequest, AgentResponse } from "../src/agents/agent-gateway.js";
import { BrainService } from "../src/conversation/brain-service.js";
import { SecondBrainService } from "../src/knowledge/second-brain-service.js";
import { ManagedWorkspace } from "../src/projects/managed-workspace.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { StudioOrchestrator } from "../src/studio/studio-orchestrator.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

class CapturingGateway implements AgentGateway {
  readonly requests: AgentRequest[] = [];
  constructor(private readonly responses: AgentResponse[]) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    if (request.role === "developer") fs.writeFileSync(path.join(request.cwd!, "app.png"), "working\n");
    if (request.role === "tester") fs.writeFileSync(path.join(request.evidenceDir!, "criterion.png"), "passed\n");
    const response = this.responses.shift();
    if (!response) throw new Error("no fake response available");
    return response;
  }
}

describe("second brain role integration", () => {
  let database: HiveDatabase | undefined;
  const roots: string[] = [];
  afterEach(() => {
    database?.close();
    database = undefined;
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  function root(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "hive-second-brain-integration-"));
    roots.push(value);
    return value;
  }

  it("gives Brain global context and persists its Atlas drafts", async () => {
    database = createDatabase(":memory:");
    const knowledgeRoot = path.join(root(), "knowledge");
    const secondBrain = new SecondBrainService(knowledgeRoot);
    const gateway = new CapturingGateway([{ text: JSON.stringify({
      kind: "message",
      text: "I captured the encryption direction.",
      knowledgeUpdates: [{
        zone: "Atlas",
        title: "Local encryption",
        summary: "Explore per-record keys and cryptographic deletion.",
        sourceFiles: [],
      }],
    }) }]);
    const brain = new BrainService(database, new WorkflowService(database), gateway, secondBrain);

    await brain.send("gui", "Remember that we want cryptographic deletion");

    expect(gateway.requests[0]?.systemPrompt).toContain("SECOND BRAIN CONTEXT");
    expect(gateway.requests[0]?.systemPrompt).toContain("Atlas/INDEX.md");
    const atlasNotes = fs.readdirSync(path.join(knowledgeRoot, "Atlas/local-encryption/notes"));
    expect(atlasNotes).toHaveLength(1);
    expect(fs.readFileSync(path.join(knowledgeRoot, "Atlas/local-encryption/notes", atlasNotes[0]!), "utf8"))
      .toContain("cryptographic deletion");
  });

  it("prioritizes the latest project notebook in Brain context", async () => {
    database = createDatabase(":memory:");
    const knowledgeRoot = path.join(root(), "knowledge");
    const secondBrain = new SecondBrainService(knowledgeRoot);
    const workflow = new WorkflowService(database);
    workflow.createProject("Orbit");
    const gateway = new CapturingGateway([{ text: JSON.stringify({ kind: "message", text: "Ready." }) }]);
    const brain = new BrainService(database, workflow, gateway, secondBrain);

    await brain.send("gui", "What is the current architecture?");

    expect(gateway.requests[0]?.systemPrompt).toContain("Projects/orbit/STATUS.md");
    expect(gateway.requests[0]?.systemPrompt).toContain("Current source commit: not-created");
    expect(gateway.requests[0]?.systemPrompt.length).toBeLessThan(30_000);
  });

  it("attributes Brain project drafts to the active project when the model omits its slug", async () => {
    database = createDatabase(":memory:");
    const knowledgeRoot = path.join(root(), "knowledge");
    const secondBrain = new SecondBrainService(knowledgeRoot);
    const workflow = new WorkflowService(database);
    workflow.createProject("Orbit");
    const gateway = new CapturingGateway([{ text: JSON.stringify({
      kind: "message",
      text: "Captured.",
      knowledgeUpdates: [{
        zone: "Projects",
        title: "Runtime boundary",
        summary: "The runtime owns process supervision.",
        sourceFiles: ["src/runtime/create-runtime.ts"],
      }],
    }) }]);
    const brain = new BrainService(database, workflow, gateway, secondBrain);

    await brain.send("gui", "Record the runtime boundary");

    const decisions = fs.readdirSync(path.join(knowledgeRoot, "Projects/orbit/decisions"));
    expect(decisions).toHaveLength(1);
    const draft = fs.readFileSync(path.join(knowledgeRoot, "Projects/orbit/decisions", decisions[0]!), "utf8");
    expect(draft).toContain('source_commit: "not-created"');
    expect(draft).toContain("runtime owns process supervision");
  });

  it("keeps Brain conversation available when optional knowledge metadata is unsafe", async () => {
    database = createDatabase(":memory:");
    const knowledgeRoot = path.join(root(), "knowledge");
    const secondBrain = new SecondBrainService(knowledgeRoot);
    const workflow = new WorkflowService(database);
    const gateway = new CapturingGateway([{ text: JSON.stringify({
      kind: "message",
      text: "The answer is still available.",
      knowledgeUpdates: [{
        zone: "Atlas",
        title: "Unsafe source",
        summary: "Do not persist this note.",
        sourceFiles: ["../.env"],
      }],
    }) }]);
    const brain = new BrainService(database, workflow, gateway, secondBrain);

    const result = await brain.send("gui", "Answer without retaining unsafe metadata");

    expect(result.message).toBe("The answer is still available.");
    expect(brain.listMessages().at(-1)).toMatchObject({ role: "assistant", text: "The answer is still available." });
    expect(database.sqlite.prepare("SELECT kind, actor FROM events ORDER BY id DESC LIMIT 1").get())
      .toEqual({ kind: "knowledge_update_rejected", actor: "brain" });
    expect(fs.existsSync(path.join(knowledgeRoot, "Atlas/unsafe-source"))).toBe(false);
  });

  it("injects commit-aware project context and captures isolated role proposals", async () => {
    database = createDatabase(":memory:");
    const managedRoot = root();
    const workspace = new ManagedWorkspace(managedRoot);
    const secondBrain = new SecondBrainService(workspace.knowledgePath());
    const workflow = new WorkflowService(database, managedRoot);
    const project = workflow.createProject("Pocket Studio");
    const item = workflow.createWorkItem(project.id, "Build storage");
    const plan = workflow.createPlan(item.id, {
      goal: "Local persistence", assumptions: [], acceptanceCriteria: ["Data persists"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    const gateway = new CapturingGateway([
      { text: JSON.stringify({
        summary: "Implemented persistence.",
        knowledgeUpdates: [{ title: "Storage boundary", summary: "Repository owns persistence.", sourceFiles: ["app.png"] }],
      }) },
      { text: JSON.stringify({ summary: "Polished the interface.", knowledgeUpdates: [] }) },
      { text: JSON.stringify({
        status: "passed",
        criteria: [{ ordinal: 1, status: "passed", evidence: ["criterion.png"] }],
        findings: [],
        knowledgeUpdates: [{ title: "Persistence regression", summary: "Retest relaunch behavior.", sourceFiles: ["app.png"] }],
      }) },
    ]);
    const studio = new StudioOrchestrator(database, workflow, workspace, gateway, () => undefined, 5, undefined, secondBrain);

    await studio.runApprovedWorkItem(item.id);

    const developerRequest = gateway.requests.find((request) => request.role === "developer")!;
    const testerRequest = gateway.requests.find((request) => request.role === "tester")!;
    expect(developerRequest.systemPrompt).toContain("SECOND BRAIN CONTEXT");
    expect(developerRequest.systemPrompt).toContain("Source code, the frozen plan, and exact-commit evidence remain authoritative");
    expect(testerRequest.systemPrompt).toContain(workflow.getProject(project.id).acceptedCommit);
    expect(fs.readFileSync(path.join(managedRoot, "knowledge/_inbox/developer/pocket-studio/work-1-cycle-1.md"), "utf8"))
      .toContain("Storage boundary");
    expect(fs.readFileSync(path.join(managedRoot, "knowledge/_inbox/tester/pocket-studio/work-1-cycle-1.md"), "utf8"))
      .toContain("Persistence regression");
    expect(fs.readFileSync(path.join(managedRoot, "knowledge/Projects/pocket-studio/STATUS.md"), "utf8"))
      .toContain("Workflow complete");
  });

  it("does not block a passing workflow when optional knowledge metadata is unsafe", async () => {
    database = createDatabase(":memory:");
    const managedRoot = root();
    const workspace = new ManagedWorkspace(managedRoot);
    const secondBrain = new SecondBrainService(workspace.knowledgePath());
    const workflow = new WorkflowService(database, managedRoot);
    const project = workflow.createProject("Pocket Studio");
    const item = workflow.createWorkItem(project.id, "Build storage");
    const plan = workflow.createPlan(item.id, {
      goal: "Local persistence", assumptions: [], acceptanceCriteria: ["Data persists"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    const notices: string[] = [];
    const gateway = new CapturingGateway([
      { text: JSON.stringify({
        summary: "Implemented persistence.",
        knowledgeUpdates: [{ title: "Unsafe source", summary: "Ignore this metadata.", sourceFiles: ["../.env"] }],
      }) },
      { text: JSON.stringify({ summary: "Polished the interface.", knowledgeUpdates: [] }) },
      { text: JSON.stringify({
        status: "passed",
        criteria: [{ ordinal: 1, status: "passed", evidence: ["criterion.png"] }],
        findings: [],
        knowledgeUpdates: [],
      }) },
    ]);
    const studio = new StudioOrchestrator(database, workflow, workspace, gateway, (message) => {
      notices.push(message);
    }, 5, undefined, secondBrain);

    await studio.runApprovedWorkItem(item.id);

    expect(workflow.getWorkItem(item.id).state).toBe("complete");
    expect(notices.some((message) => message.includes("knowledge proposal rejected"))).toBe(true);
    expect(fs.existsSync(path.join(managedRoot, "knowledge/_inbox/developer/pocket-studio/work-1-cycle-1.md"))).toBe(false);
  });
});
