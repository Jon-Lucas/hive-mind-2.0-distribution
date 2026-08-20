import { describe, expect, it } from "vitest";
import { checkBypassPreflight, repairDiscord } from "../src/discord/discord-repair.js";

const online = { configured: true, online: true, error: null };
const offline = { configured: true, online: false, error: "gateway closed" };

/** Repair must never block on a real 4s gateway settle. */
const base = { platform: "darwin" as NodeJS.Platform, uid: 501, settleMs: 0, sleep: async () => undefined };

function stepFor(steps: { id: string; status: string; detail: string }[], id: string) {
  const step = steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`no ${id} step`);
  return step;
}

describe("Discord repair", () => {
  it("reconnects the bridge and restarts the session", async () => {
    const calls: string[][] = [];
    let reconnected = false;
    const result = await repairDiscord({
      ...base,
      reconnect: () => { reconnected = true; },
      state: () => online,
      runCommand: async (file, args) => { calls.push([file, ...args]); return { stdout: "", stderr: "" }; },
      sessionLabel: "com.local.claude-discord",
      settingsPath: "/no/settings.json",
      sessionScriptPath: "/no/script.sh",
    });
    expect(reconnected).toBe(true);
    expect(calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.local.claude-discord"]]);
    expect(stepFor(result.steps, "bridge").status).toBe("ok");
    expect(stepFor(result.steps, "session").status).toBe("ok");
  });

  it("reports a still-offline bridge as failed but keeps restarting the session", async () => {
    // The two surfaces fail independently: a dead gateway must not stop the
    // session restart, which is the half that fixes an unresponsive channel.
    let restarted = false;
    const result = await repairDiscord({
      ...base,
      reconnect: () => undefined,
      state: () => offline,
      runCommand: async () => { restarted = true; return { stdout: "", stderr: "" }; },
      settingsPath: "/no/settings.json",
      sessionScriptPath: "/no/script.sh",
    });
    expect(restarted).toBe(true);
    expect(stepFor(result.steps, "bridge").status).toBe("failed");
    expect(stepFor(result.steps, "bridge").detail).toContain("gateway closed");
    expect(result.ok).toBe(false);
  });

  it("does not claim to restart a session on a platform without launchd", async () => {
    const result = await repairDiscord({
      ...base,
      platform: "linux",
      reconnect: () => undefined,
      state: () => online,
      runCommand: async () => { throw new Error("must not run"); },
      settingsPath: "/no/settings.json",
      sessionScriptPath: "/no/script.sh",
    });
    expect(stepFor(result.steps, "session").status).toBe("skipped");
    expect(result.ok).toBe(true);
  });

  it("surfaces a failed restart instead of reporting success", async () => {
    const result = await repairDiscord({
      ...base,
      reconnect: () => undefined,
      state: () => online,
      runCommand: async () => { throw new Error("Could not find service"); },
      settingsPath: "/no/settings.json",
      sessionScriptPath: "/no/script.sh",
    });
    expect(stepFor(result.steps, "session").status).toBe("failed");
    expect(stepFor(result.steps, "session").detail).toContain("Could not find service");
    expect(result.ok).toBe(false);
  });
});

describe("bypass disclaimer preflight", () => {
  const read = (files: Record<string, string>) => (file: string) => {
    const value = files[file];
    if (value === undefined) throw new Error(`ENOENT ${file}`);
    return value;
  };

  it("warns when bypass mode is used without the accepted disclaimer", () => {
    // This is the exact trap that hung the session: restarting it without the
    // key just re-hangs it on a dialog no one can answer.
    const step = checkBypassPreflight(read({
      "/script.sh": "claude --channels plugin:discord --dangerously-skip-permissions",
      "/settings.json": JSON.stringify({ theme: "dark" }),
    }), "/settings.json", "/script.sh");
    expect(step.status).toBe("warning");
    expect(step.detail).toContain("skipDangerousModePermissionPrompt");
  });

  it("passes once the disclaimer key is present", () => {
    const step = checkBypassPreflight(read({
      "/script.sh": "claude --dangerously-skip-permissions",
      "/settings.json": JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    }), "/settings.json", "/script.sh");
    expect(step.status).toBe("ok");
  });

  it("does not warn when the session never asked for bypass mode", () => {
    const step = checkBypassPreflight(read({
      "/script.sh": "claude --channels plugin:discord",
      "/settings.json": "{}",
    }), "/settings.json", "/script.sh");
    expect(step.status).toBe("ok");
  });

  it("treats unreadable settings as not accepted rather than crashing", () => {
    const step = checkBypassPreflight(read({
      "/script.sh": "claude --dangerously-skip-permissions",
      "/settings.json": "{ not json",
    }), "/settings.json", "/script.sh");
    expect(step.status).toBe("warning");
  });
});
