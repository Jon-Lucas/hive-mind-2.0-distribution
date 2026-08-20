import { spawn } from "node:child_process";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Sync results stay valid so existing fakes keep working, but the real runner is
 * asynchronous on purpose: see runCommand.
 */
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult | Promise<CommandResult>;

const TEST_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "TERM", "CI", "DISPLAY", "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "DEVELOPER_DIR",
] as const;

export function sanitizedTestEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(TEST_ENV_ALLOWLIST.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

/**
 * Booting an emulator and driving a full E2E suite routinely runs past ten
 * minutes, and the old fixed ceiling killed such a run mid-boot and reported it
 * as a target failure. Overridable so a slow suite is never mistaken for a
 * broken one.
 */
export function testCommandTimeoutMs(source: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(source.HIVE_TEST_COMMAND_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60_000;
}

/**
 * Asynchronous by necessity, not by style. This ran under spawnSync, which
 * blocks the event loop for the whole suite; the backend's heartbeat is an
 * interval, so it stopped firing, the supervisor declared the process stalled
 * after 20s and SIGTERMed its process group — killing the very test it was
 * waiting on. Every Android run died about twenty seconds in, and the resulting
 * "target did not pass" was the harness shooting itself.
 *
 * The child is detached so a signal aimed at the backend's group does not take
 * the suite with it; the timeout kills the child's own group explicitly.
 */
const activeTestCommands = new Set<number>();

/**
 * Kill every platform test command currently running (their whole process
 * groups). Used by the work-item kill switch: these children are detached, so
 * nothing else can reach them.
 */
export function cancelActiveTestCommands(): number {
  let killed = 0;
  for (const pid of [...activeTestCommands]) {
    try {
      process.kill(-pid, "SIGKILL");
      killed += 1;
    } catch { /* already gone */ }
  }
  return killed;
}

export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: sanitizedTestEnvironment(),
  });
  if (child.pid) {
    activeTestCommands.add(child.pid);
    child.once("close", () => activeTestCommands.delete(child.pid!));
  }
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, testCommandTimeoutMs());

  child.once("error", (error) => {
    clearTimeout(timer);
    resolve({ status: -1, stdout, stderr: error.message });
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve({
      status: code ?? -1,
      stdout,
      stderr: timedOut ? `${stderr}\ncommand exceeded ${testCommandTimeoutMs()}ms and was terminated` : stderr,
    });
  });
});

export interface CommandRequirement {
  id: string;
  command: string;
  args: string[];
}
