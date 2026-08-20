import { describe, expect, it } from "vitest";
import { BYTES_PER_GB, DiskGuard, evaluateDiskSpace, type DiskReading } from "../src/runtime/disk-guard.js";

const reading = (freeGb: number): DiskReading => ({
  freeBytes: freeGb * BYTES_PER_GB,
  totalBytes: 500 * BYTES_PER_GB,
});

describe("disk guard", () => {
  it("warns once a shortage starts, not once per tick", () => {
    const threshold = 10 * BYTES_PER_GB;

    const first = evaluateDiskSpace(reading(4), threshold, false);
    expect(first.notify).toBe(true);
    expect(first.message).toContain("4.0 GB");

    expect(evaluateDiskSpace(reading(4), threshold, true).notify).toBe(false);
  });

  it("stays quiet while there is room", () => {
    expect(evaluateDiskSpace(reading(80), 10 * BYTES_PER_GB, false).notify).toBe(false);
  });

  it("re-arms only once free space is clear of the threshold", () => {
    const threshold = 10 * BYTES_PER_GB;
    // Barely over the line: a volume hovering here would otherwise announce
    // every crossing.
    expect(evaluateDiskSpace(reading(10.5), threshold, true).recovered).toBe(false);
    expect(evaluateDiskSpace(reading(30), threshold, true).recovered).toBe(true);
  });

  it("does not repeat the warning when delivery throws", async () => {
    let attempts = 0;
    const guard = new DiskGuard(
      "/unused",
      10 * BYTES_PER_GB,
      async () => {
        attempts += 1;
        throw new Error("discord is down");
      },
      60_000,
      async () => reading(2),
    );

    await expect(guard.tick()).rejects.toThrow("discord is down");
    await guard.tick();

    expect(attempts).toBe(1);
  });

  it("warns again about a fresh shortage after recovery", async () => {
    const messages: string[] = [];
    let free = 2;
    const guard = new DiskGuard(
      "/unused",
      10 * BYTES_PER_GB,
      async (message) => { messages.push(message); },
      60_000,
      async () => reading(free),
    );

    await guard.tick();
    free = 40;
    await guard.tick();
    free = 1;
    await guard.tick();

    expect(messages).toHaveLength(2);
  });
});
