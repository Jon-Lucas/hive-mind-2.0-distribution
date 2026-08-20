import type { AgentGateway, AgentProviderReadiness } from "../agents/agent-gateway.js";
import type { WorkflowService } from "../workflow/workflow-service.js";

export interface SetupStatus {
  /** True once every provider actually assigned to a role can run. */
  ready: boolean;
  providers: AgentProviderReadiness[];
}

const ROLES = ["brain", "developer", "frontend", "tester"] as const;

/**
 * Checks whether the model account behind each configured role is usable —
 * the same question `ensureExecutionProvidersReady` asks before a plan is
 * approved, but surfaced up front so a fresh install can say "connect your
 * accounts" instead of failing opaquely on the first real run. Distinct
 * roles sharing one provider (e.g. brain and developer both on Claude) are
 * probed once, not once per role.
 */
export async function checkSetupStatus(workflow: WorkflowService, gateway: AgentGateway): Promise<SetupStatus> {
  if (!gateway.preflight) return { ready: true, providers: [] };
  const byProvider = new Map<string, { role: (typeof ROLES)[number]; provider: string; model: string }>();
  for (const role of ROLES) {
    const configuration = workflow.getAgentConfiguration(role);
    if (!byProvider.has(configuration.provider)) byProvider.set(configuration.provider, { role, ...configuration });
  }
  const providers = await Promise.all([...byProvider.values()].map((request) => gateway.preflight!(request)));
  return { ready: providers.every((provider) => provider.available), providers };
}
