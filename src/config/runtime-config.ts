import os from "node:os";
import path from "node:path";
import type { DiscordBridgeConfig } from "../discord/discord-bridge.js";

export interface RuntimeConfig {
  host: string;
  port: number;
  projectRoot: string;
  frontendRoot: string;
  workspaceRoot: string;
  databasePath: string;
  discord: DiscordBridgeConfig;
  runBudget: RunBudget;
  watchdog: WatchdogBudget;
  /** Free space on the workspace volume below which the operator is warned. */
  diskWarnBytes: number;
  discordChannelWatchdog: DiscordChannelWatchdogConfig | null;
}

export interface DiscordChannelWatchdogConfig {
  /** The always-on Claude Code session's channel — a different one from `discord.channelId`. */
  channelId: string;
  tickMs: number;
  staleMs: number;
  cooldownMs: number;
  /** Withhold repair while the session's screen changed within this window —
   *  distinguishes "still working" from "actually silent". */
  activityGraceMs: number;
  /** Name of the `screen` session the always-on Claude Code process runs in
   *  (see run-discord-channel.sh), read for the activity signal above. */
  screenSessionName: string;
}

export interface WatchdogBudget {
  /** How often the idle watchdog wakes up and looks at the studio. */
  tickMs: number;
  /** Minimum silence (no events, no chat) before it may remind anyone. */
  quietMs: number;
  /** Minimum spacing between reminders about the same waiting set. */
  repeatMs: number;
  /**
   * Shorter quiet window used when a blocked work item is stuck at the
   * harness stage (git rebase/setup, before the developer stage even starts)
   * — mechanical and usually a quick fix, unlike a stuck plan or a genuine
   * tester/developer judgment call.
   */
  harnessQuietMs: number;
  /** How many times a finished work item is re-announced before it stops. */
  completionReminderLimit: number;
}

export interface RunBudget {
  /** Hard ceiling on a single agent run. */
  maxDurationMs: number;
  /** Ceiling on total spend across all agent runs for one work item. */
  maxCostUSD: number;
  /** How long an agent may emit nothing at all before it counts as wedged. */
  inactivityMs: number;
}

function positiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function runtimeConfigFromEnv(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): RuntimeConfig {
  const port = Number(env.PORT ?? 4401);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid server port");
  const workspaceRoot = env.HIVE_WORKSPACE?.trim() || path.join(os.homedir(), "HiveMindWorkspace");
  if (!path.isAbsolute(workspaceRoot)) throw new Error("HIVE_WORKSPACE must be an absolute path");
  const root = path.resolve(projectRoot);
  return {
    host: "127.0.0.1",
    port,
    projectRoot: root,
    frontendRoot: path.join(root, "frontend"),
    workspaceRoot,
    databasePath: path.join(workspaceRoot, "system", "database", "hive-mind.sqlite"),
    discord: {
      token: optional(env.DISCORD_BOT_TOKEN),
      channelId: optional(env.DISCORD_CHANNEL_ID),
      ownerId: optional(env.DISCORD_OWNER_ID),
    },
    // A run checkout plus its installed dependencies is measured in gigabytes,
    // so a full volume is a plausible way for the studio to stop working. Warn
    // with enough room left to finish whatever is in flight.
    diskWarnBytes: positiveNumber(env.HIVE_DISK_WARN_GB, 10, "HIVE_DISK_WARN_GB") * 1024 ** 3,
    // Inactivity alone cannot stop a noisy retry loop, so cap wall-clock and
    // cumulative spend explicitly.
    runBudget: {
      maxDurationMs: positiveNumber(env.HIVE_MAX_RUN_MINUTES, 45, "HIVE_MAX_RUN_MINUTES") * 60_000,
      maxCostUSD: positiveNumber(env.HIVE_MAX_WORK_ITEM_USD, 25, "HIVE_MAX_WORK_ITEM_USD"),
      // An agent waiting on a long build or an emulator boot emits nothing for
      // minutes at a time, and five minutes of that is ordinary rather than
      // wedged. Silence only means stuck well past the longest such wait.
      inactivityMs: positiveNumber(env.HIVE_AGENT_IDLE_MINUTES, 30, "HIVE_AGENT_IDLE_MINUTES") * 60_000,
    },
    // The workflow is event-driven and goes silent when it needs a human.
    // The watchdog turns that silence into a reminder instead of a stall.
    watchdog: {
      tickMs: positiveNumber(env.HIVE_WATCHDOG_MINUTES, 5, "HIVE_WATCHDOG_MINUTES") * 60_000,
      quietMs: positiveNumber(env.HIVE_WATCHDOG_QUIET_MINUTES, 10, "HIVE_WATCHDOG_QUIET_MINUTES") * 60_000,
      repeatMs: positiveNumber(env.HIVE_WATCHDOG_REPEAT_MINUTES, 60, "HIVE_WATCHDOG_REPEAT_MINUTES") * 60_000,
      harnessQuietMs: positiveNumber(env.HIVE_WATCHDOG_HARNESS_QUIET_MINUTES, 2, "HIVE_WATCHDOG_HARNESS_QUIET_MINUTES") * 60_000,
      completionReminderLimit: positiveNumber(env.HIVE_WATCHDOG_COMPLETION_REMINDERS, 3, "HIVE_WATCHDOG_COMPLETION_REMINDERS"),
    },
    // Unset by default: this watches a different channel (the always-on Claude
    // Code session's, not this bridge's own) and only makes sense once that
    // channel ID is known.
    discordChannelWatchdog: optional(env.CLAUDE_DISCORD_CHANNEL_ID) ? {
      channelId: env.CLAUDE_DISCORD_CHANNEL_ID!.trim(),
      tickMs: positiveNumber(env.HIVE_DISCORD_WATCHDOG_TICK_SECONDS, 15, "HIVE_DISCORD_WATCHDOG_TICK_SECONDS") * 1_000,
      // 90s/60s (the original defaults) is well inside a normal silent stretch
      // for codebase work — greps, test runs, and tool/agent calls routinely
      // leave the pty untouched for minutes with nothing wrong. Widened to
      // tolerate that instead of misreading it as a hang.
      staleMs: positiveNumber(env.HIVE_DISCORD_WATCHDOG_STALE_SECONDS, 300, "HIVE_DISCORD_WATCHDOG_STALE_SECONDS") * 1_000,
      cooldownMs: positiveNumber(env.HIVE_DISCORD_WATCHDOG_COOLDOWN_MINUTES, 10, "HIVE_DISCORD_WATCHDOG_COOLDOWN_MINUTES") * 60_000,
      activityGraceMs: positiveNumber(env.HIVE_DISCORD_WATCHDOG_ACTIVITY_GRACE_SECONDS, 180, "HIVE_DISCORD_WATCHDOG_ACTIVITY_GRACE_SECONDS") * 1_000,
      screenSessionName: env.HIVE_CLAUDE_DISCORD_SCREEN_SESSION?.trim() || "claude-discord",
    } : null,
  };
}
