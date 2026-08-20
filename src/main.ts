import fs from "node:fs";
import path from "node:path";
import process, { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { runtimeConfigFromEnv } from "./config/runtime-config.js";
import { createRuntime } from "./runtime/create-runtime.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const envFile = path.join(projectRoot, ".env");
if (process.env.HIVE_DISABLE_ENV_FILE !== "1" && fs.existsSync(envFile)) loadEnvFile(envFile);

const config = runtimeConfigFromEnv(process.env, projectRoot);
const runtime = await createRuntime(config);
const address = await runtime.start();
console.log(`[hive] Hive Mind 2.0 listening at ${address}`);

const heartbeat = setInterval(() => {
  if (typeof process.send === "function") {
    process.send({ type: "heartbeat", at: new Date().toISOString(), pid: process.pid });
  }
}, 5_000);
heartbeat.unref();
if (typeof process.send === "function") {
  process.send({ type: "heartbeat", at: new Date().toISOString(), pid: process.pid });
}

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  console.log(`[hive] shutting down (${signal})`);
  try {
    await runtime.close();
    process.exitCode = exitCode;
  } catch (error) {
    console.error("[hive] shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  console.error("[hive] uncaught exception:", error);
  void shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  console.error("[hive] unhandled rejection:", error);
  void shutdown("unhandledRejection", 1);
});
