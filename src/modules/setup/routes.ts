import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentGateway } from "../../agents/agent-gateway.js";
import { checkSetupStatus } from "../../setup/provider-readiness.js";
import { upsertEnvValue } from "../../setup/env-writer.js";
import type { WorkflowService } from "../../workflow/workflow-service.js";

/** Provider CLIs read their key from these; see AGENT_ENV_ALLOWLIST. */
const API_KEY_ENV_VAR = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

const saveKeySchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().trim().min(1, "API key is required"),
});

/**
 * A fresh install has no model account attached to it yet, so the dashboard
 * gates on this before showing the studio. Saving a key here takes effect
 * immediately (it lands in `process.env` for this process, not just on
 * disk), so the very next "check again" can succeed without a restart.
 */
export async function registerSetupRoutes(
  app: FastifyInstance,
  workflow: WorkflowService,
  gateway: AgentGateway,
  envPath: string,
): Promise<void> {
  app.get("/api/setup/status", async () => checkSetupStatus(workflow, gateway));

  app.post("/api/setup/api-key", async (request) => {
    const { provider, apiKey } = saveKeySchema.parse(request.body);
    const envVar = API_KEY_ENV_VAR[provider];
    upsertEnvValue(envPath, envVar, apiKey);
    process.env[envVar] = apiKey;
    return checkSetupStatus(workflow, gateway);
  });
}
