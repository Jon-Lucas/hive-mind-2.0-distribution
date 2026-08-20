import type { FastifyInstance } from "fastify";
import type { RepairResult } from "../../discord/discord-repair.js";

/**
 * Repair is a POST because it restarts processes. The dashboard is loopback-only
 * and origin-guarded, which is what keeps a stray page from firing it.
 */
export async function registerDiscordRoutes(
  app: FastifyInstance,
  repair: () => Promise<RepairResult>,
): Promise<void> {
  app.post("/api/discord/repair", async () => repair());
}
