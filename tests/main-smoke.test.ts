import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("main executable", () => {
  let child: ChildProcess | undefined;
  let workspace: string | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("starts a healthy local server and shuts down", async () => {
    const port = await freePort();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hive-main-"));
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HIVE_WORKSPACE: workspace,
        HIVE_DISABLE_ENV_FILE: "1",
        DISCORD_BOT_TOKEN: "",
        DISCORD_CHANNEL_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });

    let response: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) break;
      } catch { /* server still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(response?.status, output).toBe(200);
    expect(await response!.json()).toMatchObject({ status: "online" });
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => child!.once("exit", resolve));
    expect(exitCode, output).toBe(0);
  }, 10_000);
});
