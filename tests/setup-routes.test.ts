import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSetupRoutes } from "../src/modules/setup/routes.js";
import type { AgentGateway, AgentPreflightRequest } from "../src/agents/agent-gateway.js";
import type { WorkflowService } from "../src/workflow/workflow-service.js";

// Mirrors build-app.ts's ZodError -> 400 mapping so this isolated route test
// reflects what the real app actually returns for invalid input.
function fastifyWithZodMapping() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}

function workflowAllClaude(): WorkflowService {
  return {
    getAgentConfiguration: () => ({ provider: "claude", model: "claude-opus-5", effort: "high" }),
  } as unknown as WorkflowService;
}

describe("setup routes", () => {
  let dir: string;
  let envPath: string;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-setup-routes-"));
    envPath = path.join(dir, ".env");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("reports current readiness on GET without touching disk", async () => {
    const gateway: AgentGateway = {
      run: async () => ({ text: "" }),
      preflight: async (request: AgentPreflightRequest) => ({ ...request, available: false, detail: "Not logged in · Please run /login" }),
    };
    const app = Fastify();
    await registerSetupRoutes(app, workflowAllClaude(), gateway, envPath);

    const response = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ready: false });
    expect(fs.existsSync(envPath)).toBe(false);
    await app.close();
  });

  it("saves a pasted API key to .env, applies it live, and returns fresh readiness", async () => {
    let loggedIn = false;
    const gateway: AgentGateway = {
      run: async () => ({ text: "" }),
      preflight: async (request: AgentPreflightRequest) => ({
        ...request,
        available: loggedIn,
        detail: loggedIn ? "logged in" : "Not logged in · Please run /login",
      }),
    };
    const app = Fastify();
    await registerSetupRoutes(app, workflowAllClaude(), gateway, envPath);
    // The saved key is what the gateway will report ready against once it lands.
    loggedIn = true;

    const response = await app.inject({
      method: "POST",
      url: "/api/setup/api-key",
      payload: { provider: "claude", apiKey: "sk-ant-test-123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ready: true });
    expect(fs.readFileSync(envPath, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-test-123");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-123");
    await app.close();
  });

  it("rejects an empty key with a 400 instead of writing it", async () => {
    const gateway: AgentGateway = { run: async () => ({ text: "" }) };
    const app = fastifyWithZodMapping();
    await registerSetupRoutes(app, workflowAllClaude(), gateway, envPath);

    const response = await app.inject({
      method: "POST",
      url: "/api/setup/api-key",
      payload: { provider: "claude", apiKey: "  " },
    });

    expect(response.statusCode).toBe(400);
    expect(fs.existsSync(envPath)).toBe(false);
    await app.close();
  });
});
