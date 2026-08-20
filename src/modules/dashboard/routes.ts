import type { FastifyInstance } from "fastify";
import type { HiveDatabase } from "../../storage/database.js";
import type { AgentService } from "../../agents/agent-service.js";
import { EFFORT_CATALOG, MODEL_CATALOG } from "../../agents/model-catalog.js";
import type { SecondBrainService } from "../../knowledge/second-brain-service.js";

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  database: HiveDatabase,
  agents: AgentService,
  bootId: string,
  secondBrain?: SecondBrainService,
  discordState?: () => { configured: boolean; online: boolean; error: string | null },
): Promise<void> {
  app.get("/api/bootstrap", async () => {
    const activeWorkItem = database.sqlite.prepare(`
      SELECT wi.id, wi.project_id AS projectId, wi.title, wi.state,
             wi.developer_commit AS developerCommit, wi.tested_commit AS testedCommit,
             wi.cycle_count AS cycleCount, p.name AS projectName, p.slug AS projectSlug
      FROM work_items wi JOIN projects p ON p.id = wi.project_id
      ORDER BY (wi.state = 'complete') ASC, wi.id DESC LIMIT 1
    `).get() as { id: number; projectSlug: string } | undefined;

    let latestPlan: Record<string, unknown> | null = null;
    let findings: unknown[] = [];
    let runs: unknown[] = [];
    if (activeWorkItem) {
      const rawPlan = database.sqlite.prepare(`
        SELECT pv.id, pv.work_item_id AS workItemId, pv.version, pv.goal,
               pv.assumptions_json AS assumptionsJson, pv.test_targets_json AS testTargetsJson,
               pv.reference_images_json AS referenceImagesJson, pv.frozen_at AS frozenAt
        FROM plan_versions pv
        WHERE pv.work_item_id = ? ORDER BY pv.version DESC LIMIT 1
      `).get(activeWorkItem.id) as Record<string, unknown> | undefined;
      if (rawPlan) {
        const criteria = database.sqlite.prepare(`
          SELECT id, ordinal, text, status, evidence_json AS evidenceJson FROM acceptance_criteria WHERE plan_id = ? ORDER BY ordinal
        `).all(rawPlan.id).map((row) => {
          const typed = row as Record<string, unknown>;
          return { id: typed.id, ordinal: typed.ordinal, text: typed.text, status: typed.status, evidence: parseJson(typed.evidenceJson) };
        });
        latestPlan = {
          id: rawPlan.id,
          workItemId: rawPlan.workItemId,
          version: rawPlan.version,
          goal: rawPlan.goal,
          assumptions: parseJson(rawPlan.assumptionsJson),
          testTargets: parseJson(rawPlan.testTargetsJson),
          referenceImages: parseJson(rawPlan.referenceImagesJson) ?? [],
          frozenAt: rawPlan.frozenAt,
          criteria,
        };
      }
      findings = database.sqlite.prepare(`
        SELECT id, severity, kind, target, title, expected, actual, steps_json AS stepsJson,
               evidence_json AS evidenceJson, found_commit AS foundCommit,
               resolved_at AS resolvedAt, resolved_commit AS resolvedCommit, created_at AS createdAt
        FROM findings WHERE work_item_id = ? ORDER BY id DESC
      `).all(activeWorkItem.id).map((row) => {
        const typed = row as Record<string, unknown>;
        return { ...typed, steps: parseJson(typed.stepsJson), evidence: parseJson(typed.evidenceJson), stepsJson: undefined, evidenceJson: undefined };
      });
      runs = database.sqlite.prepare(`
        SELECT id, role, provider, model, effort, status, started_at AS startedAt,
               last_activity_at AS lastActivityAt, finished_at AS finishedAt,
               restart_count AS restartCount, error, cost_usd AS costUsd
        FROM agent_runs WHERE work_item_id = ? ORDER BY id DESC LIMIT 30
      `).all(activeWorkItem.id);
    }

    const projects = database.sqlite.prepare(`
      SELECT id, name, slug, workspace_path AS workspacePath,
             accepted_commit AS acceptedCommit, created_at AS createdAt
      FROM projects ORDER BY id DESC
    `).all();
    const events = database.sqlite.prepare(`
      SELECT id, kind, actor, detail_json AS detailJson, created_at AS createdAt
      FROM events ORDER BY id DESC LIMIT 50
    `).all().map((row) => {
      const typed = row as Record<string, unknown>;
      return { id: typed.id, kind: typed.kind, actor: typed.actor, detail: parseJson(typed.detailJson), createdAt: typed.createdAt };
    });
    const messages = database.sqlite.prepare(`
      SELECT id, role, source, text, attachments_json AS attachmentsJson, created_at AS createdAt
      FROM messages ORDER BY id DESC LIMIT 100
    `).all().reverse().map((row) => {
      const typed = row as Record<string, unknown>;
      let attachments: unknown = [];
      try { attachments = parseJson(typed.attachmentsJson) ?? []; } catch { /* legacy rows */ }
      return { ...typed, attachments, attachmentsJson: undefined };
    });

    return {
      agents: agents.list(),
      projects,
      activeWorkItem: activeWorkItem ?? null,
      latestPlan,
      findings,
      runs,
      messages,
      events,
      catalog: { models: MODEL_CATALOG, efforts: EFFORT_CATALOG },
      secondBrain: secondBrain?.summary(activeWorkItem?.projectSlug) ?? null,
      discord: discordState?.() ?? null,
      health: { status: "online", bootId, heartbeatAt: new Date().toISOString() },
    };
  });

  app.get("/api/health", async () => ({ status: "online", bootId, heartbeatAt: new Date().toISOString() }));
}
