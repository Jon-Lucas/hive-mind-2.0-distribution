import { execFile } from "node:child_process";

/**
 * Second, independent activity signal alongside `screen-activity.ts`. Screen
 * hardcopy only proves the pty's *visible frame* changed — a long silent
 * stretch (grep, a test run, an agent/tool call whose own output doesn't
 * repaint the status line for minutes) can leave that frame untouched even
 * though the process is genuinely working. CPU time is a signal the terminal
 * can't hide: a process burning CPU is not the "composed a reply and went
 * idle" failure this watchdog exists to catch.
 *
 * The session's pid is resolved from `screen -ls` and walked down through its
 * child processes (screen -> login -> the actual `claude` process, on this
 * host) rather than matched against the launch command line, so a change to
 * how the session is invoked doesn't silently break the check.
 */

export interface ProcessActivityDeps {
  sessionName: string;
  runCommand?: (file: string, args: string[]) => Promise<string>;
}

const runCommandDefault = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** Parses ps's `TIME` column (`[[dd-]hh:]mm:ss[.ss]`) into seconds. */
function parseCpuTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [daysPart, rest] = trimmed.includes("-") ? trimmed.split("-") : [null, trimmed];
  const parts = rest.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds + (daysPart ? Number(daysPart) * 86_400 : 0);
}

async function findChildPid(runCommand: ProcessActivityDeps["runCommand"] & {}, parentPid: string): Promise<string | null> {
  const output = await runCommand("pgrep", ["-P", parentPid]);
  return output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

/** Finds the session's root pid via `screen -ls`, then walks down to its
 *  deepest child — the actual foreground process, past any login/shell layer. */
async function resolveLeafPid(runCommand: NonNullable<ProcessActivityDeps["runCommand"]>, sessionName: string): Promise<string | null> {
  const listing = await runCommand("screen", ["-ls"]);
  const sessionLine = listing.split("\n").map((line) => line.trim())
    .find((line) => new RegExp(`^\\d+\\.${sessionName}(\\s|$)`).test(line));
  const rootMatch = sessionLine ? /^(\d+)\./.exec(sessionLine) : null;
  if (!rootMatch) return null;
  let pid = rootMatch[1]!;
  for (let depth = 0; depth < 6; depth++) {
    const child = await findChildPid(runCommand, pid);
    if (!child) break;
    pid = child;
  }
  return pid;
}

/**
 * Returns a checker that reports whether the always-on session's process has
 * burned any CPU since the previous call. Like the screen checker, the first
 * call always reports `false` — there is no prior sample yet, not evidence of
 * a hang.
 */
export function createProcessActivityChecker(deps: ProcessActivityDeps): () => Promise<boolean> {
  const runCommand = deps.runCommand ?? runCommandDefault;
  let lastCpuSeconds: number | null = null;

  return async () => {
    try {
      const pid = await resolveLeafPid(runCommand, deps.sessionName);
      if (!pid) return false;
      const psOutput = await runCommand("ps", ["-o", "time=", "-p", pid]);
      const cpuSeconds = parseCpuTime(psOutput);
      if (cpuSeconds === null) return false;
      const changed = lastCpuSeconds !== null && cpuSeconds > lastCpuSeconds;
      lastCpuSeconds = cpuSeconds;
      return changed;
    } catch {
      // No matching session/process, pgrep/ps unavailable — no signal, not a hang.
      return false;
    }
  };
}
