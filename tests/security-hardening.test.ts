import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app/build-app.js";
import { allowedHostsFor, isAllowedHost, isAllowedOrigin } from "../src/app/origin-guard.js";
import { sanitizedAgentEnvironment } from "../src/runs/agent-environment.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

const frontendRoot = new URL("../frontend", import.meta.url).pathname;

describe("agent environment isolation", () => {
  it("withholds orchestrator secrets from managed agent processes", () => {
    const env = sanitizedAgentEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/operator",
      ANTHROPIC_API_KEY: "provider-credential",
      DISCORD_BOT_TOKEN: "discord-secret",
      DISCORD_CHANNEL_ID: "123",
      DISCORD_OWNER_ID: "456",
      HIVE_WORKSPACE: "/Users/operator/HiveMindWorkspace",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      SOME_UNRELATED_TOKEN: "other-secret",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/operator");
    expect(env.ANTHROPIC_API_KEY).toBe("provider-credential");
    for (const withheld of [
      "DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_OWNER_ID",
      "HIVE_WORKSPACE", "AWS_SECRET_ACCESS_KEY", "SOME_UNRELATED_TOKEN",
    ]) expect(env[withheld], withheld).toBeUndefined();
  });

  it("omits absent variables rather than defining them as undefined", () => {
    const env = sanitizedAgentEnvironment({ PATH: "/usr/bin" });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });
});

describe("origin guard", () => {
  it("derives loopback hosts for the configured port", () => {
    expect(allowedHostsFor("127.0.0.1", 4401)).toEqual(["127.0.0.1:4401", "localhost:4401"]);
  });

  it("accepts only the configured host and rejects rebound names", () => {
    const allowed = allowedHostsFor("127.0.0.1", 4401);
    expect(isAllowedHost("127.0.0.1:4401", allowed)).toBe(true);
    expect(isAllowedHost("LOCALHOST:4401", allowed)).toBe(true);
    expect(isAllowedHost("attacker.example.com", allowed)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it("permits absent origins but refuses foreign and opaque ones", () => {
    const allowed = allowedHostsFor("127.0.0.1", 4401);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4401", allowed)).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", allowed)).toBe(false);
    expect(isAllowedOrigin("null", allowed)).toBe(false);
    expect(isAllowedOrigin("file://", allowed)).toBe(false);
    expect(isAllowedOrigin("not a url", allowed)).toBe(false);
  });
});

describe("http hardening", () => {
  let database: HiveDatabase | undefined;
  afterEach(() => database?.close());

  it("refuses requests carrying an unrecognized Host or a foreign Origin", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({ database, frontendRoot, allowedHosts: allowedHostsFor("127.0.0.1", 4401) });

    const local = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "127.0.0.1:4401" } });
    expect(local.statusCode).toBe(200);

    const rebound = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "attacker.example.com" } });
    expect(rebound.statusCode).toBe(421);

    const crossOrigin = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1:4401", origin: "https://evil.example.com" },
    });
    expect(crossOrigin.statusCode).toBe(403);

    await app.close();
  });

  it("accepts a bodyless POST that still declares a JSON content type", async () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Orbit");
    const item = workflow.createWorkItem(project.id, "v1");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["web"],
    });
    const app = await buildApp({ database, frontendRoot, workflow });

    // Exactly what the browser sends: JSON content type, no payload.
    const approved = await app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: { "content-type": "application/json" },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json().workItemId).toBe(item.id);
    expect(workflow.getWorkItem(item.id).state).toBe("ready_to_build");
    await app.close();
  });

  it("rejects malformed JSON as a client error rather than a crash", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({ database, frontendRoot });

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("serves a self-contained content security policy", async () => {
    database = createDatabase(":memory:");
    const app = await buildApp({ database, frontendRoot });

    const response = await app.inject({ method: "GET", url: "/api/health" });

    const csp = response.headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });
});
