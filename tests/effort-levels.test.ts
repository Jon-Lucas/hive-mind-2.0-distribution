/** @vitest-environment happy-dom */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EFFORT_CATALOG, isSupportedSelection } from "../src/agents/model-catalog.js";
import { buildAgentCommand } from "../src/agents/process-agent-gateway.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
// @ts-expect-error browser-native JavaScript module
import { effortsFor, renderEffortOptions } from "../frontend/js/dashboard-renderer.js";
import type { AgentRequest } from "../src/agents/agent-gateway.js";

const base: AgentRequest = {
  role: "developer",
  provider: "claude",
  model: "claude-opus-5",
  effort: "high",
  prompt: "Build it",
  systemPrompt: "Follow the frozen plan",
  conversation: [],
};

describe("effort ceilings differ by provider", () => {
  it("offers max only where the provider has it", () => {
    expect(EFFORT_CATALOG.claude).toContain("max");
    expect(EFFORT_CATALOG.openai).not.toContain("max");
    expect(EFFORT_CATALOG.openai).toContain("xhigh");
  });

  it("validates a selection against the chosen provider's own levels", () => {
    expect(isSupportedSelection("claude", "claude-opus-5", "max")).toBe(true);
    expect(isSupportedSelection("claude", "claude-opus-5", "xhigh")).toBe(true);
    // Codex has no max tier, so offering it would fail at run time.
    expect(isSupportedSelection("openai", "gpt-5.6-sol", "max")).toBe(false);
    expect(isSupportedSelection("openai", "gpt-5.6-sol", "xhigh")).toBe(true);
  });

  it("passes each new level through to the right CLI flag", () => {
    const claudeMax = buildAgentCommand({ ...base, effort: "max" });
    expect(claudeMax.args).toEqual(expect.arrayContaining(["--effort", "max"]));
    const claudeXhigh = buildAgentCommand({ ...base, effort: "xhigh" });
    expect(claudeXhigh.args).toEqual(expect.arrayContaining(["--effort", "xhigh"]));
    const codex = buildAgentCommand({ ...base, provider: "openai", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(codex.args.join(" ")).toContain('model_reasoning_effort="xhigh"');
  });

  it("still honours a row written before the split rather than failing a run", () => {
    expect(buildAgentCommand({ ...base, effort: "maximum" }).args)
      .toEqual(expect.arrayContaining(["--effort", "max"]));
    expect(buildAgentCommand({ ...base, provider: "openai", model: "gpt-5.5", effort: "maximum" }).args.join(" "))
      .toContain('model_reasoning_effort="xhigh"');
  });
});

describe("legacy effort migration", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("settles stored 'maximum' rows onto the level their provider ran", () => {
    // A real file, because the migration only matters across a reopen and an
    // in-memory database starts empty every time.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-effort-migration-"));
    roots.push(root);
    const file = path.join(root, "hive.sqlite");

    let database: HiveDatabase = createDatabase(file);
    database.sqlite.prepare("UPDATE agents SET provider = 'openai', model = 'gpt-5.5', effort = 'maximum' WHERE id = 'brain'").run();
    database.sqlite.prepare("UPDATE agents SET provider = 'claude', model = 'claude-opus-5', effort = 'maximum' WHERE id = 'tester'").run();
    database.close();

    // Reopening runs the migrations, as a backend restart would.
    database = createDatabase(file);
    const rows = database.sqlite.prepare("SELECT id, effort FROM agents WHERE id IN ('brain','tester')").all() as Array<{ id: string; effort: string }>;
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.effort]));
    expect(byId.brain).toBe("xhigh");
    expect(byId.tester).toBe("max");
    database.close();
  });
});

describe("effort dropdown rendering", () => {
  it("labels the new levels in plain words", () => {
    const html = renderEffortOptions(["low", "medium", "high", "xhigh", "max"], "high");
    expect(html).toContain(">Extra high<");
    expect(html).toContain(">Max<");
    expect(html).toContain('value="xhigh"');
    expect(html).toContain('<option value="high" selected>');
  });

  it("falls back to the provider's ceiling when the stored level is not offered", () => {
    // A Claude agent on max, switched to OpenAI: max is gone, so land on xhigh
    // rather than submitting a selection the API would reject.
    const html = renderEffortOptions(["low", "medium", "high", "xhigh"], "max");
    expect(html).toContain('<option value="xhigh" selected>');
    expect(html).not.toContain('value="max"');
  });

  it("accepts both the per-provider catalog and an older flat list", () => {
    const keyed = { openai: ["low", "high", "xhigh"], claude: ["low", "high", "xhigh", "max"] };
    expect(effortsFor(keyed, "claude")).toContain("max");
    expect(effortsFor(keyed, "openai")).not.toContain("max");
    // A frontend served from disk can be newer than the running backend.
    expect(effortsFor(["low", "medium", "high", "maximum"], "claude")).toEqual(["low", "medium", "high", "maximum"]);
    expect(effortsFor(undefined, "claude")).toEqual([]);
  });
});
