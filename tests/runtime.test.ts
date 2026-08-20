import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { AgentGateway, AgentRequest } from "../src/agents/agent-gateway.js";
import { runtimeConfigFromEnv } from "../src/config/runtime-config.js";
import { createDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";
import { createRuntime, type HiveRuntime } from "../src/runtime/create-runtime.js";
import { DriverRegistry } from "../src/tester/driver-registry.js";
import type { PlatformDriver, TestTarget } from "../src/tester/platform-driver.js";

// The runtime enforces Host/Origin checks, so requests must look local.
interface LocalInject {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

function injectLocal(runtime: HiveRuntime, options: LocalInject): Promise<LightMyRequestResponse> {
  return runtime.app.inject({
    ...options,
    headers: { host: "127.0.0.1:4401", ...options.headers },
  } as never);
}

class NeverRunGateway implements AgentGateway {
  async run(): Promise<never> { throw new Error("not invoked"); }
}

class ShutdownAwareGateway implements AgentGateway {
  private rejectRun?: (error: Error) => void;
  private signalStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.signalStarted = resolve; });

  async run(request: AgentRequest): Promise<never> {
    if (request.role !== "developer") throw new Error("unexpected role");
    this.signalStarted();
    return new Promise<never>((_resolve, reject) => { this.rejectRun = reject; });
  }

  async shutdown(): Promise<void> {
    this.rejectRun?.(new Error("runtime shutdown"));
  }
}

class DeferredShutdownGateway implements AgentGateway {
  private releaseShutdown!: () => void;
  readonly shutdownGate = new Promise<void>((resolve) => { this.releaseShutdown = resolve; });

  async run(): Promise<never> { throw new Error("not invoked"); }
  async shutdown(): Promise<void> { await this.shutdownGate; }
  release(): void { this.releaseShutdown(); }
}

class EndToEndGateway implements AgentGateway {
  async run(request: AgentRequest) {
    if (request.role === "brain") {
      return { text: JSON.stringify({
        kind: "plan",
        text: "Plan ready.",
        projectName: "Orbit Notes",
        workItemTitle: "Initial release",
        plan: {
          goal: "Create Orbit Notes",
          assumptions: ["Local first"],
          acceptanceCriteria: ["A note can be created"],
          testTargets: ["web"],
        },
      }) };
    }
    if (request.role === "developer") {
      fs.writeFileSync(path.join(request.cwd!, "app.png"), "working\n");
      return { text: "implemented" };
    }
    fs.writeFileSync(path.join(request.evidenceDir!, "criterion-1.png"), "note workflow exercised");
    return { text: JSON.stringify({
      status: "passed",
      criteria: [{ ordinal: 1, status: "passed", evidence: ["criterion-1.png"] }],
      findings: [],
    }) };
  }
}

function passingDrivers(runs: TestTarget[] = []): DriverRegistry {
  const make = (target: TestTarget): PlatformDriver => ({
    target,
    async probe() { return { target, status: "available", checks: [] }; },
    async run(context) {
      runs.push(target);
      fs.writeFileSync(path.join(context.evidenceDir, `${target}.json`), "{}");
      return { target, status: "passed", evidence: [`${target}.json`], detail: "passed" };
    },
  });
  return new DriverRegistry((["web", "ios-simulator", "android-emulator", "electron"] as TestTarget[]).map(make));
}

describe("Hive Mind runtime composition", () => {
  const roots: string[] = [];
  let runtime: HiveRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it("creates durable workspace state and a healthy local app", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);

    runtime = await createRuntime(config, { gateway: new NeverRunGateway() });
    const health = await injectLocal(runtime!, { method: "GET", url: "/api/health" });
    const platforms = await injectLocal(runtime!, { method: "GET", url: "/api/tester/platforms" });

    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("online");
    expect(platforms.statusCode).toBe(200);
    expect(platforms.json().platforms[0].checks[0].detail).toContain("exact Tester checkout");
    expect(fs.existsSync(path.join(workspace, "system", "database", "hive-mind.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "projects"))).toBe(true);
  });

  it("initializes second-brain notebooks for projects created before the feature starts", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-existing-knowledge-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const database = createDatabase(config.databasePath);
    new WorkflowService(database, workspace).createProject("Existing App");
    database.close();

    runtime = await createRuntime(config, { gateway: new NeverRunGateway() });
    const bootstrap = await injectLocal(runtime!, { method: "GET", url: "/api/bootstrap" });

    expect(fs.existsSync(path.join(workspace, "knowledge/Projects/existing-app/INDEX.md"))).toBe(true);
    expect(bootstrap.json().secondBrain.zones.Projects).toBe(1);
  });

  it("does not reuse an older completed checkout for a newer planning item", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-readiness-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const database = createDatabase(config.databasePath);
    const workflow = new WorkflowService(database, workspace);
    const oldProject = workflow.createProject("Old Complete App");
    const oldItem = workflow.createWorkItem(oldProject.id, "Old release");
    database.sqlite.prepare("UPDATE work_items SET state = 'complete', developer_commit = ? WHERE id = ?")
      .run("a".repeat(40), oldItem.id);
    fs.mkdirSync(path.join(workspace, "runs", String(oldItem.id), "tester"), { recursive: true });
    const newProject = workflow.createProject("New Planning App");
    workflow.createWorkItem(newProject.id, "New release");
    database.close();

    runtime = await createRuntime(config, { gateway: new NeverRunGateway(), drivers: passingDrivers() });
    const platforms = await injectLocal(runtime!, { method: "GET", url: "/api/tester/platforms" });

    expect(platforms.statusCode).toBe(200);
    expect(platforms.json().platforms[0].checks[0].detail).toContain("exact Tester checkout");
  });

  it("reports readiness pending when the current Tester path is not the exact Git checkout", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-fake-tester-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const database = createDatabase(config.databasePath);
    const workflow = new WorkflowService(database, workspace);
    const project = workflow.createProject("Fake Tester App");
    const item = workflow.createWorkItem(project.id, "Current release");
    database.sqlite.prepare("UPDATE work_items SET developer_commit = ? WHERE id = ?").run("b".repeat(40), item.id);
    fs.mkdirSync(path.join(workspace, "runs", String(item.id), "tester"), { recursive: true });
    database.close();

    runtime = await createRuntime(config, { gateway: new NeverRunGateway(), drivers: passingDrivers() });
    const platforms = await injectLocal(runtime!, { method: "GET", url: "/api/tester/platforms" });

    expect(platforms.statusCode).toBe(200);
    expect(platforms.json().platforms[0].checks[0].detail).toContain("exact Tester checkout");
  });

  it("makes concurrent close callers await the same shutdown", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-close-once-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    const gateway = new DeferredShutdownGateway();
    runtime = await createRuntime(config, { gateway, drivers: passingDrivers() });

    const first = runtime.close();
    const second = runtime.close();
    const earlyResult = await Promise.race([
      second.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(earlyResult).toBe("pending");

    gateway.release();
    await Promise.all([first, second]);
    runtime = undefined;
  });

  it("cancels and drains an active workflow before closing the database", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-shutdown-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const database = createDatabase(config.databasePath);
    const workflow = new WorkflowService(database, workspace);
    const project = workflow.createProject("Shutdown App");
    const item = workflow.createWorkItem(project.id, "Active release");
    const plan = workflow.createPlan(item.id, {
      goal: "Stop safely", assumptions: [], acceptanceCriteria: ["Shutdown is clean"], testTargets: ["web"],
    });
    database.close();
    const gateway = new ShutdownAwareGateway();
    runtime = await createRuntime(config, { gateway, drivers: passingDrivers() });
    const approval = await injectLocal(runtime!, { method: "POST", url: `/api/plans/${plan.id}/approve` });
    expect(approval.statusCode).toBe(200);
    await gateway.started;

    await runtime.close();
    runtime = undefined;

    const reopened = createDatabase(config.databasePath);
    const persisted = new WorkflowService(reopened, workspace).getWorkItem(item.id);
    const run = reopened.sqlite.prepare("SELECT status, error FROM agent_runs WHERE work_item_id = ? ORDER BY id DESC LIMIT 1")
      .get(item.id) as { status: string; error: string };
    expect(persisted.state).toBe("blocked");
    expect(run).toMatchObject({ status: "failed", error: "runtime shutdown" });
    reopened.close();
  });

  it("resumes an interrupted approved workflow during runtime recovery", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-recovery-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const database = createDatabase(config.databasePath);
    const workflow = new WorkflowService(database, workspace);
    const project = workflow.createProject("Recovered App");
    const item = workflow.createWorkItem(project.id, "Resume me");
    const plan = workflow.createPlan(item.id, {
      goal: "Recover safely",
      assumptions: [],
      acceptanceCriteria: ["Recovery completes"],
      testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    database.close();

    runtime = await createRuntime(config, { gateway: new EndToEndGateway(), drivers: passingDrivers() });
    let snapshot: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      snapshot = (await injectLocal(runtime!, { method: "GET", url: "/api/bootstrap" })).json();
      if (snapshot.activeWorkItem?.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(snapshot.activeWorkItem.state).toBe("complete");
  }, 10_000);

  it("runs an approved API plan through managed Git and promotes the exact passing commit", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-runtime-flow-"));
    roots.push(workspace);
    const projectRoot = new URL("..", import.meta.url).pathname;
    const config = runtimeConfigFromEnv({ HIVE_WORKSPACE: workspace, PORT: "4401" }, projectRoot);
    const driverRuns: TestTarget[] = [];
    runtime = await createRuntime(config, { gateway: new EndToEndGateway(), drivers: passingDrivers(driverRuns) });

    const brain = await injectLocal(runtime!, { method: "POST", url: "/api/brain/messages", payload: { text: "Build Orbit Notes" } });
    expect(brain.statusCode).toBe(200);
    const planId = brain.json().plan.id as number;
    const approval = await injectLocal(runtime!, { method: "POST", url: `/api/plans/${planId}/approve` });
    expect(approval.statusCode).toBe(200);

    let snapshot: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await injectLocal(runtime!, { method: "GET", url: "/api/bootstrap" });
      snapshot = response.json();
      if (snapshot.activeWorkItem?.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const projectPath = path.join(workspace, "projects", "orbit-notes");
    expect(snapshot.activeWorkItem.state).toBe("complete");
    expect(snapshot.activeWorkItem.developerCommit).toBe(snapshot.activeWorkItem.testedCommit);
    expect(snapshot.projects[0].workspacePath).toBe(projectPath);
    expect(snapshot.projects[0].acceptedCommit).toBe(snapshot.activeWorkItem.testedCommit);
    expect(fs.readFileSync(path.join(projectPath, "app.png"), "utf8")).toBe("working\n");
    expect(driverRuns).toEqual(["web"]);
  }, 10_000);
});
