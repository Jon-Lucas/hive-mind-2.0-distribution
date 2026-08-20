import type { AgentOutputChunk } from "../agents/agent-gateway.js";
import type { HiveDatabase } from "../storage/database.js";
import type { PhaseUpdate } from "../studio/studio-orchestrator.js";
import { code, fields, plural, renderNotice } from "./notice.js";

/**
 * Where status output goes. `post`/`edit` maintain the one silent, continuously
 * rewritten status message; `ping` sends a fresh message, which is the only
 * kind that triggers a push notification on the user's devices.
 */
export interface StatusSink {
  post(text: string): Promise<unknown | undefined>;
  edit(handle: unknown, text: string): Promise<boolean>;
  ping(text: string): Promise<void>;
}

export interface StatusReporterOptions {
  /** How often the live status message is rewritten. */
  intervalMs?: number;
  /** Silence threshold that triggers a warning ping. */
  quietWarnMs?: number;
  /** The runner's hard kill threshold, quoted in warnings for context. */
  killAfterMs?: number;
  /**
   * Platform-phase duration that triggers a warning ping. The status line
   * calls the agentless platform phase "normal, not a hang" unconditionally,
   * which is true for the routine 10–30 minutes and dangerously reassuring
   * for a wedged emulator: the per-command kill ceiling defaults to two
   * hours, and nothing else escalates in between.
   */
  platformWarnMs?: number;
  /** The platform command timeout, quoted in the warning for context. */
  platformKillAfterMs?: number;
  /**
   * Elapsed run time that triggers a ping, repeating each further interval.
   * The status line shows elapsed time but only as a silent edit — no push —
   * and with the wall-clock ceiling configured in hours, a chatty agent can
   * legitimately run for hours with the operator none the wiser. Production
   * has single runs of 84–207 minutes and $30–$158; every one of them was
   * silent from start to finish.
   */
  longRunWarnMs?: number;
  /** The runner's wall-clock ceiling, quoted in long-run warnings for context. */
  runCeilingMs?: number;
  /**
   * How many times one command may repeat with no file edit between before
   * the run is flagged as possibly looping. Repetition interleaved with edits
   * is ordinary test-driven work and never counts; it is the edit-free kind —
   * run test, fail, run test — that is the mechanical shape of a stuck agent.
   * Warn-only: nothing is ever stopped.
   */
  loopRepeatThreshold?: number;
  /** Commands with no file edit between them before the run is flagged. */
  loopDroughtThreshold?: number;
}

interface RunCounters {
  commands: number;
  edits: number;
  reads: number;
  other: number;
  partial: string;
  /** When the run last changed a file (wall clock at ingest). */
  lastEditAt?: number;
  /** Per-command run counts since the last file edit; cleared by any edit. */
  sinceEdit: Map<string, number>;
  /** Total commands since the last file edit; cleared by any edit. */
  commandsSinceEdit: number;
}

interface RunningRunRow {
  id: number;
  workItemId: number;
  role: string;
  model: string;
  startedAt: string;
  lastActivityAt: string;
}

/** A glyph per stage, so the live status line is identifiable without reading it. */
const ROLE_ICONS: Record<string, string> = {
  developer: "🔨",
  frontend: "🎨",
  tester: "🧪",
};

/** Key for repetition tracking: whitespace-collapsed, bounded. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 200);
}

function truncateCommand(command: string): string {
  return command.length <= 60 ? command : `${command.slice(0, 60)}…`;
}

/** The most-repeated command since the run's last file edit. */
function worstRepeat(counters: RunCounters): { command: string; count: number } | undefined {
  let worst: { command: string; count: number } | undefined;
  for (const [command, count] of counters.sinceEdit) {
    if (!worst || count > worst.count) worst = { command, count };
  }
  return worst;
}

function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** SQLite CURRENT_TIMESTAMP is UTC without a zone marker. */
function parseUtc(value: string): number {
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Deterministic real-time studio telemetry for Discord. Everything here is
 * template strings over the database and the agent output stream — no model
 * is ever invoked. One status message per work item is silently edited on an
 * interval; separate ping messages fire only for events worth a notification:
 * silence past the warning threshold, recovery, and queue-drained.
 */
export class StatusReporter {
  private readonly intervalMs: number;
  private readonly quietWarnMs: number;
  private readonly killAfterMs: number | undefined;
  private readonly platformWarnMs: number;
  private readonly platformKillAfterMs: number | undefined;
  private readonly longRunWarnMs: number;
  private readonly runCeilingMs: number | undefined;
  private readonly loopRepeatThreshold: number;
  private readonly loopDroughtThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly counters = new Map<number, RunCounters>();
  private readonly runWorkItems = new Map<number, number>();
  private readonly quietWarned = new Set<number>();
  private readonly longRunWarned = new Map<number, number>();
  private readonly loopWarned = new Set<number>();
  private platformWarned = false;
  private statusHandle: unknown | undefined;
  private statusWorkItemId: number | undefined;
  private currentPhase: PhaseUpdate | undefined;
  private phaseStartedAt = 0;

  constructor(
    private readonly database: HiveDatabase,
    private readonly sink: StatusSink,
    options: StatusReporterOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.quietWarnMs = options.quietWarnMs ?? 10 * 60_000;
    this.killAfterMs = options.killAfterMs;
    this.platformWarnMs = options.platformWarnMs ?? 45 * 60_000;
    this.platformKillAfterMs = options.platformKillAfterMs;
    this.longRunWarnMs = options.longRunWarnMs ?? 60 * 60_000;
    this.runCeilingMs = options.runCeilingMs;
    this.loopRepeatThreshold = options.loopRepeatThreshold ?? 12;
    this.loopDroughtThreshold = options.loopDroughtThreshold ?? 80;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Raw agent stdout/stderr chunks — full fidelity, before any GUI throttling. */
  ingest(chunk: AgentOutputChunk): void {
    if (chunk.runId === undefined) return;
    const counters = this.counters.get(chunk.runId)
      ?? { commands: 0, edits: 0, reads: 0, other: 0, partial: "", sinceEdit: new Map<string, number>(), commandsSinceEdit: 0 };
    const carried = counters.partial + chunk.text;
    const segments = carried.split("\n");
    counters.partial = segments.pop() ?? "";
    for (const line of segments) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let event: unknown;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (!event || typeof event !== "object" || (event as { type?: string }).type !== "assistant") continue;
      const content = ((event as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== "tool_use" || typeof part.name !== "string") continue;
        if (part.name === "Bash") {
          counters.commands += 1;
          counters.commandsSinceEdit += 1;
          const rawCommand = (part.input as { command?: unknown } | undefined)?.command;
          if (typeof rawCommand === "string" && rawCommand.trim()) {
            const command = normalizeCommand(rawCommand);
            // Repetition needs hot keys, not a full history: once the map is
            // saturated, new distinct commands are exactly the non-loop case.
            if (counters.sinceEdit.has(command) || counters.sinceEdit.size < 200) {
              counters.sinceEdit.set(command, (counters.sinceEdit.get(command) ?? 0) + 1);
            }
          }
        } else if (part.name === "Edit" || part.name === "Write") {
          counters.edits += 1;
          // Progress. Repetition before a file change is diagnosis, not a
          // loop — both loop signals start over from here.
          counters.lastEditAt = Date.now();
          counters.commandsSinceEdit = 0;
          counters.sinceEdit.clear();
        } else if (part.name === "Read") counters.reads += 1;
        else counters.other += 1;
      }
    }
    this.counters.set(chunk.runId, counters);
  }

  /** Structured stage signals from the orchestrator, including the agentless platform-script phase. */
  phase(update: PhaseUpdate): void {
    this.currentPhase = update.phase === "idle" ? undefined : update;
    this.phaseStartedAt = Date.now();
    this.platformWarned = false;
    if (update.phase === "idle") void this.tick().catch(() => undefined);
  }

  /** Backend startup announcement — makes silent crash/respawn cycles visible. */
  async announceBoot(requeuedWorkItems: number[]): Promise<void> {
    await this.sink.ping(renderNotice({
      icon: "🟢",
      headline: "Hive Mind backend online",
      body: [requeuedWorkItems.length > 0
        ? `Requeued ${plural(requeuedWorkItems.length, "work item")} (#${requeuedWorkItems.join(", #")}).`
        : "No unfinished work found."],
    }));
  }

  /**
   * Queue-drained announcement, fired after a work item reaches a terminal
   * state. Silence is how this studio historically hid being stopped, so the
   * "nothing is running" moment is treated as news, not as nothing.
   */
  async announceIfIdle(): Promise<void> {
    const active = this.database.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM work_items
      WHERE state IN ('ready_to_build', 'building', 'ready_to_test', 'testing', 'needs_fix')
    `).get() as { count: number };
    const running = this.database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running' AND role != 'brain'").get() as { count: number };
    if (active.count > 0 || running.count > 0) return;
    const waiting = this.database.sqlite.prepare(`
      SELECT
        SUM(state = 'awaiting_plan_approval') AS approvals,
        SUM(state = 'blocked') AS blocked
      FROM work_items
    `).get() as { approvals: number | null; blocked: number | null };
    await this.sink.ping(renderNotice({
      icon: "🏁",
      headline: "All jobs finished",
      body: ["The studio is idle."],
      meta: [
        waiting.approvals ? `${plural(waiting.approvals, "plan")} awaiting your approval` : null,
        waiting.blocked ? `${plural(waiting.blocked, "blocked item")} awaiting retry` : null,
      ],
    }));
  }

  /** One pass of the live status line; exposed for tests and called on the interval. */
  async tick(now = Date.now()): Promise<void> {
    // Brain conversation turns are tracked runs too, but they have no work
    // item — the status line describes studio execution only.
    const run = this.database.sqlite.prepare(`
      SELECT id, work_item_id AS workItemId, role, model, started_at AS startedAt, last_activity_at AS lastActivityAt
      FROM agent_runs WHERE status = 'running' AND role != 'brain' ORDER BY id DESC LIMIT 1
    `).get() as RunningRunRow | undefined;

    if (run) {
      this.runWorkItems.set(run.id, run.workItemId);
      await this.checkQuiet(run, now);
      await this.checkLoopSignals(run, now);
      await this.checkLongRun(run, now);
      await this.writeStatus(run.workItemId, this.describeAgentRun(run, now));
      return;
    }
    // No agent process — either the harness platform-script phase, or idle.
    if (this.currentPhase?.phase === "platform") {
      const update = this.currentPhase;
      const elapsed = now - this.phaseStartedAt;
      // Past the typical 10–30 minutes the reassurance flips: keep the status
      // line honest and ping once, or a wedged emulator reads as "normal" for
      // the whole two-hour command timeout.
      const overdue = elapsed >= this.platformWarnMs;
      if (overdue && !this.platformWarned) {
        this.platformWarned = true;
        await this.sink.ping(renderNotice({
          icon: "⚠️",
          headline: `Platform scripts have run ${formatDuration(elapsed)} — longer than typical`,
          body: ["A first emulator boot or a cold build can take this long; a wedged suite looks identical."],
          meta: [this.platformKillAfterMs !== undefined
            ? `a command that never finishes is killed at ${formatDuration(this.platformKillAfterMs)}`
            : null],
        }));
      }
      await this.writeStatus(update.workItemId, renderNotice({
        icon: "⚙️",
        headline: this.headerFor(update.workItemId, update.cycle),
        body: [
          fields(
            `🧰 harness platform scripts (${update.detail ?? "configured targets"})`,
            `${formatDuration(elapsed)} elapsed`,
          ),
          overdue
            ? "This phase has now run longer than a typical suite; a wedged emulator or build looks exactly like this."
            : "No agent process runs during this phase; the emulator/build doing the work is normal, not a hang.",
        ],
      }));
      return;
    }
    // Idle: finalize the status message once, then leave it alone.
    if (this.statusWorkItemId !== undefined) {
      const item = this.database.sqlite.prepare("SELECT state FROM work_items WHERE id = ?").get(this.statusWorkItemId) as { state: string } | undefined;
      await this.writeStatus(this.statusWorkItemId, renderNotice({
        icon: "⚙️",
        headline: this.headerFor(this.statusWorkItemId),
        body: [`Finished — final state: ${code(item?.state ?? "unknown")}.`],
      }));
      this.statusHandle = undefined;
      this.statusWorkItemId = undefined;
      this.counters.clear();
      this.quietWarned.clear();
      this.longRunWarned.clear();
      this.loopWarned.clear();
    }
  }

  /** Headline shared by every status revision: which work, on which project. */
  private headerFor(workItemId: number, cycle?: number): string {
    const row = this.database.sqlite.prepare(`
      SELECT wi.title, wi.cycle_count AS cycleCount, p.name AS projectName
      FROM work_items wi JOIN projects p ON p.id = wi.project_id WHERE wi.id = ?
    `).get(workItemId) as { title: string; cycleCount: number; projectName: string } | undefined;
    if (!row) return `Work item #${workItemId}`;
    return fields(row.projectName, `work item #${workItemId}`, `cycle ${cycle ?? row.cycleCount}`);
  }

  private describeAgentRun(run: RunningRunRow, now: number): string {
    const counters = this.counters.get(run.id);
    const spent = this.database.sqlite
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM agent_runs WHERE work_item_id = ?")
      .get(run.workItemId) as { spent: number };
    const activity = counters
      ? fields(
          plural(counters.commands, "command"),
          plural(counters.edits, "file edit"),
          plural(counters.reads, "read"),
        )
      : "Waiting for first output";
    return renderNotice({
      icon: "⚙️",
      headline: this.headerFor(run.workItemId, this.currentPhase?.cycle),
      body: [
        fields(
          `${ROLE_ICONS[run.role] ?? "•"} ${run.role} (${run.model})`,
          `${formatDuration(now - parseUtc(run.startedAt))} elapsed`,
          `quiet ${formatDuration(now - parseUtc(run.lastActivityAt))}`,
        ),
        activity,
      ],
      meta: [`$${spent.spent.toFixed(2)} spent on this work item (completed runs)`],
    });
  }

  /**
   * Warn-only loop heuristics, both reset by progress. One command repeating
   * with no file edit between runs, or a long edit-free stretch of commands,
   * is the mechanical shape of a stuck agent — the quiet warning cannot see
   * it, because a looping agent is loud. One warning per run; the hourly
   * long-run ping keeps carrying the counters afterwards so the operator can
   * watch the trend.
   */
  private async checkLoopSignals(run: RunningRunRow, now: number): Promise<void> {
    if (this.loopWarned.has(run.id)) return;
    const counters = this.counters.get(run.id);
    if (!counters) return;
    const repeat = worstRepeat(counters);
    const repeating = repeat !== undefined && repeat.count >= this.loopRepeatThreshold;
    if (!repeating && counters.commandsSinceEdit < this.loopDroughtThreshold) return;
    this.loopWarned.add(run.id);
    const sinceEdit = now - (counters.lastEditAt ?? parseUtc(run.startedAt));
    await this.sink.ping(renderNotice({
      icon: "🔁",
      headline: repeating
        ? `${run.role} may be looping — ${code(truncateCommand(repeat.command))} ran ${repeat.count}× with no file edit between`
        : `${run.role} may be looping — ${counters.commandsSinceEdit} commands since the last file edit`,
      body: [
        `No file has changed in ${formatDuration(sinceEdit)}. A hard diagnosis can look like this; so does a stuck retry loop.`,
        "Warn-only: nothing was stopped. Cancel the work item from the GUI if this is a loop.",
      ],
      meta: [
        `${formatDuration(now - parseUtc(run.startedAt))} elapsed`,
        fields(plural(counters.commands, "command"), plural(counters.edits, "file edit")),
      ],
    }));
  }

  /**
   * One ping per elapsed longRunWarnMs of a single run. The quiet warning
   * only catches a silent agent; a chatty one — the shape that actually burns
   * hours and dollars — never trips it, and the elapsed time on the status
   * line is a silent edit that pushes nothing to the operator's devices.
   */
  private async checkLongRun(run: RunningRunRow, now: number): Promise<void> {
    const elapsed = now - parseUtc(run.startedAt);
    const intervals = Math.floor(elapsed / this.longRunWarnMs);
    if (intervals < 1 || intervals <= (this.longRunWarned.get(run.id) ?? 0)) return;
    this.longRunWarned.set(run.id, intervals);
    const spent = this.database.sqlite
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM agent_runs WHERE work_item_id = ?")
      .get(run.workItemId) as { spent: number };
    const counters = this.counters.get(run.id);
    const repeat = counters ? worstRepeat(counters) : undefined;
    await this.sink.ping(renderNotice({
      icon: "🕐",
      headline: `${run.role} has been running ${formatDuration(elapsed)}`,
      body: [
        counters
          ? fields(
              plural(counters.commands, "command"),
              plural(counters.edits, "file edit"),
              `last file edit ${formatDuration(now - (counters.lastEditAt ?? parseUtc(run.startedAt)))} ago`,
            )
          : "No output ingested yet",
        // The counters are what let the operator tell a marathon from a loop.
        repeat !== undefined && repeat.count >= 3
          ? `${code(truncateCommand(repeat.command))} has run ${repeat.count}× since the last edit.`
          : "A large change can legitimately run this long; a looping agent looks identical.",
      ],
      meta: [
        `$${spent.spent.toFixed(2)} spent on this work item (completed runs)`,
        this.runCeilingMs !== undefined
          ? `the wall-clock ceiling ends this run at ${formatDuration(this.runCeilingMs)}`
          : null,
      ],
    }));
  }

  private async checkQuiet(run: RunningRunRow, now: number): Promise<void> {
    const quietFor = now - parseUtc(run.lastActivityAt);
    if (quietFor >= this.quietWarnMs && !this.quietWarned.has(run.id)) {
      this.quietWarned.add(run.id);
      await this.sink.ping(renderNotice({
        icon: "⚠️",
        headline: `${run.role} has produced no output for ${formatDuration(quietFor)}`,
        body: ["A long build or emulator boot looks like this too."],
        meta: [this.killAfterMs !== undefined
          ? `the runner kills a silent agent at ${formatDuration(this.killAfterMs)}`
          : null],
      }));
      return;
    }
    if (quietFor < this.quietWarnMs && this.quietWarned.has(run.id)) {
      this.quietWarned.delete(run.id);
      await this.sink.ping(renderNotice({
        icon: "✅",
        headline: `${run.role} is producing output again`,
      }));
    }
  }

  private async writeStatus(workItemId: number, text: string): Promise<void> {
    if (this.statusHandle !== undefined && this.statusWorkItemId === workItemId) {
      const edited = await this.sink.edit(this.statusHandle, text);
      if (edited) return;
      this.statusHandle = undefined;
    }
    this.statusHandle = await this.sink.post(text);
    this.statusWorkItemId = this.statusHandle === undefined ? undefined : workItemId;
  }
}
