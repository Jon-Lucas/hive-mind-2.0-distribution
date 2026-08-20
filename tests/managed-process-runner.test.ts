import { describe, expect, it } from "vitest";
import { ManagedProcessRunner } from "../src/runs/managed-process-runner.js";

describe("managed process runner", () => {
  it("cancelActive kills the running child as cancelled and stays usable for later runs", async () => {
    const runner = new ManagedProcessRunner();
    const running = runner.run({
      command: process.execPath,
      args: ["-e", "console.log('up'); setInterval(() => console.log('tick'), 200)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 60_000,
      maxRestarts: 1,
    });
    // Give the child a moment to spawn before killing it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const killed = await runner.cancelActive();
    const result = await running;

    expect(killed).toBe(1);
    expect(result.outcome).toBe("cancelled");
    // Unlike stop(), cancelActive must not latch shutdown.
    const second = await runner.run({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 60_000,
      maxRestarts: 0,
    });
    expect(second.outcome).toBe("done");
    expect(second.stdout).toContain("ok");
  }, 5_000);

  it("retries one silent frozen process and then reports it stalled", async () => {
    const runner = new ManagedProcessRunner();
    const events: string[] = [];
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 60,
      maxRestarts: 1,
      onState: (state) => events.push(state),
    });

    expect(result.outcome).toBe("stalled");
    expect(result.attempts).toBe(2);
    expect(events).toContain("restarting");
    expect(events.at(-1)).toBe("stalled");
  }, 3_000);

  it("spends one wall-clock ceiling across the whole run, not one per attempt", async () => {
    const runner = new ManagedProcessRunner();
    const events: string[] = [];
    const startedAt = Date.now();

    // Silent, so every attempt stalls and is restarted. With the ceiling armed
    // per attempt this ran for maxDurationMs * (maxRestarts + 1).
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 150,
      maxDurationMs: 400,
      maxRestarts: 5,
      onState: (state) => events.push(state),
    });

    const elapsed = Date.now() - startedAt;
    expect(result.outcome).toBe("expired");
    expect(events.at(-1)).toBe("expired");
    // Six fresh 400ms budgets would be 2.4s; one shared budget is ~400ms.
    expect(elapsed, `run took ${elapsed}ms, ceiling was 400ms`).toBeLessThan(1_000);
  }, 5_000);


  it("delivers prompts through stdin instead of process arguments", async () => {
    const runner = new ManagedProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>console.log(s.trim()))"],
      stdin: "secret project prompt\n",
      cwd: process.cwd(),
      inactivityTimeoutMs: 200,
      maxRestarts: 0,
    });

    expect(result.outcome).toBe("done");
    expect(result.stdout.trim()).toBe("secret project prompt");
  });

  it("SIGKILLs a group descendant that survives after the leader exits", async () => {
    const runner = new ManagedProcessRunner();
    let descendantPid = 0;
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const running = runner.run({
      command: process.execPath,
      args: ["-e", [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] });",
        "child.stdout.once('data', () => console.log(child.pid));",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join(" ")],
      cwd: process.cwd(),
      inactivityTimeoutMs: 10_000,
      maxRestarts: 0,
      onOutput: (_stream, text) => {
        const pid = Number(text.trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          descendantPid = pid;
          signalReady();
        }
      },
    });
    await ready;

    await runner.stop();
    await running;
    let alive = true;
    try { process.kill(descendantPid, 0); } catch { alive = false; }
    if (alive) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    expect(alive).toBe(false);
  });

  it("cancels an active process group during shutdown", async () => {
    const runner = new ManagedProcessRunner();
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const running = runner.run({
      command: process.execPath,
      args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 60_000,
      maxRestarts: 1,
      onOutput: (_stream, text) => { if (text.includes("ready")) signalReady(); },
    });
    await ready;

    await runner.stop();
    const result = await running;

    expect(result.outcome).toBe("cancelled");
    expect(result.attempts).toBe(1);
  }, 3_000);

  it("registers the child before a running callback can initiate shutdown", async () => {
    const runner = new ManagedProcessRunner();
    const startedAt = Date.now();
    let shutdown: Promise<void> | undefined;
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 800,
      maxRestarts: 0,
      onState: (state) => {
        if (state === "running" && !shutdown) shutdown = runner.stop();
      },
    });
    await shutdown;

    expect(result.outcome).toBe("cancelled");
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 3_000);

  it("keeps an active process alive while it emits progress", async () => {
    const runner = new ManagedProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "let n=0; const t=setInterval(()=>{console.log(++n); if(n===4){clearInterval(t)}},200)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 500,
      maxRestarts: 1,
    });

    expect(result.outcome).toBe("done");
    expect(result.attempts).toBe(1);
    expect(result.stdout).toContain("4");
  }, 3_000);
});
