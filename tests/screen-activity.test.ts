import { describe, expect, it, vi } from "vitest";
import { createScreenActivityChecker } from "../src/discord/screen-activity.js";

describe("createScreenActivityChecker", () => {
  it("reports no activity on the first call — nothing to compare against yet", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue("hello");
    const check = createScreenActivityChecker({ sessionName: "claude-discord", runCommand, readFile });

    expect(await check()).toBe(false);
  });

  it("reports activity when the dumped content changed since the last call", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValueOnce("frame one").mockReturnValueOnce("frame two");
    const check = createScreenActivityChecker({ sessionName: "claude-discord", runCommand, readFile });

    await check();
    expect(await check()).toBe(true);
  });

  it("reports no activity when the dumped content is identical", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue("same frame");
    const check = createScreenActivityChecker({ sessionName: "claude-discord", runCommand, readFile });

    await check();
    expect(await check()).toBe(false);
  });

  it("treats a missing/dead screen session as no signal rather than throwing", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("No screen session found"));
    const check = createScreenActivityChecker({ sessionName: "claude-discord", runCommand });

    await expect(check()).resolves.toBe(false);
  });

  it("passes the session name and a hardcopy target to the command", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue("x");
    const check = createScreenActivityChecker({ sessionName: "claude-discord", runCommand, readFile, tmpFile: "/tmp/x.txt" });

    await check();
    expect(runCommand).toHaveBeenCalledWith("screen", ["-S", "claude-discord", "-X", "hardcopy", "/tmp/x.txt"]);
  });
});
