import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ZodError } from "zod";
import type { HiveDatabase } from "../storage/database.js";
import type { AgentGateway } from "../agents/agent-gateway.js";
import { AgentService } from "../agents/agent-service.js";
import type { SoulRegistry } from "../agents/soul-registry.js";
import { BrainService } from "../conversation/brain-service.js";
import { WorkflowConflictError, WorkflowService } from "../workflow/workflow-service.js";
import { registerAgentRoutes } from "../modules/agents/routes.js";
import { registerProjectRoutes } from "../modules/projects/routes.js";
import { registerDashboardRoutes } from "../modules/dashboard/routes.js";
import { registerConversationRoutes } from "../modules/conversation/routes.js";
import { registerDiscordRoutes } from "../modules/discord/routes.js";
import { registerSetupRoutes } from "../modules/setup/routes.js";
import type { RepairResult } from "../discord/discord-repair.js";
import { RealtimeHub } from "../realtime/realtime-hub.js";
import type { DriverRegistry } from "../tester/driver-registry.js";
import { registerTesterRoutes, type TesterProbeContextResolver } from "../modules/tester/routes.js";
import type { SecondBrainService } from "../knowledge/second-brain-service.js";
import { registerKnowledgeRoutes } from "../modules/knowledge/routes.js";
import { isAllowedHost, isAllowedOrigin } from "./origin-guard.js";

export interface BuildAppOptions {
  database: HiveDatabase;
  frontendRoot: string;
  gateway?: AgentGateway;
  realtime?: RealtimeHub;
  onPlanApproved?: (workItemId: number) => void;
  onWorkItemRetry?: (workItemId: number) => void;
  onWorkItemCancel?: (workItemId: number) => Promise<{ killedRuns: number }>;
  beforePlanApproved?: () => Promise<void>;
  workflow?: WorkflowService;
  drivers?: DriverRegistry;
  testerProbeContext?: TesterProbeContextResolver;
  secondBrain?: SecondBrainService;
  souls?: SoulRegistry;
  /**
   * The runtime's Brain instance, which carries souls and the plan-approval
   * executor. When omitted (tests), a bare one is built from the gateway.
   */
  brain?: BrainService;
  /** Directory for uploaded reference images. Omit to disable attachments. */
  attachmentsRoot?: string;
  /** Host:port values this server answers for. Omit to disable origin/host checks. */
  allowedHosts?: string[];
  /** Live Discord bridge state, so the GUI can say whether alerts will arrive. */
  discordState?: () => { configured: boolean; online: boolean; error: string | null };
  /** One-button recovery for the bridge and the always-on Claude Code session. */
  discordRepair?: () => Promise<RepairResult>;
  /** Where a pasted API key gets written so it survives a restart. Required for /api/setup routes. */
  envPath?: string;
  logger?: boolean;
}

export async function ensureExecutionProvidersReady(workflow: WorkflowService, gateway: AgentGateway): Promise<void> {
  if (!gateway.preflight) return;
  for (const role of ["developer", "frontend", "tester"] as const) {
    const configuration = workflow.getAgentConfiguration(role);
    const readiness = await gateway.preflight({ role, provider: configuration.provider, model: configuration.model });
    if (!readiness.available) throw new WorkflowConflictError(readiness.detail);
  }
}

function recordFailure(error: unknown): void {
  const target = process.env.HIVE_ERROR_LOG;
  if (!target) return;
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `\n=== ${new Date().toISOString()} ===\n${stack}\n`, "utf8");
  } catch {
    // Diagnostics must never take down the request path.
  }
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 30 * 1024 * 1024 });
  const agents = new AgentService(options.database);
  const workflow = options.workflow ?? new WorkflowService(options.database);
  const realtime = options.realtime ?? new RealtimeHub();
  const bootId = crypto.randomUUID();

  // Several endpoints are POSTs with no payload. Browsers routinely attach a
  // JSON content type anyway, and the stock parser treats an empty body as a
  // fatal parse error, so accept it as "no body" instead of failing the request.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new ZodError([{ code: "custom", path: [], message: "Body is not valid JSON" }]));
    }
  });

  // The GUI is fully self-contained: local modules, local fonts, no third-party
  // origins and no inline script. Lock that shape in.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("content-security-policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "));
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

  const allowedHosts = options.allowedHosts;
  if (allowedHosts?.length) {
    app.addHook("onRequest", async (request, reply) => {
      if (!isAllowedHost(request.headers.host, allowedHosts)) {
        return reply.code(421).send({ error: "Unrecognized Host header" });
      }
      if (!isAllowedOrigin(request.headers.origin, allowedHosts)) {
        return reply.code(403).send({ error: "Cross-origin request refused" });
      }
    });
  }

  await app.register(fastifyWebsocket, {
    options: {
      verifyClient: (
        { origin, req }: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } },
        done: (result: boolean, code?: number, message?: string) => void,
      ) => {
        if (!allowedHosts?.length) return done(true);
        const host = req.headers.host;
        if (!isAllowedHost(typeof host === "string" ? host : undefined, allowedHosts)) {
          return done(false, 421, "Unrecognized Host header");
        }
        if (!isAllowedOrigin(origin, allowedHosts)) return done(false, 403, "Cross-origin WebSocket refused");
        done(true);
      },
    },
  });
  app.get("/ws", { websocket: true }, (socket) => {
    const remove = realtime.add(socket);
    socket.send(JSON.stringify({ type: "connected", payload: { bootId }, at: new Date().toISOString() }));
    socket.once("close", remove);
    socket.once("error", remove);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    if (error instanceof WorkflowConflictError) {
      const status = error.message.startsWith("Invalid") ? 400 : 409;
      return reply.code(status).send({ error: error.message });
    }
    // Single-operator local tool: a bare "Internal server error" hides the one
    // fact needed to act. Report the reason and persist the stack for triage.
    app.log.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    recordFailure(error);
    return reply.code(500).send({ error: `Internal server error: ${detail}` });
  });

  await registerAgentRoutes(app, agents, {
    souls: options.souls,
    secondBrain: options.secondBrain,
    database: options.database,
  });
  await registerProjectRoutes(app, workflow, {
    onChanged: (type, payload) => realtime.publish(type, payload),
    beforePlanApproved: options.beforePlanApproved
      ?? (options.gateway ? () => ensureExecutionProvidersReady(workflow, options.gateway!) : undefined),
    onPlanApproved: options.onPlanApproved,
    onWorkItemRetry: options.onWorkItemRetry,
    onWorkItemCancel: options.onWorkItemCancel,
  });
  await registerDashboardRoutes(app, options.database, agents, bootId, options.secondBrain, options.discordState);
  if (options.discordRepair) await registerDiscordRoutes(app, options.discordRepair);
  if (options.gateway && options.envPath) await registerSetupRoutes(app, workflow, options.gateway, options.envPath);
  if (options.secondBrain) {
    await registerKnowledgeRoutes(app, options.secondBrain, {
      onChanged: (type, payload) => realtime.publish(type, payload),
    });
  }
  if (options.drivers) await registerTesterRoutes(app, options.drivers, options.testerProbeContext ?? (() => undefined));
  if (options.brain || options.gateway) {
    const brain = options.brain
      ?? new BrainService(options.database, workflow, options.gateway!, options.secondBrain, options.souls, options.attachmentsRoot);
    await registerConversationRoutes(app, brain, { attachmentsRoot: options.attachmentsRoot });
  }
  // A local dashboard has no bandwidth to save, and stale UI has repeatedly
  // cost real debugging time: serve every static file uncacheable.
  await app.register(fastifyStatic, {
    root: options.frontendRoot,
    cacheControl: false,
    setHeaders: (reply) => {
      void reply.header("cache-control", "no-store");
    },
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  return app;
}
