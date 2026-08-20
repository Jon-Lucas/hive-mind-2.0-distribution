export interface HeartbeatPolicyOptions {
  timeoutMs: number;
  maxRestarts: number;
  restartWindowMs: number;
}

export class HeartbeatPolicy {
  private lastHeartbeatAt = 0;
  private restartTimes: number[] = [];

  constructor(private readonly options: HeartbeatPolicyOptions) {
    if (options.timeoutMs <= 0 || options.maxRestarts < 0 || options.restartWindowMs <= 0) {
      throw new Error("invalid heartbeat policy");
    }
  }

  touch(now = Date.now()): void {
    this.lastHeartbeatAt = now;
  }

  isStalled(now = Date.now()): boolean {
    return this.lastHeartbeatAt > 0 && now - this.lastHeartbeatAt > this.options.timeoutMs;
  }

  recordRestart(now = Date.now()): boolean {
    this.restartTimes = this.restartTimes.filter((time) => now - time <= this.options.restartWindowMs);
    this.restartTimes.push(now);
    return this.restartTimes.length <= this.options.maxRestarts;
  }

  resetHeartbeat(): void {
    this.lastHeartbeatAt = 0;
  }
}
