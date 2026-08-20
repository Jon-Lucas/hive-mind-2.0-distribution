import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentService } from "../../agents/agent-service.js";
import { SOUL_ROLES, type SoulRegistry, type SoulRole } from "../../agents/soul-registry.js";
import type { SecondBrainService } from "../../knowledge/second-brain-service.js";
import type { HiveDatabase } from "../../storage/database.js";

const selectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
}).strict();

export interface AgentProfileSources {
  souls?: SoulRegistry;
  secondBrain?: SecondBrainService;
  database?: HiveDatabase;
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  agents: AgentService,
  sources: AgentProfileSources = {},
): Promise<void> {
  app.get("/api/agents", async () => agents.list());

  app.patch("/api/agents/:id/settings", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return agents.updateSettings(id, selectionSchema.parse(request.body));
  });

  // Saves a persona edit and returns the loader's verdict, so the GUI can
  // immediately say whether the agent will actually run on it.
  app.put("/api/agents/:id/soul", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
    const { content } = z.object({ content: z.string().max(100_000) }).strict().parse(request.body);
    if (!sources.souls || !(SOUL_ROLES as string[]).includes(id)) {
      return reply.code(404).send({ error: `no persona file exists for agent: ${id}` });
    }
    return { soul: sources.souls.write(id as SoulRole, content) };
  });

  // Everything the operator can know about one agent: its card, its persona
  // file and the loader's verdict on it, its knowledge notes, and its runs.
  app.get("/api/agents/:id/profile", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
    const agent = agents.list().find((row) => row.id === id);
    if (!agent) return reply.code(404).send({ error: `agent not found: ${id}` });

    const soul = sources.souls && (SOUL_ROLES as string[]).includes(id)
      ? sources.souls.inspect(id as SoulRole)
      : null;
    const memory = sources.secondBrain?.notesByOwner(id) ?? [];

    const sqlite = sources.database?.sqlite;
    const stats = sqlite
      ? sqlite.prepare(`
          SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS totalCostUsd, MAX(started_at) AS lastRunAt
          FROM agent_runs WHERE role = ?
        `).get(id) as { runs: number; totalCostUsd: number; lastRunAt: string | null }
      : { runs: 0, totalCostUsd: 0, lastRunAt: null };
    const recentRuns = sqlite
      ? sqlite.prepare(`
          SELECT id, work_item_id AS workItemId, status, cost_usd AS costUsd, duration_ms AS durationMs,
                 started_at AS startedAt, finished_at AS finishedAt, error
          FROM agent_runs WHERE role = ? ORDER BY id DESC LIMIT 10
        `).all(id) as Array<Record<string, unknown>>
      : [];

    return { agent, soul, memory, stats, recentRuns };
  });
}
