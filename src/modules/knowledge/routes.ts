import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SecondBrainService } from "../../knowledge/second-brain-service.js";

interface KnowledgeRouteHooks {
  onChanged?: (type: string, payload: unknown) => void;
}

const zoneSchema = z.enum(["Atlas", "Projects", "zcomplete"]);
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  secondBrain: SecondBrainService,
  hooks: KnowledgeRouteHooks = {},
): Promise<void> {
  app.get("/api/knowledge", async () => secondBrain.summary());

  app.get("/api/knowledge/zones/:zone", async (request, reply) => {
    const { zone } = z.object({ zone: zoneSchema }).strict().parse(request.params);
    try {
      return { zone, entries: secondBrain.listEntries(zone) };
    } catch (error) {
      return reply.code(404).send({ error: failure(error) });
    }
  });

  app.get("/api/knowledge/zones/:zone/:slug", async (request, reply) => {
    const { zone, slug } = z.object({ zone: zoneSchema, slug: slugSchema }).strict().parse(request.params);
    try {
      return { zone, slug, notes: secondBrain.listNotes(zone, slug) };
    } catch (error) {
      return reply.code(404).send({ error: failure(error) });
    }
  });

  app.get("/api/knowledge/note", async (request, reply) => {
    const { path: notePath } = z.object({ path: z.string().min(1).max(400) }).strict().parse(request.query);
    try {
      return secondBrain.readNote(notePath);
    } catch (error) {
      return reply.code(404).send({ error: failure(error) });
    }
  });

  app.get("/api/knowledge/inbox", async (request, reply) => {
    const { project } = z.object({ project: slugSchema.optional() }).strict().parse(request.query);
    try {
      return { proposals: secondBrain.listProposals(project) };
    } catch (error) {
      return reply.code(400).send({ error: failure(error) });
    }
  });

  app.post("/api/knowledge/inbox/resolve", async (request, reply) => {
    const { id, resolution } = z.object({
      id: z.string().min(1).max(400),
      resolution: z.enum(["accept", "discard"]),
    }).strict().parse(request.body);
    let resolved: { resolution: string; path?: string };
    try {
      resolved = secondBrain.resolveProposal(id, resolution);
    } catch (error) {
      return reply.code(404).send({ error: failure(error) });
    }
    const summary = secondBrain.summary();
    hooks.onChanged?.("knowledge.proposal-resolved", { id, ...resolved });
    return { ...resolved, pendingProposals: summary.pendingProposals };
  });

  app.post("/api/knowledge/projects/:slug/lifecycle", async (request, reply) => {
    const { slug } = z.object({ slug: slugSchema }).strict().parse(request.params);
    const { zone } = z.object({ zone: zoneSchema }).strict().parse(request.body);
    if (!secondBrain.summary(slug).activeProject) {
      return reply.code(404).send({ error: `Knowledge project not found: ${slug}` });
    }
    secondBrain.moveProject(slug, zone);
    const summary = secondBrain.summary(slug);
    hooks.onChanged?.("knowledge.lifecycle-changed", summary.activeProject);
    return summary;
  });
}
