import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app/build-app.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import type { AgentGateway, AgentPreflightRequest, AgentRequest } from "../src/agents/agent-gateway.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";
import { SecondBrainService } from "../src/knowledge/second-brain-service.js";

class ApiGateway implements AgentGateway {
  async run(_request: AgentRequest) {
    return { text: JSON.stringify({ kind: "message", text: "Brain is connected." }) };
  }
}

class UnavailableDeveloperGateway extends ApiGateway {
  async preflight(request: AgentPreflightRequest) {
    return { ...request, available: request.role !== "developer", detail: "Codex login is unavailable" };
  }
}

describe("Hive Mind 2.0 API", () => {
  let database: HiveDatabase | undefined;

  afterEach(() => database?.close());

  it("exposes second-brain status and keeps lifecycle movement explicit", async () => {
    database = createDatabase(":memory:");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-knowledge-api-"));
    const secondBrain = new SecondBrainService(root);
    secondBrain.ensureProject({ slug: "orbit", name: "Orbit" }, "abc1234");
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      secondBrain,
    });

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().secondBrain).toMatchObject({
      zones: { Atlas: 0, Projects: 1, zcomplete: 0 },
      pendingProposals: 0,
    });

    const moved = await app.inject({
      method: "POST",
      url: "/api/knowledge/projects/orbit/lifecycle",
      payload: { zone: "zcomplete" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().activeProject).toEqual({ slug: "orbit", zone: "zcomplete", path: "zcomplete/orbit" });
    expect(fs.existsSync(path.join(root, "zcomplete/orbit"))).toBe(true);
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("browses managed knowledge and resolves role proposals without overwriting canonical pages", async () => {
    database = createDatabase(":memory:");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-knowledge-browse-"));
    const secondBrain = new SecondBrainService(root);
    secondBrain.ensureProject({ slug: "orbit", name: "Orbit" }, "abc1234");
    const proposal = secondBrain.recordRoleProposal("developer", {
      projectSlug: "orbit", workItemId: 4, cycle: 1, sourceCommit: "def5678",
      updates: [{ title: "Sync boundary", summary: "Sync is isolated behind the queue." }],
    })!;
    const app = await buildApp({ database, frontendRoot: new URL("../frontend", import.meta.url).pathname, secondBrain });

    const zone = await app.inject({ method: "GET", url: "/api/knowledge/zones/Projects" });
    expect(zone.statusCode).toBe(200);
    expect(zone.json().entries).toEqual([expect.objectContaining({ slug: "orbit", title: "Orbit", noteCount: 8 })]);

    const notes = await app.inject({ method: "GET", url: "/api/knowledge/zones/Projects/orbit" });
    expect(notes.statusCode).toBe(200);
    expect(notes.json().notes.map((note: { path: string }) => note.path)).toContain("Projects/orbit/STATUS.md");

    const note = await app.inject({ method: "GET", url: "/api/knowledge/note?path=Projects/orbit/STATUS.md" });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ title: "Orbit", sourceCommit: "abc1234" });
    expect(note.json().content).toContain("# Status");

    const escape = await app.inject({ method: "GET", url: "/api/knowledge/note?path=../../../etc/passwd" });
    expect(escape.statusCode).toBe(404);

    const inbox = await app.inject({ method: "GET", url: "/api/knowledge/inbox" });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().proposals).toEqual([expect.objectContaining({
      id: proposal, role: "developer", projectSlug: "orbit", workItemId: 4, cycle: 1,
    })]);

    const refused = await app.inject({
      method: "POST", url: "/api/knowledge/inbox/resolve",
      payload: { id: "Projects/orbit/ARCHITECTURE.md", resolution: "accept" },
    });
    expect(refused.statusCode).toBe(404);

    const accepted = await app.inject({
      method: "POST", url: "/api/knowledge/inbox/resolve",
      payload: { id: proposal, resolution: "accept" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ resolution: "accept", pendingProposals: 0 });
    expect(fs.existsSync(path.join(root, accepted.json().path))).toBe(true);
    expect(fs.existsSync(path.join(root, proposal))).toBe(false);
    expect(fs.readFileSync(path.join(root, "Projects/orbit/ARCHITECTURE.md"), "utf8"))
      .toContain("No verified architecture summary yet");

    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exposes the three agents and drives a plan through approval", async () => {
    database = createDatabase(":memory:");
    const approvedWorkItems: number[] = [];
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      onPlanApproved: (workItemId) => { approvedWorkItems.push(workItemId); },
    });

    const initial = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().agents.map((agent: { id: string }) => agent.id)).toEqual([
      "brain",
      "developer",
      "frontend",
      "tester",
    ]);
    expect(initial.json().health.status).toBe("online");

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/agents/developer/settings",
      payload: { provider: "openai", model: "gpt-5.6-sol", effort: "xhigh" },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      id: "developer",
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });

    const projectResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Pocket Studio" } });
    const project = projectResponse.json();
    expect(projectResponse.statusCode).toBe(201);

    const itemResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/work-items`,
      payload: { title: "Build the first version" },
    });
    const item = itemResponse.json();
    expect(itemResponse.statusCode).toBe(201);

    const planResponse = await app.inject({
      method: "POST",
      url: `/api/work-items/${item.id}/plans`,
      payload: {
        goal: "A tested studio app",
        assumptions: ["Local first"],
        acceptanceCriteria: ["The app launches"],
        testTargets: ["web"],
      },
    });
    const plan = planResponse.json();
    expect(planResponse.statusCode).toBe(201);

    const approval = await app.inject({ method: "POST", url: `/api/plans/${plan.id}/approve` });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().frozenAt).toBeTruthy();
    expect(approvedWorkItems).toEqual([item.id]);

    const refreshed = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(refreshed.json().activeWorkItem).toMatchObject({ id: item.id, state: "ready_to_build" });
    expect(refreshed.json().latestPlan).toMatchObject({
      id: plan.id,
      goal: "A tested studio app",
      assumptions: ["Local first"],
      testTargets: ["web"],
      criteria: [{ ordinal: 1, text: "The app launches", status: "pending" }],
    });
    expect(refreshed.json().projects).toEqual([expect.objectContaining({ name: "Pocket Studio" })]);
    expect(refreshed.json().findings).toEqual([]);
    expect(refreshed.json().runs).toEqual([]);

    await app.close();
  });

  it("connects the GUI to the shared Brain conversation", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      gateway: new ApiGateway(),
    });

    const sent = await app.inject({ method: "POST", url: "/api/brain/messages", payload: { text: "Hello Brain" } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message).toBe("Brain is connected.");

    const thread = await app.inject({ method: "GET", url: "/api/brain/messages" });
    expect(thread.json().map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    await app.close();
  });

  it("rejects unsupported model and effort combinations", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({ database, frontendRoot: new URL("../frontend", import.meta.url).pathname });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/agents/tester/settings",
      payload: { provider: "openai", model: "not-a-real-model", effort: "impossible" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Invalid");
    await app.close();
  });

  it("exposes and accepts exact Claude 5 model assignments", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({ database, frontendRoot: new URL("../frontend", import.meta.url).pathname });

    const initial = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(initial.json().catalog.models.claude).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);

    const developer = await app.inject({
      method: "PATCH",
      url: "/api/agents/developer/settings",
      payload: { provider: "claude", model: "claude-opus-5", effort: "high" },
    });
    const tester = await app.inject({
      method: "PATCH",
      url: "/api/agents/tester/settings",
      payload: { provider: "claude", model: "claude-sonnet-5", effort: "high" },
    });

    expect(developer.statusCode).toBe(200);
    expect(developer.json()).toMatchObject({ provider: "claude", model: "claude-opus-5" });
    expect(tester.statusCode).toBe(200);
    expect(tester.json()).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    await app.close();
  });

  it("retries a blocked approved workflow through the orchestration hook", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Retry API");
    const item = workflow.createWorkItem(project.id, "Retry safely");
    const plan = workflow.createPlan(item.id, {
      goal: "Retry", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.block(item.id, "temporary provider failure");
    const retried: number[] = [];
    const approvalFallback: number[] = [];
    const app = await buildApp({
      database, workflow, frontendRoot: new URL("../frontend", import.meta.url).pathname,
      onPlanApproved: (workItemId) => { approvalFallback.push(workItemId); },
      onWorkItemRetry: (workItemId) => { retried.push(workItemId); },
    });

    const response = await app.inject({ method: "POST", url: `/api/work-items/${item.id}/retry` });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("ready_to_build");
    expect(retried).toEqual([item.id]);
    expect(approvalFallback).toEqual([]);
    await app.close();
  });

  it("does not freeze approval when a selected execution provider is unavailable", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Provider Guard");
    const item = workflow.createWorkItem(project.id, "Build safely");
    const plan = workflow.createPlan(item.id, {
      goal: "A provider-safe build", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    const app = await buildApp({
      database,
      workflow,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      gateway: new UnavailableDeveloperGateway(),
    });

    const response = await app.inject({ method: "POST", url: `/api/plans/${plan.id}/approve` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Codex login is unavailable");
    expect(workflow.getWorkItem(item.id).state).toBe("awaiting_plan_approval");
    await app.close();
  });
});
