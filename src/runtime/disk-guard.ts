import fs from "node:fs";

export const BYTES_PER_GB = 1024 ** 3;

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskDecision {
  /** Say something now. */
  notify: boolean;
  /** Free space came back; the next shortage is worth announcing again. */
  recovered: boolean;
  message?: string;
}

function gb(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

/**
 * Warn once per shortage, not once per tick.
 *
 * Recovery needs meaningfully more room than the threshold, or a volume
 * hovering at the line would alternate between warned and recovered and
 * announce every crossing.
 */
export function evaluateDiskSpace(
  reading: DiskReading,
  thresholdBytes: number,
  alreadyWarned: boolean,
): DiskDecision {
  const short = reading.freeBytes < thresholdBytes;
  if (short && !alreadyWarned) {
    return {
      notify: true,
      recovered: false,
      message: `Only ${gb(reading.freeBytes)} free on the workspace volume (of ${gb(reading.totalBytes)}). `
        + "Finished work items release their checkouts automatically; anything still here belongs to a live or blocked run.",
    };
  }
  if (!short && alreadyWarned && reading.freeBytes >= thresholdBytes * 1.2) {
    return { notify: false, recovered: true };
  }
  return { notify: false, recovered: false };
}

export async function readDiskSpace(root: string): Promise<DiskReading> {
  const stats = await fs.promises.statfs(root);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
}

/**
 * Watches free space on the volume holding the workspace.
 *
 * Free space rather than workspace size: it is the number that actually stops
 * a build, and reading it is one syscall — walking a 25 GB tree of dependency
 * folders every few minutes would cost more than the problem.
 */
export class DiskGuard {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;

  constructor(
    private readonly root: string,
    private readonly thresholdBytes: number,
    private readonly notify: (message: string) => Promise<unknown>,
    private readonly tickMs: number,
    private readonly read: (root: string) => Promise<DiskReading> = readDiskSpace,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error("[disk] check failed:", error));
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const reading = await this.read(this.root);
    const decision = evaluateDiskSpace(reading, this.thresholdBytes, this.warned);
    if (decision.recovered) {
      this.warned = false;
      return;
    }
    if (!decision.notify || !decision.message) return;
    // Marked before delivery: a notifier that throws must not queue a warning
    // on every tick for the rest of the session.
    this.warned = true;
    await this.notify(decision.message);
  }
}
