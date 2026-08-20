import { spawnSync } from "node:child_process";
import type { AgentGateway, AgentOutputChunk, AgentPreflightRequest, AgentProviderReadiness, AgentRequest, AgentResponse, AgentUsage } from "./agent-gateway.js";
import { ManagedProcessRunner, type ManagedRunState } from "../runs/managed-process-runner.js";
import { sanitizedAgentEnvironment } from "../runs/agent-environment.js";

interface AgentCommand {
  executable: string;
  args: string[];
  stdin: string;
}

interface ProviderProbeResult { status: number; stdout: string; stderr: string }
type ProviderProbe = (executable: string, args: string[]) => ProviderProbeResult;
const probeProvider: ProviderProbe = (executable, args) => {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000, env: sanitizedAgentEnvironment() });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
};

// Effort reaches a provider command line, so it is mapped to a fixed literal
// rather than interpolated. An unrecognised value fails closed instead of
// flowing into the process arguments.
// "maximum" is the retired single top slot, kept as an alias so a row written
// before the split can never hard-fail a run mid-workflow.
const PROVIDER_EFFORT: Record<string, Record<string, string>> = {
  openai: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", maximum: "xhigh" },
  claude: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", maximum: "max" },
};

function normalizedEffort(provider: string, effort: string): string {
  const mapped = PROVIDER_EFFORT[provider]?.[effort];
  if (!mapped) throw new Error(`unsupported effort for ${provider}: ${effort}`);
  return mapped;
}

function promptFor(request: AgentRequest): string {
  const history = request.conversation
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const currentAlreadyIncluded = request.conversation.at(-1)?.role === "user"
    && request.conversation.at(-1)?.text === request.prompt;
  return [
    "# SYSTEM INSTRUCTIONS",
    request.systemPrompt,
    history ? "# CONVERSATION\n" + history : "",
    currentAlreadyIncluded ? "" : "# CURRENT REQUEST\n" + request.prompt,
  ].filter(Boolean).join("\n\n");
}

/**
 * Developer and Tester are authorized to work without restriction: they run in
 * a disposable managed worktree, and their output is still gated afterwards by
 * exact commit identity, `verifyTesterCheckout`, and evidence containment.
 *
 * Every other role is read-only. Brain is the one that matters: it plans and
 * converses, it never implements, and it runs with no `cwd` of its own — meaning
 * `process.cwd()`, the orchestrator's own checkout. Read-only is enforced per
 * provider rather than by relying on that directory, so Brain cannot modify Hive
 * Mind's source no matter where it is started.
 */
const UNRESTRICTED_ROLES = new Set(["developer", "tester"]);

export function isUnrestrictedRole(role: string): boolean {
  return UNRESTRICTED_ROLES.has(role);
}

export function buildAgentCommand(request: AgentRequest): AgentCommand {
  const stdin = promptFor(request);
  const unrestricted = isUnrestrictedRole(request.role);
  if (request.provider === "claude") {
    return {
      executable: process.env.HIVE_CLAUDE_EXECUTABLE ?? "claude",
      args: [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode", unrestricted ? "bypassPermissions" : "default",
        "--model", request.model,
        "--effort", normalizedEffort("claude", request.effort),
        ...(request.allowedDirectories ?? []).flatMap((directory) => ["--add-dir", directory]),
      ],
      stdin,
    };
  }
  if (request.provider === "openai") {
    return {
      executable: process.env.HIVE_CODEX_EXECUTABLE ?? "codex",
      args: [
        "exec",
        "--sandbox", unrestricted ? "danger-full-access" : "read-only",
        "--json",
        "--model", request.model,
        "-c", `model_reasoning_effort="${normalizedEffort("openai", request.effort)}"`,
        "-",
      ],
      stdin,
    };
  }
  throw new Error(`unsupported provider: ${request.provider}`);
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  });
}

export function parseAgentOutput(provider: string, stdout: string): string {
  try {
    const whole = JSON.parse(stdout) as { result?: unknown };
    if (typeof whole.result === "string") return whole.result;
  } catch { /* streaming JSON is handled below */ }

  const events = parseJsonLines(stdout);
  for (const event of [...events].reverse()) {
    if (!event || typeof event !== "object") continue;
    const row = event as Record<string, unknown>;
    if (typeof row.result === "string") return row.result;
    const item = row.item;
    if (item && typeof item === "object") {
      const typed = item as Record<string, unknown>;
      if (typed.type === "agent_message" && typeof typed.text === "string") return typed.text;
    }
    const message = row.message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const text = content
          .map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text)
            : "")
          .join("");
        if (text) return text;
      }
    }
  }
  throw new Error(`${provider} returned no final agent message`);
}

export class AgentRunError extends Error {
  constructor(message: string, readonly usage?: AgentUsage) {
    super(message);
    this.name = "AgentRunError";
  }
}

/**
 * The raw tail of a provider result is a wall of JSON. Prefer the fields that
 * say why it ended, and fall back to a short excerpt only when they are absent.
 */
function summarizeFailure(detail: string): string {
  const reason = detail.match(/"terminal_reason":\s*"([^"]+)"/)?.[1];
  const subtype = detail.match(/"subtype":\s*"([^"]+)"/)?.[1];
  const errors = detail.match(/"errors":\s*\[([^\]]*)\]/)?.[1]?.trim();
  const named = [subtype, reason].filter(Boolean).join(" / ");
  if (named) return `${named}${errors && errors !== "" ? ` — ${errors.slice(0, 200)}` : ""}`;
  return detail.slice(-400);
}

/**
 * Providers report what a run actually cost in their final result envelope.
 * Hive Mind previously discarded it, so a single run could reach three hours
 * and eighty dollars with nothing recorded until it failed.
 */
export function parseAgentUsage(stdout: string): AgentUsage | undefined {
  const events = parseJsonLines(stdout);
  const usage: AgentUsage = {};
  for (const event of [...events].reverse()) {
    if (!event || typeof event !== "object") continue;
    const row = event as Record<string, unknown>;
    if (typeof row.total_cost_usd === "number") usage.costUSD ??= row.total_cost_usd;
    if (typeof row.costUSD === "number") usage.costUSD ??= row.costUSD;
    if (typeof row.duration_ms === "number") usage.durationMs ??= row.duration_ms;

    const models = row.modelUsage;
    if (models && typeof models === "object") {
      let cost = 0;
      let input = 0;
      let output = 0;
      for (const entry of Object.values(models as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const typed = entry as Record<string, unknown>;
        if (typeof typed.costUSD === "number") cost += typed.costUSD;
        if (typeof typed.inputTokens === "number") input += typed.inputTokens;
        if (typeof typed.outputTokens === "number") output += typed.outputTokens;
      }
      if (cost > 0) usage.costUSD ??= cost;
      if (input > 0) usage.inputTokens ??= input;
      if (output > 0) usage.outputTokens ??= output;
    }
    if (usage.costUSD !== undefined && usage.durationMs !== undefined) break;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export class ProcessAgentGateway implements AgentGateway {
  private readonly activeRuns = new Set<Promise<AgentResponse>>();
  private shuttingDown = false;

  constructor(
    private readonly runner = new ManagedProcessRunner(),
    private readonly onState?: (role: string, state: ManagedRunState) => void,
    private readonly providerProbe: ProviderProbe = probeProvider,
    private readonly onOutput?: (chunk: AgentOutputChunk) => void,
    private readonly maxDurationMs?: number,
    private readonly inactivityMs: number = 5 * 60 * 1000,
  ) {}

  async preflight(request: AgentPreflightRequest): Promise<AgentProviderReadiness> {
    const executable = request.provider === "openai"
      ? process.env.HIVE_CODEX_EXECUTABLE ?? "codex"
      : request.provider === "claude"
        ? process.env.HIVE_CLAUDE_EXECUTABLE ?? "claude"
        : "";
    if (!executable) return { ...request, available: false, detail: `unsupported provider: ${request.provider}` };
    const args = request.provider === "openai" ? ["login", "status"] : ["auth", "status"];
    const result = this.providerProbe(executable, args);
    const detail = (result.status === 0 ? result.stdout : result.stderr || result.stdout).trim()
      || `${request.provider} readiness probe exited ${result.status}`;
    return { ...request, available: result.status === 0, detail };
  }

  run(request: AgentRequest): Promise<AgentResponse> {
    if (this.shuttingDown) return Promise.reject(new Error("agent gateway is shutting down"));
    const active = this.runManaged(request).finally(() => this.activeRuns.delete(active));
    this.activeRuns.add(active);
    return active;
  }

  async cancelActive(): Promise<number> {
    return this.runner.cancelActive();
  }

  private async runManaged(request: AgentRequest): Promise<AgentResponse> {
    const command = buildAgentCommand(request);
    const result = await this.runner.run({
      command: command.executable,
      args: command.args,
      stdin: command.stdin,
      cwd: request.cwd ?? process.cwd(),
      env: sanitizedAgentEnvironment(),
      inactivityTimeoutMs: this.inactivityMs,
      maxDurationMs: this.maxDurationMs,
      maxRestarts: 1,
      onState: (state) => this.onState?.(request.role, state),
      onOutput: this.onOutput
        ? (stream, text) => this.onOutput?.({ role: request.role, runId: request.runId, stream, text })
        : undefined,
    });
    // A failed run still reports what it spent, so carry usage down both paths.
    const usage = parseAgentUsage(result.stdout);
    if (result.outcome !== "done") {
      const detail = result.stderr.trim() || result.stdout.trim() || result.outcome;
      throw new AgentRunError(
        `${request.provider} ${request.role} run ${result.outcome}: ${summarizeFailure(detail)}`,
        usage,
      );
    }
    return { text: parseAgentOutput(request.provider, result.stdout), usage };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.runner.stop();
    await Promise.allSettled([...this.activeRuns]);
  }
}
