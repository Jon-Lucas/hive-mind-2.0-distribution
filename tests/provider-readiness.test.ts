import { describe, expect, it } from "vitest";
import { checkSetupStatus } from "../src/setup/provider-readiness.js";
import type { AgentGateway, AgentPreflightRequest, AgentProviderReadiness } from "../src/agents/agent-gateway.js";
import type { WorkflowService } from "../src/workflow/workflow-service.js";

function workflowWith(configByRole: Record<string, { provider: string; model: string }>): WorkflowService {
  return {
    getAgentConfiguration: (role: string) => ({ ...configByRole[role], effort: "high" }),
  } as unknown as WorkflowService;
}

describe("checkSetupStatus", () => {
  it("is ready with no probes when the gateway offers no preflight", async () => {
    const gateway: AgentGateway = { run: async () => ({ text: "" }) };
    const workflow = workflowWith({});

    const status = await checkSetupStatus(workflow, gateway);

    expect(status).toEqual({ ready: true, providers: [] });
  });

  it("probes each distinct provider across the four roles exactly once", async () => {
    const probed: AgentPreflightRequest[] = [];
    const gateway: AgentGateway = {
      run: async () => ({ text: "" }),
      preflight: async (request) => {
        probed.push(request);
        return { ...request, available: true, detail: "ok" };
      },
    };
    // brain/developer/tester on claude, frontend on openai — three roles share one provider.
    const workflow = workflowWith({
      brain: { provider: "claude", model: "claude-opus-5" },
      developer: { provider: "claude", model: "claude-sonnet-5" },
      frontend: { provider: "openai", model: "gpt-5.5" },
      tester: { provider: "claude", model: "claude-sonnet-5" },
    });

    const status = await checkSetupStatus(workflow, gateway);

    expect(probed.map((request) => request.provider).sort()).toEqual(["claude", "openai"]);
    expect(status.ready).toBe(true);
    expect(status.providers).toHaveLength(2);
  });

  it("is not ready when any configured provider is unavailable", async () => {
    const gateway: AgentGateway = {
      run: async () => ({ text: "" }),
      preflight: async (request): Promise<AgentProviderReadiness> => ({
        ...request,
        available: request.provider === "claude",
        detail: request.provider === "claude" ? "logged in" : "Not logged in · Please run /login",
      }),
    };
    const workflow = workflowWith({
      brain: { provider: "claude", model: "claude-opus-5" },
      developer: { provider: "claude", model: "claude-sonnet-5" },
      frontend: { provider: "claude", model: "claude-opus-5" },
      tester: { provider: "openai", model: "gpt-5.5" },
    });

    const status = await checkSetupStatus(workflow, gateway);

    expect(status.ready).toBe(false);
    const openai = status.providers.find((provider) => provider.provider === "openai");
    expect(openai?.available).toBe(false);
    expect(openai?.detail).toContain("Please run /login");
  });
});
