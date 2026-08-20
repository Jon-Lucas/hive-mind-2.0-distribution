import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkflowService } from "../../workflow/workflow-service.js";

const planSchema = z.object({
  goal: z.string().min(1),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  testTargets: z.array(z.string().min(1)).min(1),
}).strict();

interface ProjectRouteHooks {
  onChanged?: (type: string, payload: unknown) => void;
  beforePlanApproved?: () => Promise<void>;
  onPlanApproved?: (workItemId: number) => void;
  onWorkItemRetry?: (workItemId: number) => void;
  /** Kill switch: stop the work item's running agents/scripts and block it. */
  onWorkItemCancel?: (workItemId: number) => Promise<{ killedRuns: number }>;
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  workflow: WorkflowService,
  hooks: ProjectRouteHooks = {},
): Promise<void> {
  app.post("/api/projects", async (request, reply) => {
    const { name, repositoryPath } = z.object({
      name: z.string().min(1),
      // Absolute path to an existing git repository the crew should work in,
      // instead of a fresh managed folder.
      repositoryPath: z.string().min(1).optional(),
    }).strict().parse(request.body);
    const project = workflow.createProject(name, repositoryPath);
    hooks.onChanged?.("project.created", project);
    return reply.code(201).send(project);
  });

  app.post("/api/projects/:id/work-items", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const { title } = z.object({ title: z.string().min(1) }).strict().parse(request.body);
    const item = workflow.createWorkItem(id, title);
    hooks.onChanged?.("work-item.created", item);
    return reply.code(201).send(item);
  });

  app.post("/api/work-items/:id/plans", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const plan = workflow.createPlan(id, planSchema.parse(request.body));
    hooks.onChanged?.("plan.drafted", plan);
    return reply.code(201).send(plan);
  });

  app.post("/api/plans/:id/approve", async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    await hooks.beforePlanApproved?.();
    const approved = workflow.approvePlan(id);
    hooks.onChanged?.("plan.approved", approved);
    hooks.onPlanApproved?.(approved.workItemId);
    return approved;
  });

  app.post("/api/work-items/:id/retry", async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    await hooks.beforePlanApproved?.();
    const retried = workflow.retryBlockedWorkItem(id);
    hooks.onChanged?.("workflow.retried", { workItemId: id });
    (hooks.onWorkItemRetry ?? hooks.onPlanApproved)?.(id);
    return retried;
  });

  app.post("/api/work-items/:id/cancel", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    if (!hooks.onWorkItemCancel) return reply.code(501).send({ message: "cancellation is not wired up in this context" });
    const result = await hooks.onWorkItemCancel(id);
    hooks.onChanged?.("workflow.cancelled", { workItemId: id });
    return { requested: true, ...result };
  });
}
