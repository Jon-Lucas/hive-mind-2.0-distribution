import { describe, expect, it } from "vitest";
import { ProjectRunScheduler } from "../src/runtime/project-run-scheduler.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("project run scheduler", () => {
  it("serializes same-project work while allowing different projects in parallel", async () => {
    const calls: number[] = [];
    const releases = new Map<number, () => void>();
    const scheduler = new ProjectRunScheduler(
      (workItemId) => workItemId === 3 ? 8 : 7,
      (workItemId) => new Promise<void>((resolve) => {
        calls.push(workItemId);
        releases.set(workItemId, resolve);
      }),
    );

    scheduler.schedule(1);
    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.schedule(2);
    scheduler.schedule(3);
    await tick();
    expect(calls).toEqual([1, 3]);

    releases.get(1)!();
    await tick();
    expect(calls).toEqual([1, 3, 2]);
  });

  it("stops queued work and drains the active run before shutdown", async () => {
    const calls: number[] = [];
    let release!: () => void;
    const scheduler = new ProjectRunScheduler(
      () => 7,
      (workItemId: number) => new Promise<void>((resolve) => {
        calls.push(workItemId);
        release = resolve;
      }),
    );
    scheduler.schedule(1);
    scheduler.schedule(2);
    await tick();

    scheduler.stop();
    const drained = scheduler.drain();
    release();
    await drained;

    expect(calls).toEqual([1]);
    expect(scheduler.schedule(3)).toBe(false);
  });

  it("queues one retry when the same work item is still finalizing", async () => {
    const calls: number[] = [];
    const releases: Array<() => void> = [];
    const scheduler = new ProjectRunScheduler(
      () => 7,
      (workItemId: number) => new Promise<void>((resolve) => {
        calls.push(workItemId);
        releases.push(resolve);
      }),
    );
    expect(scheduler.schedule(1)).toBe(true);
    await tick();

    expect(scheduler.schedule(1)).toBe(false);
    expect(scheduler.schedule(1, { queueIfActive: true })).toBe(true);
    expect(scheduler.schedule(1, { queueIfActive: true })).toBe(false);
    releases[0]!();
    await tick();

    expect(calls).toEqual([1, 1]);
    releases[1]!();
    await scheduler.drain();
  });
});
