import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface RepositoryState {
  slug: string;
  /** Files changed but not committed. */
  uncommitted: number;
  /** Commits on the current branch that no remote has. Null when no upstream. */
  unpushed: number | null;
}

export interface BackupDecision {
  notify: boolean;
  /** Everything is safe again; the next lapse is worth announcing. */
  recovered: boolean;
  message?: string;
}

function describe(state: RepositoryState): string {
  const parts: string[] = [];
  if (state.uncommitted > 0) parts.push(`${state.uncommitted} uncommitted file${state.uncommitted === 1 ? "" : "s"}`);
  if (state.unpushed && state.unpushed > 0) parts.push(`${state.unpushed} unpushed commit${state.unpushed === 1 ? "" : "s"}`);
  return `${state.slug}: ${parts.join(", ")}`;
}

export function atRisk(state: RepositoryState): boolean {
  return state.uncommitted > 0 || (state.unpushed ?? 0) > 0;
}

/**
 * Work that exists in exactly one place is one dead disk from gone. Say so
 * once, not every tick — this is a reminder, and a reminder repeated every few
 * minutes is noise that gets muted, which is worse than not sending it.
 */
export function evaluateBackup(states: RepositoryState[], alreadyWarned: boolean): BackupDecision {
  const exposed = states.filter(atRisk);
  if (exposed.length === 0) {
    return alreadyWarned ? { notify: false, recovered: true } : { notify: false, recovered: false };
  }
  if (alreadyWarned) return { notify: false, recovered: false };
  return {
    notify: true,
    recovered: false,
    message: `${exposed.map(describe).join("\n")}\n\nThis work exists only on this machine.`,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function readRepositoryState(slug: string, repositoryPath: string): RepositoryState | null {
  if (!fs.existsSync(path.join(repositoryPath, ".git"))) return null;
  let uncommitted = 0;
  let unpushed: number | null = null;
  try {
    const status = git(repositoryPath, ["status", "--porcelain"]);
    uncommitted = status ? status.split("\n").filter((line) => line.trim().length > 0).length : 0;
  } catch {
    return null;
  }
  try {
    // Throws when the branch has no upstream — a repository with no remote at
    // all, which the uncommitted count already speaks for.
    unpushed = Number(git(repositoryPath, ["rev-list", "--count", "@{upstream}..HEAD"])) || 0;
  } catch {
    unpushed = null;
  }
  return { slug, uncommitted, unpushed };
}

/**
 * Reminds the operator when a project's work is not backed up.
 *
 * The studio's own commits are safe the moment a passing commit is promoted;
 * this is about the work done by hand in the same repositories between runs,
 * which is exactly what sat unbacked-up for days before the repositories had
 * remotes at all.
 */
export class BackupGuard {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;

  constructor(
    private readonly projects: () => Array<{ slug: string; repositoryPath: string }>,
    private readonly notify: (message: string) => Promise<unknown>,
    private readonly tickMs: number,
    private readonly read: (slug: string, repositoryPath: string) => RepositoryState | null = readRepositoryState,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error("[backup] check failed:", error));
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const states = this.projects()
      .map((project) => this.read(project.slug, project.repositoryPath))
      .filter((state): state is RepositoryState => state !== null);
    const decision = evaluateBackup(states, this.warned);
    if (decision.recovered) {
      this.warned = false;
      return;
    }
    if (!decision.notify || !decision.message) return;
    // Set before delivery: a notifier that throws must not re-queue the same
    // reminder on every tick for the rest of the session.
    this.warned = true;
    await this.notify(decision.message);
  }
}
