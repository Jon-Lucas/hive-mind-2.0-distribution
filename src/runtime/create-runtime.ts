import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentGateway } from "../agents/agent-gateway.js";
import { ProcessAgentGateway } from "../agents/process-agent-gateway.js";
import { buildApp, ensureExecutionProvidersReady } from "../app/build-app.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { BrainService } from "../conversation/brain-service.js";
import { DiscordBridge } from "../discord/discord-bridge.js";
import { repairDiscord } from "../discord/discord-repair.js";
import { DiscordChannelWatchdog } from "../discord/discord-channel-watchdog.js";
import { createScreenActivityChecker } from "../discord/screen-activity.js";
import { createProcessActivityChecker } from "../discord/process-activity.js";
import { ManagedWorkspace } from "../projects/managed-workspace.js";
import { RealtimeHub } from "../realtime/realtime-hub.js";
import { createDatabase, type HiveDatabase } from "../storage/database.js";
import { StudioOrchestrator } from "../studio/studio-orchestrator.js";
import { WorkflowService } from "../workflow/workflow-service.js";
import { DriverRegistry } from "../tester/driver-registry.js";
import { createDefaultDriverRegistry } from "../tester/default-platform-drivers.js";
import { ProjectRunScheduler } from "./project-run-scheduler.js";
import { createBlockedWorkItemAutoRetry } from "./blocked-work-item-auto-retry.js";
import { Watchdog } from "./watchdog.js";
import { DiskGuard } from "./disk-guard.js";
import { BackupGuard } from "./backup-guard.js";
import { renderNotice } from "../discord/notice.js";
import { SoulRegistry } from "../agents/soul-registry.js";
import { DEFAULT_SOULS } from "../agents/default-souls.js";
import { SecondBrainService } from "../knowledge/second-brain-service.js";
import { allowedHostsFor } from "../app/origin-guard.js";
import { createRunLogWriter, RunOutputRecorder } from "../runs/run-output-recorder.js";
import { StatusReporter } from "../discord/status-reporter.js";
import { CancellationRegistry } from "../studio/cancellation.js";
import { cancelActiveTestCommands, testCommandTimeoutMs } from "../tester/command-probe.js";
import { WorkflowConflictError } from "../workflow/workflow-service.js";

export interface HiveRuntime {
  app: FastifyInstance;
  database: HiveDatabase;
  start(): Promise<string>;
  close(): Promise<void>;
}

interface RuntimeDependencies {
  gateway?: AgentGateway;
  drivers?: DriverRegistry;
}

export async function createRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {},
): Promise<HiveRuntime> {
  // The workspace constructor creates system/database, which createDatabase
  // needs, so it must run first — the resolver closure is safe because it is
  // only ever called after `workflow` below is assigned.
  const workspace = new ManagedWorkspace(config.workspaceRoot, (slug) => workflow.projectWorkspacePath(slug));
  const database = createDatabase(config.databasePath);
  const workflow = new WorkflowService(database, config.workspaceRoot);
  const secondBrain = new SecondBrainService(workspace.knowledgePath());
  const existingProjects = database.sqlite.prepare(`
    SELECT name, slug, accepted_commit AS acceptedCommit FROM projects ORDER BY id
  `).all() as Array<{ name: string; slug: string; acceptedCommit: string | null }>;
  for (const project of existingProjects) {
    let sourceCommit = project.acceptedCommit ?? "not-created";
    if (workspace.projectExists(project.slug)) {
      try {
        sourceCommit = workspace.projectCommit(project.slug);
      } catch (error) {
        console.warn(`[knowledge] could not resolve current commit for ${project.slug}:`, error);
      }
    }
    secondBrain.ensureProject(project, sourceCommit);
  }
  // Run directories left behind by a project that was deleted or repointed:
  // git cannot read them, nothing will ever use them again, and they are the
  // largest thing in the workspace by far.
  try {
    const orphaned = workspace.pruneOrphanedRuns();
    if (orphaned.length > 0) {
      console.warn(`[workspace] removed ${orphaned.length} orphaned run director${orphaned.length === 1 ? "y" : "ies"}: ${orphaned.map((run) => run.workflowId).join(", ")}`);
    }
  } catch (error) {
    console.warn("[workspace] could not sweep orphaned runs:", error);
  }
  const realtime = new RealtimeHub();
  const touchRun = database.sqlite.prepare("UPDATE agent_runs SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'");
  // Deterministic Discord telemetry: a silently edited status line plus alarm
  // pings, all template strings — no model call anywhere in this path. The
  // sink resolves the bridge lazily because the bridge is constructed later.
  const statusReporter = new StatusReporter(database, {
    post: async (text) => discord ? await discord.postStatus(text) : undefined,
    edit: async (handle, text) => discord ? await discord.editStatus(handle, text) : false,
    ping: async (text) => {
      realtime.publish("studio.notification", { message: text });
      await discord?.notify(text);
    },
  }, {
    killAfterMs: config.runBudget.inactivityMs,
    platformKillAfterMs: testCommandTimeoutMs(),
    runCeilingMs: config.runBudget.maxDurationMs,
  });
  const persistRunLog = createRunLogWriter(path.join(config.workspaceRoot, "system", "run-logs"));
  const recorder = new RunOutputRecorder({
    persist: (chunk) => {
      persistRunLog(chunk);
      // Full-fidelity feed for tool-call counters, ahead of the GUI's throttled tail.
      try { statusReporter.ingest(chunk); } catch { /* telemetry must never break recording */ }
    },
    publish: (payload) => realtime.publish("agent.output", payload),
    touch: (runId) => { try { touchRun.run(runId); } catch { /* liveness is best effort */ } },
  });
  const cancellation = new CancellationRegistry();
  const gateway = dependencies.gateway ?? new ProcessAgentGateway(
    undefined,
    (role, state) => {
      recorder.flush();
      realtime.publish("agent.run-state", { role, state });
    },
    undefined,
    (chunk) => recorder.record(chunk),
    config.runBudget.maxDurationMs,
    config.runBudget.inactivityMs,
  );
  const drivers = dependencies.drivers ?? createDefaultDriverRegistry();
  const recordSoulEvent = database.sqlite.prepare("INSERT INTO events (kind, actor, detail_json) VALUES (?, ?, ?)");
  const souls = new SoulRegistry(config.workspaceRoot, (event) => {
    // A persona that was ignored must be visible: silently running without one
    // looks identical to running with one that did nothing.
    console.warn(`[souls] ${event.role} persona ${event.status}${event.reason ? `: ${event.reason}` : ""}`);
    try {
      recordSoulEvent.run("soul_rejected", event.role, JSON.stringify({ status: event.status, reason: event.reason }));
    } catch { /* persona reporting must never block a run */ }
  });
  souls.ensureSeeded(DEFAULT_SOULS);
  const attachmentsRoot = path.join(config.workspaceRoot, "system", "attachments");
  const brain = new BrainService(database, workflow, gateway, secondBrain, souls, attachmentsRoot);
  let discord: DiscordBridge;
  // Which work items the orchestrator is actively driving, by phase. The
  // watchdog needs this because the platform-script phase runs with no
  // agent_runs row: from the database alone a 20-minute emulator suite is
  // indistinguishable from a scheduler that lost the item.
  const activePhases = new Map<number, string>();
  const studio = new StudioOrchestrator(database, workflow, workspace, gateway, async (message) => {
    realtime.publish("studio.notification", { message });
    await discord?.notify(message);
  }, 5, drivers, secondBrain, config.runBudget, souls, (update) => {
    if (update.phase === "idle") activePhases.delete(update.workItemId);
    else activePhases.set(update.workItemId, update.phase);
    statusReporter.phase(update);
    realtime.publish("workflow.phase", update);
  }, cancellation);
  const scheduler = new ProjectRunScheduler(
    (workItemId) => workflow.getWorkItem(workItemId).projectId,
    async (workItemId) => {
      realtime.publish("workflow.started", { workItemId });
      try {
        await studio.runApprovedWorkItem(workItemId);
      } finally {
        realtime.publish("workflow.changed", { workItemId });
        // Terminal states are news: silence is how this studio used to hide being stopped.
        void statusReporter.announceIfIdle().catch(() => undefined);
      }
    },
    (workItemId, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[studio] work item ${workItemId} blocked:`, message);
      // autoRetry is assigned a few lines down; runs only ever fail after
      // startup completes, so the reference is always initialized by then.
      void autoRetry.observeBlocked(workItemId, message);
    },
  );
  const runApproved = (workItemId: number): void => { scheduler.schedule(workItemId); };
  const retryBlocked = (workItemId: number): void => { scheduler.schedule(workItemId, { queueIfActive: true }); };
  const beforePlanApproved = (): Promise<void> => ensureExecutionProvidersReady(workflow, gateway);
  const autoRetry = createBlockedWorkItemAutoRetry({
    database,
    workflow,
    ensureReady: beforePlanApproved,
    schedule: retryBlocked,
    notify: async (message) => {
      realtime.publish("studio.notification", { message });
      await discord?.notify(message);
    },
  });
  const cancelWorkItem = async (workItemId: number): Promise<{ killedRuns: number }> => {
    const item = workflow.getWorkItem(workItemId);
    if (!["ready_to_build", "building", "ready_to_test", "testing", "needs_fix"].includes(item.state)) {
      throw new WorkflowConflictError(`work item is ${item.state}; nothing to cancel`);
    }
    cancellation.request(workItemId);
    // Only kill live processes when they belong to this work item — the
    // registry flag alone stops a merely queued item at its first boundary.
    const running = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running' AND work_item_id = ?")
      .get(workItemId) as { count: number };
    let killedRuns = 0;
    if (running.count > 0 || item.state === "testing") {
      killedRuns = (await gateway.cancelActive?.()) ?? 0;
      killedRuns += cancelActiveTestCommands();
    }
    return { killedRuns };
  };

  discord = new DiscordBridge(config.discord, brain, workflow, runApproved, beforePlanApproved, attachmentsRoot);
  // Typed chat approval takes the same gated path as the Discord button.
  brain.setPlanApprovalExecutor(async (planId) => {
    await beforePlanApproved();
    const approved = workflow.approvePlan(planId);
    runApproved(approved.workItemId);
    return approved;
  });
  const watchdog = new Watchdog(database, async (message, approvals, meta) => {
    realtime.publish("studio.notification", { message });
    // With no Discord configured the GUI is the only surface there is, so the
    // publish above counts as delivery. When it is configured, Discord is
    // where the operator actually is: a failed send means the reminder landed
    // nowhere, and the watchdog should retry rather than bank it.
    if (!discord.state.configured) return true;
    // "Done" also goes to the channel the operator actually talks in. The
    // studio channel is the one they scroll past; #11 finished, was announced
    // there, and still went four hours unnoticed.
    if (meta.completedIds.length > 0 && config.discordChannelWatchdog) {
      void discord.notifyChannel(config.discordChannelWatchdog.channelId, message);
    }
    return await discord.notifyWithApprovals(
      message,
      approvals.map((approval) => ({ planId: approval.planId, version: approval.version })),
    );
  }, {
    ...config.watchdog,
    isEngineBusy: () => activePhases.size > 0,
    // The runner ends any run silent past inactivityMs, so a `running` row
    // twice that quiet is a leaked row, not a run — and must not mute reminders.
    staleRunMs: config.runBudget.inactivityMs * 2,
  });
  const runDiscordRepair = () => repairDiscord({
    reconnect: () => discord.reconnect(),
    state: () => discord.state,
  });
  const channelWatchdog = config.discordChannelWatchdog ? new DiscordChannelWatchdog({
    channelId: config.discordChannelWatchdog.channelId,
    policy: {
      staleMs: config.discordChannelWatchdog.staleMs,
      cooldownMs: config.discordChannelWatchdog.cooldownMs,
      activityGraceMs: config.discordChannelWatchdog.activityGraceMs,
    },
    onRepair: runDiscordRepair,
    onNotify: (message) => { void discord.notify(message); },
    // The studio channel hears about the repair; the watched channel is where
    // the unanswered person is actually sitting.
    onNotifyWatchedChannel: (message) => {
      void discord.notifyChannel(config.discordChannelWatchdog!.channelId, message);
    },
    // Two independent signals, either is enough to withhold repair: the
    // terminal's visible frame (catches interactive redraws) and the
    // process's CPU time (catches silent work — greps, test runs, tool
    // calls — that never touches the screen for minutes at a stretch).
    checkActivity: (() => {
      const screenActive = createScreenActivityChecker({ sessionName: config.discordChannelWatchdog.screenSessionName });
      const processActive = createProcessActivityChecker({ sessionName: config.discordChannelWatchdog.screenSessionName });
      return async () => {
        const [fromScreen, fromProcess] = await Promise.all([screenActive(), processActive()]);
        return fromScreen || fromProcess;
      };
    })(),
  }) : null;
  if (channelWatchdog) {
    discord.onRawMessage((message) => channelWatchdog.observe({
      channelId: message.channelId,
      isBot: message.author.bot,
      createdAtMs: message.createdTimestamp,
      content: message.content,
      authorName: message.author.displayName ?? message.author.username,
    }));
  }
  const requeuedWorkItems = workflow.recoverInterruptedWorkItems();
  for (const workItemId of requeuedWorkItems) runApproved(workItemId);
  const app = await buildApp({
    database,
    frontendRoot: config.frontendRoot,
    gateway,
    realtime,
    onPlanApproved: runApproved,
    onWorkItemRetry: retryBlocked,
    onWorkItemCancel: cancelWorkItem,
    beforePlanApproved,
    workflow,
    drivers,
    secondBrain,
    souls,
    brain,
    attachmentsRoot,
    allowedHosts: allowedHostsFor(config.host, config.port),
    discordState: () => discord.state,
    discordRepair: runDiscordRepair,
    envPath: path.join(config.projectRoot, ".env"),
    testerProbeContext: () => {
      const row = database.sqlite.prepare(`
        SELECT wi.id, wi.developer_commit AS developer_commit, p.slug AS project_slug
        FROM work_items wi JOIN projects p ON p.id = wi.project_id
        ORDER BY (wi.state = 'complete') ASC, wi.id DESC LIMIT 1
      `).get() as { id: number; developer_commit: string | null; project_slug: string } | undefined;
      if (!row?.developer_commit) return undefined;
      const cwd = workspace.testerWorkspacePath(row.id);
      try {
        workspace.verifyTesterCheckout(row.project_slug, row.id, row.developer_commit);
      } catch {
        return undefined;
      }
      return { cwd, commit: row.developer_commit, evidenceDir: workspace.evidencePath(row.id) };
    },
    logger: true,
  });

  let listening = false;
  const diskGuard = new DiskGuard(
    config.workspaceRoot,
    config.diskWarnBytes,
    async (message) => {
      realtime.publish("studio.notification", { message });
      await discord?.notify(renderNotice({ icon: "💾", headline: "Low disk space", body: [message] }));
    },
    config.watchdog.tickMs,
  );
  const backupGuard = new BackupGuard(
    () => (database.sqlite.prepare("SELECT slug, workspace_path AS repositoryPath FROM projects").all() as Array<{ slug: string; repositoryPath: string }>),
    async (message) => {
      realtime.publish("studio.notification", { message });
      await discord?.notify(renderNotice({ icon: "🗃️", headline: "Work is not backed up", body: [message] }));
    },
    config.watchdog.repeatMs,
  );
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        backupGuard.stop();
        diskGuard.stop();
        watchdog.stop();
        autoRetry.stop();
        scheduler.stop();
        statusReporter.stop();
        discord.stop();
        await gateway.shutdown?.();
        if (listening || app.server.listening) await app.close();
        else await app.ready().then(() => app.close());
        await scheduler.drain();
        database.close();
      })();
    }
    return closePromise;
  };
  return {
    app,
    database,
    async start() {
      const address = await app.listen({ host: config.host, port: config.port });
      listening = true;
      discord.start();
      watchdog.start();
      diskGuard.start();
      backupGuard.start();
      statusReporter.start();
      if (channelWatchdog && config.discordChannelWatchdog) {
        const channelWatchdogTimer = setInterval(() => { void channelWatchdog.tick(); }, config.discordChannelWatchdog.tickMs);
        channelWatchdogTimer.unref?.();
      }
      // The Discord channel connects asynchronously after login; give it a
      // moment so the boot announcement actually reaches the channel.
      const bootPing = setTimeout(() => { void statusReporter.announceBoot(requeuedWorkItems).catch(() => undefined); }, 10_000);
      bootPing.unref?.();
      return address;
    },
    close,
  };
}
