import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeConfigFromEnv } from "../src/config/runtime-config.js";

describe("runtime configuration", () => {
  it("builds local-only paths and focused Discord settings", () => {
    const config = runtimeConfigFromEnv({
      PORT: "4401",
      HIVE_WORKSPACE: "/tmp/hive-workspace",
      DISCORD_BOT_TOKEN: "secret",
      DISCORD_CHANNEL_ID: "channel",
      DISCORD_OWNER_ID: "owner",
    }, "/tmp/hive-app");

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4401);
    expect(config.databasePath).toBe(path.join("/tmp/hive-workspace", "system", "database", "hive-mind.sqlite"));
    expect(config.discord).toEqual({ token: "secret", channelId: "channel", ownerId: "owner" });
  });

  it("rejects unsafe relative workspace roots and invalid ports", () => {
    expect(() => runtimeConfigFromEnv({ HIVE_WORKSPACE: "../outside" }, "/tmp/app")).toThrow(/absolute/);
    expect(() => runtimeConfigFromEnv({ PORT: "99999", HIVE_WORKSPACE: "/tmp/work" }, "/tmp/app")).toThrow(/port/i);
  });
});

describe("agent inactivity budget", () => {
  it("allows a long silent build before calling an agent wedged", () => {
    const config = runtimeConfigFromEnv({ PORT: "4401" }, "/tmp/project");
    expect(config.runBudget.inactivityMs).toBe(30 * 60_000);
  });

  it("honours an explicit idle override", () => {
    const config = runtimeConfigFromEnv({ PORT: "4401", HIVE_AGENT_IDLE_MINUTES: "45" }, "/tmp/project");
    expect(config.runBudget.inactivityMs).toBe(45 * 60_000);
  });
});
