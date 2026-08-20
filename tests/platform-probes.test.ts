import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptPlatformDriver } from "../src/tester/script-platform-driver.js";
import { sanitizedTestEnvironment, testCommandTimeoutMs, type CommandRunner } from "../src/tester/command-probe.js";
import { createDefaultDriverRegistry } from "../src/tester/default-platform-drivers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("checkout-local platform driver", () => {
  it("strips application credentials from generated project test environments", () => {
    const env = sanitizedTestEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      ANDROID_HOME: "/tmp/android",
      DISCORD_BOT_TOKEN: "secret-discord-token",
      ANTHROPIC_API_KEY: "secret-anthropic-key",
      OPENAI_API_KEY: "secret-openai-key",
    });

    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/tmp/home", ANDROID_HOME: "/tmp/android" });
    expect(env).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("composes exactly the four v1 platform backends", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-defaults-"));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: {
      "test:web": "web", "test:ios": "ios", "test:android": "android", "test:electron": "electron",
    } }));
    const runner: CommandRunner = () => ({ status: 0, stdout: "ready", stderr: "" });

    const availability = await createDefaultDriverRegistry(runner).probeAll({ cwd, commit: "abcdef1", evidenceDir: path.join(cwd, "evidence") });

    expect(availability.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: "web", status: "available" },
      { target: "ios-simulator", status: "available" },
      { target: "android-emulator", status: "available" },
      { target: "electron", status: "available" },
    ]);
  });

  it("requires the project script and backend, then writes an exact-commit receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-"));
    const evidenceDir = path.join(cwd, "evidence");
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "test:web": "playwright test" } }));
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0, stdout: "2 passed", stderr: "" };
    };
    const driver = new ScriptPlatformDriver("web", "test:web", [
      { id: "playwright", command: "node", args: ["-e", "require.resolve('playwright')"] },
    ], runner);
    const context = { cwd, commit: "abcdef123456", evidenceDir };

    expect((await driver.probe(context)).status).toBe("available");
    const result = await driver.run(context);

    expect(result.status).toBe("passed");
    expect(calls).toContain("npm run test:web");
    const receipt = JSON.parse(fs.readFileSync(result.evidence[0]!, "utf8"));
    expect(receipt).toMatchObject({ target: "web", commit: "abcdef123456", status: "passed" });
  });

  it("reports unavailable when a cached tool lacks a checkout-local package", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hive-driver-missing-"));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "test:web": "playwright test" } }));
    const runner: CommandRunner = () => ({ status: 1, stdout: "", stderr: "MODULE_NOT_FOUND" });
    const driver = new ScriptPlatformDriver("web", "test:web", [
      { id: "playwright", command: "node", args: ["-e", "require.resolve('playwright')"] },
    ], runner);

    const availability = await driver.probe({ cwd, commit: "abcdef1", evidenceDir: path.join(cwd, "evidence") });

    expect(availability.status).toBe("unavailable");
    expect(availability.checks.some((check) => check.id === "playwright" && check.status === "missing")).toBe(true);
  });
});

describe("test command timeout", () => {
  it("defaults to two hours so a slow emulator suite is not killed mid-boot", () => {
    expect(testCommandTimeoutMs({})).toBe(120 * 60_000);
  });

  it("honours an explicit override", () => {
    expect(testCommandTimeoutMs({ HIVE_TEST_COMMAND_MINUTES: "240" })).toBe(240 * 60_000);
  });

  it("falls back when the override is not a positive number", () => {
    expect(testCommandTimeoutMs({ HIVE_TEST_COMMAND_MINUTES: "0" })).toBe(120 * 60_000);
    expect(testCommandTimeoutMs({ HIVE_TEST_COMMAND_MINUTES: "not-a-number" })).toBe(120 * 60_000);
  });
});

describe("platform failure reporting", () => {
  it("reports the tail of stdout and stderr so the real error survives", async () => {
    const noise = "npm warn deprecated ".repeat(400);
    const runner: CommandRunner = () => ({
      status: 1,
      stdout: `${noise}\nstill waiting for cyclevault_api35 to appear in \`adb devices\``,
      stderr: `${noise}\nEmulator exited with code 1`,
    });
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-detail-"));
    roots.push(evidenceDir);
    const driver = new ScriptPlatformDriver("android-emulator", "test:android", [], runner);

    const result = await driver.run({ cwd: evidenceDir, commit: "abcdef1234567", evidenceDir });

    expect(result.status).toBe("failed");
    expect(result.detail, "the failure is at the end of stdout").toContain("still waiting for cyclevault_api35");
    expect(result.detail).toContain("Emulator exited with code 1");
  });
});

describe("command runner concurrency", () => {
  // Regression: this ran under spawnSync, which blocks the event loop for the
  // whole suite. The backend heartbeat is an interval, so it stopped firing and
  // the supervisor killed the process group — and the test with it.
  it("keeps timers running while a command executes", async () => {
    const { runCommand } = await import("../src/tester/command-probe.js");
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);

    const result = await runCommand(process.execPath, ["-e", "setTimeout(()=>console.log('done'), 400)"], process.cwd());
    clearInterval(ticker);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("done");
    expect(ticks, "the event loop must stay live while the suite runs").toBeGreaterThan(5);
  }, 10_000);

  it("captures output and exit status from a failing command", async () => {
    const { runCommand } = await import("../src/tester/command-probe.js");

    const result = await runCommand(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], process.cwd());

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("boom");
  }, 10_000);
});
