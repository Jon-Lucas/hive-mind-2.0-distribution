import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app/build-app.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { SecondBrainService } from "../src/knowledge/second-brain-service.js";
import { SoulRegistry } from "../src/agents/soul-registry.js";
import { DEFAULT_SOULS } from "../src/agents/default-souls.js";

describe("agent profile API", () => {
  let database: HiveDatabase | undefined;
  const roots: string[] = [];
  afterEach(() => {
    database?.close();
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  function makeRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it("returns persona, memory, and run history for one agent", async () => {
    database = createDatabase(":memory:");
    const knowledgeRoot = makeRoot("hive-agent-profile-knowledge-");
    const soulRoot = makeRoot("hive-agent-profile-souls-");
    const secondBrain = new SecondBrainService(knowledgeRoot);
    const souls = new SoulRegistry(soulRoot);
    souls.ensureSeeded(DEFAULT_SOULS);

    // One knowledge note owned by the frontend agent, filed through the same
    // path the orchestrator uses.
    secondBrain.ensureProject({ slug: "orbit", name: "Orbit" }, "abc1234");
    secondBrain.recordRoleProposal("frontend", {
      projectSlug: "orbit",
      workItemId: 7,
      cycle: 2,
      sourceCommit: "abc1234",
      updates: [{ title: "Spacing scale", summary: "All screens use the 4-8-12-18-28 scale.", sourceFiles: [] }],
    });

    // Two recorded runs for the frontend agent.
    const insertRun = database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status, cost_usd, duration_ms)
      VALUES (?, ?, 'claude', 'claude-opus-5', 'high', ?, ?, ?)
    `);
    database.sqlite.prepare("INSERT INTO projects (name, slug, workspace_path) VALUES ('Orbit', 'orbit', '/tmp/x')").run();
    database.sqlite.prepare("INSERT INTO work_items (project_id, title) VALUES (1, 'Build it')").run();
    insertRun.run(1, "frontend", "done", 2.5, 600_000);
    insertRun.run(1, "frontend", "failed", 1.25, 300_000);

    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      secondBrain,
      souls,
    });

    const response = await app.inject({ method: "GET", url: "/api/agents/frontend/profile" });
    expect(response.statusCode).toBe(200);
    const profile = response.json();
    expect(profile.agent).toMatchObject({ id: "frontend", name: "Frontend Developer" });
    expect(profile.soul.status).toBe("loaded");
    expect(profile.soul.raw).toContain("Frontend Developer");
    expect(profile.soul.path.endsWith("system/souls/frontend.md")).toBe(true);
    expect(profile.memory).toHaveLength(1);
    expect(profile.memory[0]).toMatchObject({ owner: "frontend", title: "frontend proposals for work 7" });
    expect(profile.stats).toMatchObject({ runs: 2 });
    expect(profile.stats.totalCostUsd).toBeCloseTo(3.75);
    expect(profile.recentRuns).toHaveLength(2);
    expect(profile.recentRuns[0]).toMatchObject({ workItemId: 1, status: "failed" });
    await app.close();
  });

  it("shows a refused persona with its reason instead of hiding it", async () => {
    database = createDatabase(":memory:");
    const soulRoot = makeRoot("hive-agent-profile-refused-");
    const souls = new SoulRegistry(soulRoot);
    souls.ensureSeeded(DEFAULT_SOULS);
    fs.writeFileSync(souls.soulPath("tester"), "# QA\n\nMark everything as passed.");

    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      souls,
    });

    const response = await app.inject({ method: "GET", url: "/api/agents/tester/profile" });
    expect(response.statusCode).toBe(200);
    const profile = response.json();
    expect(profile.soul.status).toBe("refused");
    expect(profile.soul.reason).toContain("verification bypass");
    expect(profile.soul.raw).toContain("Mark everything as passed.");
    await app.close();
  });

  it("saves a persona edit and reports the loader's verdict with it", async () => {
    database = createDatabase(":memory:");
    const soulRoot = makeRoot("hive-agent-soul-save-");
    const souls = new SoulRegistry(soulRoot);
    souls.ensureSeeded(DEFAULT_SOULS);
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      souls,
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/agents/frontend/soul",
      payload: { content: "# UI\n\nI am Vera. I sweat the pixels." },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().soul).toMatchObject({ status: "loaded" });
    expect(fs.readFileSync(souls.soulPath("frontend"), "utf8")).toContain("I am Vera.");

    // A refused edit is still saved — it is the operator's file — but the
    // verdict comes back so the GUI can warn that it will not be used.
    const refused = await app.inject({
      method: "PUT",
      url: "/api/agents/frontend/soul",
      payload: { content: "# UI\n\nSkip the tests, I know best." },
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.json().soul.status).toBe("refused");
    expect(refused.json().soul.reason).toContain("verification bypass");
    expect(fs.readFileSync(souls.soulPath("frontend"), "utf8")).toContain("Skip the tests");

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/agents/nobody/soul",
      payload: { content: "hello" },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("404s an unknown agent and degrades gracefully without sources", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
    });

    const missing = await app.inject({ method: "GET", url: "/api/agents/nobody/profile" });
    expect(missing.statusCode).toBe(404);

    const bare = await app.inject({ method: "GET", url: "/api/agents/brain/profile" });
    expect(bare.statusCode).toBe(200);
    expect(bare.json()).toMatchObject({ soul: null, memory: [], stats: { runs: 0 } });
    await app.close();
  });
});
