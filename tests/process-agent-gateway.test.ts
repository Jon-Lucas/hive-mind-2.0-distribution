import { describe, expect, it } from "vitest";
import { buildAgentCommand, parseAgentOutput, ProcessAgentGateway } from "../src/agents/process-agent-gateway.js";
import type { AgentRequest } from "../src/agents/agent-gateway.js";

const base: AgentRequest = {
  role: "developer",
  provider: "openai",
  model: "gpt-5.6-sol",
  effort: "xhigh",
  prompt: "Build it",
  systemPrompt: "Follow the frozen plan",
  conversation: [],
  cwd: "/tmp/project",
};

describe("provider-neutral agent commands", () => {
  it("builds OpenAI execution without putting the prompt in argv", () => {
    const command = buildAgentCommand(base);
    expect(command.executable).toBe("codex");
    expect(command.args).toContain("gpt-5.6-sol");
    expect(command.args.join(" ")).not.toContain("Build it");
    expect(command.stdin).toContain("Follow the frozen plan");
    expect(command.stdin).toContain("Build it");
  });

  it("runs Developer and Tester unrestricted in their managed worktrees", () => {
    for (const role of ["developer", "tester"] as const) {
      const codex = buildAgentCommand({ ...base, role });
      expect(codex.args, role).toEqual(expect.arrayContaining(["--sandbox", "danger-full-access"]));
      expect(codex.args, role).not.toContain("workspace-write");

      const claude = buildAgentCommand({ ...base, role, provider: "claude", model: "claude-sonnet-5", effort: "high" });
      expect(claude.args, role).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    }
  });

  it("keeps Brain read-only on every provider, since it plans from the orchestrator's own directory", () => {
    const codex = buildAgentCommand({ ...base, role: "brain" });
    expect(codex.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(codex.args).not.toContain("danger-full-access");
    expect(codex.args).not.toContain("workspace-write");

    const claude = buildAgentCommand({ ...base, role: "brain", provider: "claude", model: "claude-sonnet-5", effort: "high" });
    expect(claude.args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    expect(claude.args).not.toContain("bypassPermissions");
  });

  it("fails closed instead of letting an unrecognized effort reach the command line", () => {
    const hostile = { ...base, effort: 'high" \nsandbox_mode="danger-full-access' };

    expect(() => buildAgentCommand(hostile)).toThrow(/unsupported effort/i);
    expect(() => buildAgentCommand({ ...base, provider: "claude", effort: "turbo" })).toThrow(/unsupported effort/i);
  });

  it("builds Claude noninteractive execution with manual model and effort", () => {
    const command = buildAgentCommand({ ...base, provider: "claude", model: "claude-sonnet-5", effort: "high" });
    expect(command.executable).toBe("claude");
    expect(command.args).toEqual(expect.arrayContaining(["-p", "--model", "claude-sonnet-5", "--effort", "high"]));
    expect(command.args.join(" ")).not.toContain("Build it");
  });

  it("normalizes Claude and OpenAI result formats", () => {
    expect(parseAgentOutput("claude", JSON.stringify({ result: "Claude result" }))).toBe("Claude result");
    const codex = [
      JSON.stringify({ type: "thread.started", thread_id: "abc" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex result" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(parseAgentOutput("openai", codex)).toBe("Codex result");
  });

  it("reports provider login readiness before an approved run starts", async () => {
    const calls: string[] = [];
    const gateway = new ProcessAgentGateway(undefined, undefined, (executable, args) => {
      calls.push([executable, ...args].join(" "));
      return { status: 1, stdout: "", stderr: "Not logged in" };
    });

    const readiness = await gateway.preflight!({ role: "developer", provider: "openai", model: "gpt-5.6-sol" });

    expect(readiness.available).toBe(false);
    expect(readiness.detail).toContain("Not logged in");
    expect(calls).toEqual(["codex login status"]);
  });

  it("waits for active calls during shutdown and rejects new calls", async () => {
    let release!: (result: object) => void;
    let runCalls = 0;
    const runner = {
      run() {
        runCalls += 1;
        return new Promise<object>((resolve) => { release = resolve; });
      },
      async stop() { /* active process completion is intentionally delayed */ },
    };
    const gateway = new ProcessAgentGateway(runner as never);
    const running = gateway.run(base);
    let shutdownFinished = false;
    const shutdown = gateway.shutdown!().then(() => { shutdownFinished = true; });
    const earlyResult = await Promise.race([
      shutdown.then(() => "finished" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);

    expect(earlyResult).toBe("pending");
    expect(shutdownFinished).toBe(false);
    await expect(gateway.run(base)).rejects.toThrow(/shutting down/i);
    expect(runCalls).toBe(1);

    release({
      outcome: "done", attempts: 1, exitCode: 0, stderr: "",
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "finished" } }),
    });
    await expect(running).resolves.toEqual({ text: "finished" });
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});

describe("attachment directory access", () => {
  it("grants Brain read access to allowed directories via --add-dir", () => {
    const claude = buildAgentCommand({
      ...base,
      role: "brain",
      provider: "claude",
      model: "claude-opus-5",
      effort: "high",
      allowedDirectories: ["/workspace/system/attachments"],
    });
    expect(claude.args.join(" ")).toContain("--add-dir /workspace/system/attachments");
    // Still read-only: extra directories never escalate the permission mode.
    expect(claude.args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));

    const bare = buildAgentCommand({ ...base, role: "brain", provider: "claude", model: "claude-opus-5", effort: "high" });
    expect(bare.args).not.toContain("--add-dir");
  });
});
