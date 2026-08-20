import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tells the channel watchdog apart the two things that look identical from
 * Discord alone: a session still generating/tool-calling, and one that has
 * genuinely finished and gone silent (the reply-never-sent bug). The always-on
 * session runs inside `screen -D -m`, so its live terminal content is readable
 * from outside without touching Claude Code itself — `hardcopy` dumps the pty
 * to a file. If that dump differs from the last dump, something was written
 * to the screen since, meaning the session is not frozen.
 */

export interface ScreenActivityDeps {
  sessionName: string;
  runCommand?: (file: string, args: string[]) => Promise<void>;
  readFile?: (file: string) => string;
  tmpFile?: string;
}

const runCommandDefault = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (error) => (error ? reject(error) : resolve()));
  });

/**
 * Returns a checker that reports whether the session's screen has produced
 * new output since the previous call. The first call always reports `false`
 * (nothing to compare against yet) — callers should treat "no signal available
 * yet" the same as "no activity observed", not as evidence of a hang.
 */
export function createScreenActivityChecker(deps: ScreenActivityDeps): () => Promise<boolean> {
  const tmpFile = deps.tmpFile ?? path.join(os.tmpdir(), `hive-screen-activity-${deps.sessionName}.txt`);
  const runCommand = deps.runCommand ?? runCommandDefault;
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  let lastContent: string | null = null;

  return async () => {
    try {
      await runCommand("screen", ["-S", deps.sessionName, "-X", "hardcopy", tmpFile]);
      const content = readFile(tmpFile);
      const changed = lastContent !== null && content !== lastContent;
      lastContent = content;
      return changed;
    } catch {
      // No screen session, no permission, hardcopy unsupported — treat as "no
      // signal" rather than "definitely stuck"; the stale/cooldown checks
      // still apply on top of this.
      return false;
    }
  };
}
