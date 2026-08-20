import { spawn, type ChildProcess } from "node:child_process";

export type ManagedRunState = "running" | "restarting" | "done" | "failed" | "stalled" | "cancelled" | "expired";

export interface ManagedRunOptions {
  command: string;
  args: string[];
  stdin?: string;
  cwd: string;
  /** Replaces the environment entirely when supplied; the child never merges process.env. */
  env?: NodeJS.ProcessEnv;
  inactivityTimeoutMs: number;
  /**
   * Hard wall-clock ceiling. Inactivity alone cannot stop a noisy retry loop.
   * Spans the whole run: restarts inherit the time already spent rather than
   * starting a fresh budget, so maxRestarts cannot multiply the ceiling.
   */
  maxDurationMs?: number;
  maxRestarts: number;
  onState?: (state: ManagedRunState) => void;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ManagedRunResult {
  outcome: "done" | "failed" | "stalled" | "cancelled" | "expired";
  attempts: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface AttemptResult {
  outcome: "done" | "failed" | "stalled" | "cancelled" | "expired";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function terminateProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const processGroupId = child.pid;
  signalProcessGroup(child, "SIGTERM");
  await delay(250);
  // The group leader may have exited while a descendant ignored SIGTERM.
  // Always target the original process group after the grace period.
  signalProcessGroup(child, "SIGKILL");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await delay(10);
  }
  if (processGroupExists(processGroupId)) {
    throw new Error(`process group ${processGroupId} survived SIGKILL`);
  }
}

export class ManagedProcessRunner {
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly terminations = new Map<ChildProcess, Promise<void>>();
  private readonly cancelledChildren = new WeakSet<ChildProcess>();
  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.activeChildren].map((child) => this.terminate(child)));
    if (this.activeChildren.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /**
   * Kill the currently active children without latching shutdown, so the
   * runner stays usable for later runs. Each killed run resolves with the
   * "cancelled" outcome rather than "failed" or "stalled".
   */
  async cancelActive(): Promise<number> {
    const children = [...this.activeChildren];
    for (const child of children) this.cancelledChildren.add(child);
    await Promise.all(children.map((child) => this.terminate(child)));
    return children.length;
  }

  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) return existing;
    const termination = terminateProcessGroup(child).finally(() => this.terminations.delete(child));
    this.terminations.set(child, termination);
    return termination;
  }

  async run(options: ManagedRunOptions): Promise<ManagedRunResult> {
    if (options.inactivityTimeoutMs <= 0) throw new Error("inactivity timeout must be positive");
    if (this.stopping) return { outcome: "cancelled", attempts: 0, exitCode: null, stdout: "", stderr: "" };
    let attempts = 0;
    let stdout = "";
    let stderr = "";
    // One deadline for the whole run. Arming the ceiling per attempt would hand
    // every restart a fresh budget, so a stall-then-restart could outlive the
    // ceiling by a multiple of maxRestarts.
    const deadline = options.maxDurationMs !== undefined && options.maxDurationMs > 0
      ? Date.now() + options.maxDurationMs
      : undefined;

    while (attempts <= options.maxRestarts) {
      if (this.stopping) return { outcome: "cancelled", attempts, exitCode: null, stdout, stderr };
      // Defence in depth: a deadline that passes mid-attempt is normally caught
      // by that attempt's timer, so this only guards a restart against a clock
      // that moved between the child closing and the loop coming back round.
      if (deadline !== undefined && Date.now() >= deadline) {
        options.onState?.("expired");
        return { outcome: "expired", attempts, exitCode: null, stdout, stderr };
      }
      attempts += 1;
      const result = await this.runAttempt(options, deadline);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.outcome === "cancelled" || result.outcome === "expired") {
        options.onState?.(result.outcome);
        return { ...result, attempts, stdout, stderr };
      }
      if (result.outcome !== "stalled") {
        options.onState?.(result.outcome);
        return { ...result, attempts, stdout, stderr };
      }
      if (attempts <= options.maxRestarts) {
        options.onState?.("restarting");
        continue;
      }
      options.onState?.("stalled");
      return { outcome: "stalled", attempts, exitCode: result.exitCode, stdout, stderr };
    }
    throw new Error("unreachable process runner state");
  }

  private runAttempt(options: ManagedRunOptions, deadline?: number): Promise<AttemptResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.activeChildren.add(child);
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      else child.stdin?.end();
      let stdout = "";
      let stderr = "";
      let stalled = false;
      let expired = false;
      let timer: NodeJS.Timeout;
      // Whatever is left of the run's ceiling, not a fresh copy of it.
      const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
      const budgetTimer = remainingMs !== undefined
        ? setTimeout(() => { expired = true; void this.terminate(child); }, Math.max(remainingMs, 0))
        : undefined;

      const recordClosed = () => {
        this.activeChildren.delete(child);
        if (this.activeChildren.size !== 0) return;
        for (const waiter of this.idleWaiters) waiter();
        this.idleWaiters.clear();
      };

      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          void this.terminate(child);
        }, options.inactivityTimeoutMs);
      };
      const record = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "stdout") stdout += text;
        else stderr += text;
        options.onOutput?.(stream, text);
        armTimeout();
      };

      child.stdout?.on("data", (chunk: Buffer) => record("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => record("stderr", chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        if (budgetTimer) clearTimeout(budgetTimer);
        recordClosed();
        reject(error);
      });
      child.once("close", (code) => { void (async () => {
        clearTimeout(timer);
        if (budgetTimer) clearTimeout(budgetTimer);
        await this.terminations.get(child);
        recordClosed();
        resolve({
          outcome: this.stopping || this.cancelledChildren.has(child)
            ? "cancelled"
            : expired ? "expired" : stalled ? "stalled" : code === 0 ? "done" : "failed",
          exitCode: code,
          stdout,
          stderr,
        });
      })().catch(reject); });
      armTimeout();
      try {
        options.onState?.("running");
      } catch (error) {
        void this.terminate(child).then(() => reject(error), reject);
      }
    });
  }
}
