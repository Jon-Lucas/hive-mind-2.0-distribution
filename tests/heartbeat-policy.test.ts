import { describe, expect, it } from "vitest";
import { HeartbeatPolicy } from "../src/supervision/heartbeat-policy.js";

describe("backend heartbeat policy", () => {
  it("detects a stalled backend and bounds rapid restart attempts", () => {
    const policy = new HeartbeatPolicy({ timeoutMs: 20_000, maxRestarts: 3, restartWindowMs: 600_000 });
    policy.touch(1_000);
    expect(policy.isStalled(20_999)).toBe(false);
    expect(policy.isStalled(21_001)).toBe(true);

    expect(policy.recordRestart(22_000)).toBe(true);
    expect(policy.recordRestart(23_000)).toBe(true);
    expect(policy.recordRestart(24_000)).toBe(true);
    expect(policy.recordRestart(25_000)).toBe(false);
    expect(policy.recordRestart(700_000)).toBe(true);
  });
});
