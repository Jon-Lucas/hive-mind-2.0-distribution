import fs from "node:fs";
import path from "node:path";
import type { AgentOutputChunk } from "../agents/agent-gateway.js";

export interface RunOutputSink {
  /** Full fidelity, appended to system/run-logs. */
  persist(chunk: AgentOutputChunk): void;
  /** Throttled tail for the GUI. */
  publish(payload: { role: string; runId?: number; lines: string[]; at: string }): void;
  /** Liveness, so a silent agent is visible before the inactivity timeout fires. */
  touch(runId: number): void;
}

const FLUSH_INTERVAL_MS = 500;
const TAIL_LINES = 40;
const MAX_LINE = 500;

/**
 * Agent stdout is the richest signal about what the studio is doing, but it
 * arrives as a fast stream of partial chunks. Persist everything, and forward a
 * bounded, throttled tail so the GUI stays readable and the socket stays quiet.
 */
export class RunOutputRecorder {
  private readonly buffers = new Map<string, string[]>();
  private readonly partial = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly sink: RunOutputSink) {}

  record(chunk: AgentOutputChunk): void {
    this.sink.persist(chunk);
    if (chunk.runId !== undefined) this.sink.touch(chunk.runId);

    const key = `${chunk.role}:${chunk.runId ?? "none"}`;
    const carried = (this.partial.get(key) ?? "") + chunk.text;
    const segments = carried.split("\n");
    this.partial.set(key, segments.pop() ?? "");

    const lines = segments
      .map((line) => line.replace(/\s+$/, ""))
      .filter(Boolean)
      .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line));
    if (lines.length === 0) return;

    const buffered = this.buffers.get(key) ?? [];
    buffered.push(...lines);
    this.buffers.set(key, buffered.slice(-TAIL_LINES));
    this.schedule();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [key, lines] of this.buffers) {
      if (lines.length === 0) continue;
      const [role, rawRunId] = key.split(":");
      this.sink.publish({
        role: role ?? "unknown",
        runId: rawRunId && rawRunId !== "none" ? Number(rawRunId) : undefined,
        lines: [...lines],
        at: new Date().toISOString(),
      });
    }
    this.buffers.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }
}

export function createRunLogWriter(runLogDirectory: string): (chunk: AgentOutputChunk) => void {
  return (chunk) => {
    try {
      fs.mkdirSync(runLogDirectory, { recursive: true });
      const name = chunk.runId !== undefined ? `run-${chunk.runId}.log` : `${chunk.role}.log`;
      fs.appendFileSync(path.join(runLogDirectory, name), chunk.text, "utf8");
    } catch {
      // Observability must never interfere with the run it is observing.
    }
  };
}
