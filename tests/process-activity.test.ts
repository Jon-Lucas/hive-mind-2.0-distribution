import { describe, expect, it, vi } from "vitest";
import { createProcessActivityChecker } from "../src/discord/process-activity.js";

function scriptedRunCommand(script: Record<string, string>) {
  return vi.fn(async (file: string, args: string[]) => {
    const key = `${file} ${args.join(" ")}`;
    if (key in script) return script[key]!;
    throw new Error(`unscripted command: ${key}`);
  });
}

describe("createProcessActivityChecker", () => {
  it("reports no activity on the first call — nothing to compare against yet", async () => {
    const runCommand = scriptedRunCommand({
      "screen -ls": "68073.claude-discord\t(Detached)",
      "pgrep -P 68073": "68075",
      "pgrep -P 68075": "68076",
      "pgrep -P 68076": "",
      "ps -o time= -p 68076": "0:49.77",
    });
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    expect(await check()).toBe(false);
  });

  it("reports activity when cpu time advanced since the last call", async () => {
    const cpuTimes = ["0:49.77", "1:02.10"];
    const runCommand = scriptedRunCommand({
      "screen -ls": "68073.claude-discord\t(Detached)",
      "pgrep -P 68073": "68076",
      "pgrep -P 68076": "",
    });
    runCommand.mockImplementation(async (file: string, args: string[]) => {
      if (file === "ps") return cpuTimes.shift()!;
      const key = `${file} ${args.join(" ")}`;
      if (key === "screen -ls") return "68073.claude-discord\t(Detached)";
      if (key === "pgrep -P 68073") return "68076";
      if (key === "pgrep -P 68076") return "";
      throw new Error(`unscripted command: ${key}`);
    });
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    await check();
    expect(await check()).toBe(true);
  });

  it("reports no activity when cpu time is unchanged — the process is genuinely idle", async () => {
    const runCommand = scriptedRunCommand({
      "screen -ls": "68073.claude-discord\t(Detached)",
      "pgrep -P 68073": "68076",
      "pgrep -P 68076": "",
      "ps -o time= -p 68076": "0:49.77",
    });
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    await check();
    expect(await check()).toBe(false);
  });

  it("treats a missing screen session as no signal rather than throwing", async () => {
    const runCommand = scriptedRunCommand({ "screen -ls": "" });
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    await expect(check()).resolves.toBe(false);
  });

  it("treats pgrep/ps failures as no signal rather than throwing", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("no such process"));
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    await expect(check()).resolves.toBe(false);
  });

  it("walks past intermediate wrapper processes to the deepest child", async () => {
    const runCommand = scriptedRunCommand({
      "screen -ls": "68073.claude-discord\t(Detached)",
      "pgrep -P 68073": "68075",
      "pgrep -P 68075": "68076",
      "pgrep -P 68076": "",
      "ps -o time= -p 68076": "0:00.00",
    });
    const check = createProcessActivityChecker({ sessionName: "claude-discord", runCommand });

    await check();
    expect(runCommand).toHaveBeenCalledWith("ps", ["-o", "time=", "-p", "68076"]);
  });
});
