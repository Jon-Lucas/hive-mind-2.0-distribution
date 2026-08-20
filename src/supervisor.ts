import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { HeartbeatPolicy } from "./supervision/heartbeat-policy.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = process.env.HIVE_WORKSPACE || path.join(process.env.HOME ?? "/tmp", "HiveMindWorkspace");
const statusPath = path.join(workspaceRoot, "system", "supervisor-status.json");
const timeoutMs = Number(process.env.HIVE_BACKEND_HEARTBEAT_TIMEOUT_MS ?? 20_000);
const policy = new HeartbeatPolicy({ timeoutMs, maxRestarts: 3, restartWindowMs: 10 * 60_000 });

let child: ChildProcess | null = null;
let stopping = false;
let restarting = false;
let blocked = false;

function persistStatus(status: string, reason: string): void {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({ status, reason, at: new Date().toISOString(), childPid: child?.pid ?? null }, null, 2));
}

function startChild(reason: string): void {
  if (stopping || blocked) return;
  policy.resetHeartbeat();
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  policy.touch();
  persistStatus("starting", reason);
  console.log(`[supervisor] backend started pid=${child.pid ?? "unknown"} (${reason})`);
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object" && (message as { type?: string }).type === "heartbeat") {
      policy.touch();
      persistStatus("healthy", "heartbeat received");
    }
  });
  child.once("exit", (code, signal) => {
    const wasRestarting = restarting;
    child = null;
    if (stopping || wasRestarting) return;
    const reasonText = `backend exited code=${code ?? "null"} signal=${signal ?? "none"}`;
    console.error(`[supervisor] ${reasonText}`);
    requestRestart(reasonText);
  });
}

function terminateChild(): Promise<void> {
  return new Promise((resolve) => {
    const target = child;
    if (!target || target.exitCode !== null) return resolve();
    const done = () => resolve();
    target.once("exit", done);
    try {
      if (target.pid) process.kill(-target.pid, "SIGTERM");
      else target.kill("SIGTERM");
    } catch {
      target.kill("SIGTERM");
    }
    setTimeout(() => {
      if (target.exitCode !== null) return;
      try {
        if (target.pid) process.kill(-target.pid, "SIGKILL");
        else target.kill("SIGKILL");
      } catch { /* already gone */ }
    }, 5_000).unref();
  });
}

function requestRestart(reason: string): void {
  if (stopping || restarting || blocked) return;
  if (!policy.recordRestart()) {
    blocked = true;
    persistStatus("blocked", `restart budget exhausted: ${reason}`);
    console.error(`[supervisor] restart budget exhausted: ${reason}`);
    return;
  }
  restarting = true;
  persistStatus("restarting", reason);
  void terminateChild().finally(() => {
    restarting = false;
    setTimeout(() => startChild(reason), 500).unref();
  });
}

startChild("initial start");
const monitor = setInterval(() => {
  if (!stopping && !restarting && !blocked && policy.isStalled()) {
    requestRestart(`heartbeat missing for more than ${timeoutMs}ms`);
  }
}, 2_000);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  persistStatus("stopping", signal);
  await terminateChild();
  persistStatus("stopped", signal);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
