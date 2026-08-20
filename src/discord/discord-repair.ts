import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One-button recovery for the two independent Discord surfaces.
 *
 * They fail separately and neither failure is loud:
 *
 * - The **bridge** is this backend's own gateway connection (studio status,
 *   plan approvals). A dropped socket leaves it silent with the process healthy.
 * - The **session** is the always-on Claude Code process behind `#claude-code`
 *   (launchd `com.local.claude-discord`). When it wedges, Discord still shows
 *   the bot typing, so "it replied nothing" is the only symptom.
 *
 * Every step reports itself instead of throwing: a repair that fixed one of two
 * things must say so, not read as a total failure.
 */

export type RepairStatus = "ok" | "skipped" | "failed" | "warning";

export interface RepairStep {
  id: "bridge" | "session" | "preflight";
  status: RepairStatus;
  detail: string;
}

export interface RepairResult {
  ok: boolean;
  steps: RepairStep[];
  discord: { configured: boolean; online: boolean; error: string | null };
}

type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const runCommandDefault: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });

export interface RepairDeps {
  /** Rebuild the bridge's gateway connection. */
  reconnect: () => void;
  /** Live bridge state, read after the reconnect settles. */
  state: () => { configured: boolean; online: boolean; error: string | null };
  runCommand?: CommandRunner;
  /** launchd label for the always-on Claude Code session. */
  sessionLabel?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  /** Where Claude Code stores user settings; overridable for tests. */
  settingsPath?: string;
  /** The launcher script whose flags decide whether the preflight applies. */
  sessionScriptPath?: string;
  /** How long to let the gateway handshake settle before reading state. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The disclaimer trap: `--dangerously-skip-permissions` makes Claude Code block
 * on an interactive "Yes, I accept" dialog at startup. Under launchd there is no
 * keyboard, so the session hangs forever and every restart re-hangs it. The
 * accept button writes `skipDangerousModePermissionPrompt` into user settings —
 * without that key, restarting the session is worse than useless.
 */
export function checkBypassPreflight(
  readFile: (file: string) => string,
  settingsPath: string,
  sessionScriptPath: string,
): RepairStep {
  let script: string;
  try {
    script = readFile(sessionScriptPath);
  } catch {
    return { id: "preflight", status: "skipped", detail: "Session launcher script not found; skipped." };
  }
  if (!script.includes("--dangerously-skip-permissions")) {
    return { id: "preflight", status: "ok", detail: "Session does not use bypass mode; no disclaimer to accept." };
  }
  let accepted = false;
  try {
    accepted = JSON.parse(readFile(settingsPath))?.skipDangerousModePermissionPrompt === true;
  } catch {
    accepted = false;
  }
  return accepted
    ? { id: "preflight", status: "ok", detail: "Bypass disclaimer already accepted; session can boot unattended." }
    : {
        id: "preflight",
        status: "warning",
        detail: 'Session runs with --dangerously-skip-permissions but "skipDangerousModePermissionPrompt": true is '
          + `missing from ${settingsPath}. It will hang on the disclaimer at startup — add that key, or drop the flag.`,
      };
}

export async function repairDiscord(deps: RepairDeps): Promise<RepairResult> {
  const runCommand = deps.runCommand ?? runCommandDefault;
  const platform = deps.platform ?? process.platform;
  const label = deps.sessionLabel ?? process.env.HIVE_CLAUDE_DISCORD_LABEL ?? "com.local.claude-discord";
  const settingsPath = deps.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  const scriptPath = deps.sessionScriptPath ?? path.join(process.cwd(), "run-discord-channel.sh");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const steps: RepairStep[] = [];

  try {
    deps.reconnect();
    await sleep(deps.settleMs ?? 4_000);
    const state = deps.state();
    steps.push(state.online
      ? { id: "bridge", status: "ok", detail: "Bridge reconnected to the Discord gateway." }
      : {
          id: "bridge",
          status: state.configured ? "failed" : "skipped",
          detail: state.configured
            ? `Bridge still offline${state.error ? `: ${state.error}` : "."}`
            : "Bridge has no token or channel configured; nothing to reconnect.",
        });
  } catch (error) {
    steps.push({ id: "bridge", status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }

  if (platform !== "darwin") {
    steps.push({ id: "session", status: "skipped", detail: "Session restart is launchd-only (macOS)." });
  } else {
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    try {
      await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
      steps.push({ id: "session", status: "ok", detail: `Restarted ${label}. It reconnects with a fresh, empty context.` });
    } catch (error) {
      steps.push({
        id: "session",
        status: "failed",
        detail: `Could not restart ${label}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  steps.push(checkBypassPreflight((file) => fs.readFileSync(file, "utf8"), settingsPath, scriptPath));

  return {
    ok: steps.every((step) => step.status === "ok" || step.status === "skipped"),
    steps,
    discord: deps.state(),
  };
}
