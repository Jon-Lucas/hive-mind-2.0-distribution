import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriverRegistry } from "../src/tester/driver-registry.js";
import type { DriverContext, PlatformDriver, TestTarget } from "../src/tester/platform-driver.js";

function driver(target: TestTarget, available = true, runs: TestTarget[] = [], writesEvidence = true): PlatformDriver {
  return {
    target,
    async probe() {
      return { target, status: available ? "available" : "unavailable", checks: [] };
    },
    async run(context) {
      runs.push(target);
      if (writesEvidence) fs.writeFileSync(path.join(context.evidenceDir, `${target}.json`), "{}");
      return { target, status: "passed", evidence: [`${target}.json`], detail: "passed" };
    },
  };
}

const roots: string[] = [];
function context(): DriverContext {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-evidence-"));
  roots.push(evidenceDir);
  return { cwd: "/tmp/tester", commit: "abcdef1", evidenceDir };
}

describe("Tester driver registry", () => {
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  it("runs available requested targets and reports unavailable targets without launching them", async () => {
    const runs: TestTarget[] = [];
    const registry = new DriverRegistry([
      driver("web", true, runs),
      driver("ios-simulator", true, runs),
      driver("android-emulator", true, runs),
      driver("electron", false, runs),
    ]);

    const results = await registry.runRequired(["web", "electron"], context());

    expect(results.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: "web", status: "passed" },
      { target: "electron", status: "unavailable" },
    ]);
    expect(runs).toEqual(["web"]);
  });

  it("requires exactly one driver for every v1 target", () => {
    expect(() => new DriverRegistry([driver("web")])).toThrow("missing platform driver: ios-simulator");
    expect(() => new DriverRegistry([
      driver("web"), driver("web"), driver("ios-simulator"), driver("android-emulator"), driver("electron"),
    ])).toThrow("duplicate platform driver: web");
  });

  it("rejects a passing driver result without real in-scope evidence", async () => {
    const registry = new DriverRegistry([
      driver("web", true, [], false), driver("ios-simulator"), driver("android-emulator"), driver("electron"),
    ]);

    await expect(registry.runRequired(["web"], context())).rejects.toThrow("invalid or missing platform evidence");
  });

  it("rejects a symlinked evidence directory before launching a driver", async () => {
    const runs: TestTarget[] = [];
    const registry = new DriverRegistry([
      driver("web", true, runs), driver("ios-simulator"), driver("android-emulator"), driver("electron"),
    ]);
    const driverContext = context();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-outside-"));
    roots.push(outside);
    fs.rmSync(driverContext.evidenceDir, { recursive: true });
    fs.symlinkSync(outside, driverContext.evidenceDir, "dir");

    await expect(registry.runRequired(["web"], driverContext)).rejects.toThrow("evidence directory must be a real directory");
    expect(runs).toEqual([]);
  });

  // The Tester checkout is a worktree of the exact commit and node_modules is
  // gitignored, so without this the declared test packages are never present
  // and every target reports unavailable regardless of what Developer commits.
  function checkout(withLockfile = true): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-checkout-"));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { "test:web": "x" } }));
    if (withLockfile) fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    return dir;
  }

  it("installs the checkout's declared dependencies before probing any target", async () => {
    const runs: TestTarget[] = [];
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const cwd = checkout();
    const registry = new DriverRegistry(
      [driver("web", true, runs), driver("ios-simulator"), driver("android-emulator"), driver("electron")],
      (command, args, at) => {
        calls.push({ command, args, cwd: at });
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    const results = await registry.runRequired(["web"], { ...context(), cwd });

    expect(calls).toEqual([{ command: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd }]);
    expect(results[0]?.status).toBe("passed");
    expect(runs).toEqual(["web"]);
  });

  it("reports every target unavailable when the dependency install fails", async () => {
    const runs: TestTarget[] = [];
    const registry = new DriverRegistry(
      [driver("web", true, runs), driver("ios-simulator"), driver("android-emulator"), driver("electron")],
      () => ({ status: 1, stdout: "", stderr: "npm ci failed: no matching version" }),
    );

    const results = await registry.runRequired(["web"], { ...context(), cwd: checkout() });

    expect(results[0]?.status).toBe("unavailable");
    expect(results[0]?.detail).toContain("dependency install failed");
    expect(runs, "a failed install must not launch a target").toEqual([]);
  });

  // A backend restart between a passing suite and the Tester adjudicating it
  // used to re-boot the emulator for a run that had already succeeded.
  function receipt(evidenceDir: string, target: TestTarget, commit: string, status: "passed" | "failed"): void {
    fs.writeFileSync(
      path.join(evidenceDir, `${target}-${commit.slice(0, 12)}.json`),
      JSON.stringify({ target, commit, status, command: "npm run test:web", exitCode: status === "passed" ? 0 : 1, stdout: "", stderr: "", finishedAt: "2026-08-05T05:05:36.000Z" }),
    );
  }

  it("replays a passing receipt for the exact commit instead of re-running the target", async () => {
    const runs: TestTarget[] = [];
    const registry = new DriverRegistry([
      driver("web", true, runs), driver("ios-simulator"), driver("android-emulator"), driver("electron"),
    ]);
    const driverContext = context();
    receipt(driverContext.evidenceDir, "web", driverContext.commit, "passed");

    const [result] = await registry.runRequired(["web"], driverContext);

    expect(runs, "a completed run must not be paid for twice").toEqual([]);
    expect(result?.status).toBe("passed");
    expect(result?.reused).toBe(true);
    expect(result?.detail).toContain("resumed from its receipt");
    expect(result?.evidence).toEqual([fs.realpathSync(path.join(driverContext.evidenceDir, `web-${driverContext.commit.slice(0, 12)}.json`))]);
  });

  it("re-runs when the stored receipt failed, is for another commit, or is unreadable", async () => {
    const runs: TestTarget[] = [];
    const registry = new DriverRegistry([
      driver("web", true, runs), driver("ios-simulator"), driver("android-emulator"), driver("electron"),
    ]);

    const failed = context();
    receipt(failed.evidenceDir, "web", failed.commit, "failed");
    await registry.runRequired(["web"], failed);

    const otherCommit = context();
    receipt(otherCommit.evidenceDir, "web", otherCommit.commit, "passed");
    fs.renameSync(
      path.join(otherCommit.evidenceDir, `web-${otherCommit.commit.slice(0, 12)}.json`),
      path.join(otherCommit.evidenceDir, "web-999999999999.json"),
    );
    await registry.runRequired(["web"], { ...otherCommit, commit: "999999999999" });

    const corrupt = context();
    fs.writeFileSync(path.join(corrupt.evidenceDir, `web-${corrupt.commit.slice(0, 12)}.json`), "not json");
    await registry.runRequired(["web"], corrupt);

    expect(runs).toEqual(["web", "web", "web"]);
  });

  it("skips the dependency install when every requested target is already checkpointed", async () => {
    const cwd = checkout();
    let called = false;
    const registry = new DriverRegistry(
      [driver("web"), driver("ios-simulator"), driver("android-emulator"), driver("electron")],
      () => { called = true; return { status: 0, stdout: "", stderr: "" }; },
    );
    const driverContext = { ...context(), cwd };
    receipt(driverContext.evidenceDir, "web", driverContext.commit, "passed");

    const [result] = await registry.runRequired(["web"], driverContext);

    expect(called, "nothing left to run means nothing to install for").toBe(false);
    expect(result?.reused).toBe(true);
  });

  it("keeps a checkpointed target passing when a failed install blocks the others", async () => {
    const registry = new DriverRegistry(
      [driver("web"), driver("ios-simulator"), driver("android-emulator"), driver("electron")],
      () => ({ status: 1, stdout: "", stderr: "npm ci failed" }),
    );
    const driverContext = { ...context(), cwd: checkout() };
    receipt(driverContext.evidenceDir, "web", driverContext.commit, "passed");

    const results = await registry.runRequired(["web", "electron"], driverContext);

    expect(results.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: "web", status: "passed" },
      { target: "electron", status: "unavailable" },
    ]);
  });

  it("skips the install when the checkout already has its modules", async () => {
    const cwd = checkout();
    fs.mkdirSync(path.join(cwd, "node_modules"));
    let called = false;
    const registry = new DriverRegistry(
      [driver("web"), driver("ios-simulator"), driver("android-emulator"), driver("electron")],
      () => { called = true; return { status: 0, stdout: "", stderr: "" }; },
    );

    await registry.runRequired(["web"], { ...context(), cwd });

    expect(called).toBe(false);
  });
});
