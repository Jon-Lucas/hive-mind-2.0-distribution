import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("project slug must contain lowercase letters, numbers, and single hyphens only");
  }
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  if (fs.lstatSync(root).isSymbolicLink()) return;
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(target);
    else if (entry.isFile()) fs.chmodSync(target, 0o644);
  }
}

/**
 * Dependencies and build output, for every stack the studio's platform targets
 * cover. Deliberately broad: a missed entry costs gigabytes of history that
 * cannot be removed without rewriting it.
 */
const DEFAULT_GITIGNORE = `# Dependencies
node_modules/
.pnp/
.yarn/
vendor/
Pods/

# Build output
dist/
build/
out/
web-build/
.expo/
.next/
*.apk
*.aab
*.ipa
android/app/build/
android/.gradle/
android/.kotlin/
ios/build/

# Local environment and secrets
.env
.env.*
!.env.example
*.keystore
!debug.keystore

# Tooling noise
coverage/
*.log
.DS_Store
`;

/** Where a project's repository lives, when configured somewhere other than the managed slot. */
export type ProjectPathResolver = (slug: string) => string | undefined;

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Realpath of the longest existing ancestor, with the missing remainder
 * rejoined — a not-yet-created path still needs its symlinked prefix (macOS
 * /var, a symlinked HIVE_WORKSPACE) resolved before it can be compared
 * against the workspace's canonical root.
 */
function canonicalize(target: string): string {
  const missing: string[] = [];
  let prefix = target;
  while (!fs.existsSync(prefix)) {
    const parent = path.dirname(prefix);
    if (parent === prefix) return target;
    missing.unshift(path.basename(prefix));
    prefix = parent;
  }
  return path.join(fs.realpathSync(prefix), ...missing);
}

export class ManagedWorkspace {
  readonly root: string;

  constructor(root: string, private readonly resolveProjectPath?: ProjectPathResolver) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
    for (const directory of ["projects", "runs", "artifacts", "evidence", "knowledge", "system", "system/database", "system/run-logs"]) {
      fs.mkdirSync(path.join(this.root, directory), { recursive: true });
    }
  }

  createProject(slug: string, name: string): string {
    assertSlug(slug);
    const projectPath = this.projectPath(slug);
    // An externally configured repository is pre-existing code by definition.
    // Scaffolding one from here would rebuild the exact failure this guard
    // exists for: a fresh empty app in place of the repository the user meant.
    if (projectPath !== path.join(this.managedBase("projects"), slug)) {
      throw new Error(
        `project ${slug} is configured to use an existing repository at ${projectPath}, `
        + "which is missing or is not a git repository — restore it or repoint the project; refusing to scaffold",
      );
    }
    if (fs.existsSync(projectPath)) {
      this.assertManagedDirectory(projectPath, "project");
      if (fs.readdirSync(projectPath).length > 0) {
        throw new Error(`refusing to initialize over a non-empty directory: ${projectPath}`);
      }
    } else {
      fs.mkdirSync(projectPath, { recursive: true });
    }
    runGit(projectPath, ["init", "-b", "main"]);
    runGit(projectPath, ["config", "user.name", "Hive Mind"]);
    runGit(projectPath, ["config", "user.email", "hive@local.invalid"]);
    fs.writeFileSync(path.join(projectPath, "README.md"), `# ${name}\n\nManaged by Hive Mind 2.0.\n`);
    // Written before the first commit on purpose: the Developer's first
    // `git add -A` runs against whatever is on disk, and by then a install has
    // usually happened. Without this, dependencies land in history and stay
    // there — one managed project reached 222MB with 213 tracked node_modules
    // files, which no later .gitignore can undo.
    fs.writeFileSync(path.join(projectPath, ".gitignore"), DEFAULT_GITIGNORE);
    runGit(projectPath, ["add", "README.md", ".gitignore"]);
    runGit(projectPath, ["commit", "-m", "chore: initialize managed project"]);
    return projectPath;
  }

  createDeveloperWorkspace(slug: string, workflowId: number): string {
    assertSlug(slug);
    const projectPath = this.projectPath(slug);
    this.assertManagedDirectory(projectPath, "project");
    const target = path.join(this.runPath(workflowId), "developer");
    if (fs.existsSync(target)) {
      // Verified before any git command runs in it: a leftover worktree can
      // belong to a repository the project no longer points at (a repoint,
      // or the pre-fix scaffold), and rebasing against that repo's main is
      // exactly the wrong-tree work this check exists to stop.
      this.verifyDeveloperWorkspace(slug, workflowId);
      const currentMain = runGit(target, ["rev-parse", "main"]);
      const mergeBase = runGit(target, ["merge-base", "main", "HEAD"]);
      if (mergeBase !== currentMain) {
        const changes = runGit(target, ["status", "--porcelain"]);
        if (changes) throw new Error("cannot synchronize a dirty Developer workspace with current local main");
        try {
          runGit(target, ["rebase", "main"]);
        } catch (error) {
          try { runGit(target, ["rebase", "--abort"]); } catch { /* best-effort cleanup */ }
          throw error;
        }
      }
      return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    runGit(projectPath, ["worktree", "add", "-b", `hive/work-${workflowId}`, target, "main"]);
    this.verifyDeveloperWorkspace(slug, workflowId);
    return target;
  }

  /**
   * The Developer workspace must be a registered worktree of the project's
   * configured repository, on its own work branch. Work item #15 cycle 2
   * committed a correct change into the wrong repository and reported success;
   * this is the check that turns that silence into a blocked run.
   */
  verifyDeveloperWorkspace(slug: string, workflowId: number): string {
    assertSlug(slug);
    const projectPath = this.projectPath(slug);
    this.assertManagedDirectory(projectPath, "project");
    const target = path.join(this.runPath(workflowId), "developer");
    const developerPath = this.assertManagedDirectory(target, "Developer workspace");
    const commonDirectory = fs.realpathSync(path.resolve(developerPath, runGit(developerPath, ["rev-parse", "--git-common-dir"])));
    const expectedCommonDirectory = fs.realpathSync(path.join(projectPath, ".git"));
    if (commonDirectory !== expectedCommonDirectory) {
      throw new Error(
        `Developer workspace belongs to ${commonDirectory}, not the configured project repository ${projectPath} — `
        + "refusing to build in the wrong tree",
      );
    }
    const worktreeFields = runGit(projectPath, ["worktree", "list", "--porcelain", "-z"]).split("\0");
    if (!worktreeFields.includes(`worktree ${developerPath}`)) {
      throw new Error("Developer workspace is not a registered worktree of the configured project repository");
    }
    const branch = runGit(developerPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== `hive/work-${workflowId}`) {
      throw new Error(`Developer workspace is on branch ${branch}, expected hive/work-${workflowId}`);
    }
    return developerPath;
  }

  /**
   * Give back a finished work item's checkouts.
   *
   * A run directory is a full checkout plus whatever the build installed into
   * it, so it is measured in gigabytes; nothing ever removed one, and a year of
   * work items would bury the disk. Only ever called for an item that has
   * reached a terminal state — a blocked or retried item keeps its Developer
   * workspace, because uncommitted work still on disk is how it resumes.
   */
  releaseRunWorkspaces(slug: string, workflowId: number): void {
    assertSlug(slug);
    const runPath = path.join(this.managedBase("runs"), String(workflowId));
    if (!fs.existsSync(runPath)) return;
    let projectPath: string | undefined;
    try {
      projectPath = this.projectPath(slug);
    } catch {
      // A repointed or deleted repository cannot deregister its worktrees;
      // the directory still has to go.
    }
    for (const role of ["developer", "tester"]) {
      const target = path.join(runPath, role);
      if (!fs.existsSync(target)) continue;
      if (projectPath && fs.existsSync(path.join(projectPath, ".git"))) {
        try {
          runGit(projectPath, ["worktree", "remove", "--force", target]);
        } catch { /* falls through to the unlink below */ }
      }
    }
    makeWritable(runPath);
    fs.rmSync(runPath, { recursive: true, force: true });
    if (projectPath && fs.existsSync(path.join(projectPath, ".git"))) {
      try { runGit(projectPath, ["worktree", "prune"]); } catch { /* best-effort */ }
      // The work branch is redundant once its commit is merged into main, and
      // leaving it behind is its own slow leak — it also makes the run id
      // unusable, since a later worktree cannot recreate a branch that exists.
      try { runGit(projectPath, ["branch", "-D", `hive/work-${workflowId}`]); } catch { /* never existed, or already gone */ }
    }
  }

  /**
   * Run directories whose repository no longer exists — left behind by a
   * deleted or repointed project. Git cannot even read them, so they are dead
   * weight that only grows; swept at startup rather than waiting for someone
   * to notice the disk.
   */
  pruneOrphanedRuns(): Array<{ workflowId: number; path: string }> {
    const runsRoot = this.managedBase("runs");
    const removed: Array<{ workflowId: number; path: string }> = [];
    for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(runsRoot, entry.name);
      const checkouts = ["developer", "tester"]
        .map((role) => path.join(runPath, role))
        .filter((target) => fs.existsSync(target));
      // A run with no checkout at all is bookkeeping, not gigabytes; leave it.
      if (checkouts.length === 0) continue;
      // Orphaned only when every checkout is unreadable. A live run mid-flight
      // answers this fine, so an active work item is never swept.
      const orphaned = checkouts.every((target) => {
        try {
          runGit(target, ["rev-parse", "--git-dir"]);
          return false;
        } catch {
          return true;
        }
      });
      if (!orphaned) continue;
      makeWritable(runPath);
      fs.rmSync(runPath, { recursive: true, force: true });
      removed.push({ workflowId: Number(entry.name), path: runPath });
    }
    return removed;
  }

  knowledgePath(): string {
    return this.assertManagedDirectory(path.join(this.root, "knowledge"), "knowledge directory");
  }

  /** Uploaded reference images; build agents get read access when a frozen plan carries them. */
  attachmentsPath(): string {
    const target = path.join(this.root, "system", "attachments");
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  projectCommit(slug: string): string {
    assertSlug(slug);
    const projectPath = this.projectPath(slug);
    this.assertManagedDirectory(projectPath, "project");
    return runGit(projectPath, ["rev-parse", "HEAD"]);
  }

  /**
   * Files a killed Developer left behind. The worktree survives a backend
   * restart, so uncommitted changes here mean an interrupted run whose work is
   * still on disk — the next Developer continues it instead of starting over.
   */
  developerWorkspaceChanges(workflowId: number): string[] {
    const target = path.join(this.runPath(workflowId), "developer");
    this.assertManagedDirectory(target, "Developer workspace");
    return runGit(target, ["status", "--porcelain"])
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((entry) => entry.length > 0);
  }

  developerWorkspaceCommit(workflowId: number): string {
    const target = path.join(this.runPath(workflowId), "developer");
    this.assertManagedDirectory(target, "Developer workspace");
    return runGit(target, ["rev-parse", "HEAD"]);
  }

  /** Where the promoted project lives on disk, for user-facing notifications. */
  projectLocation(slug: string): string {
    assertSlug(slug);
    return this.projectPath(slug);
  }

  /** Human-readable change stats for one commit ("4 files changed, 120 insertions(+), 15 deletions(-)"). */
  commitStats(workflowId: number, commit: string): string {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return "change stats unavailable";
    try {
      const target = path.join(this.runPath(workflowId), "developer");
      this.assertManagedDirectory(target, "Developer workspace");
      return runGit(target, ["show", "--shortstat", "--format=", commit]).trim() || "no tracked changes";
    } catch {
      return "change stats unavailable";
    }
  }

  createTesterWorkspace(slug: string, workflowId: number, commit: string): string {
    assertSlug(slug);
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error("valid commit SHA required");
    const projectPath = this.projectPath(slug);
    this.assertManagedDirectory(projectPath, "project");
    try {
      runGit(projectPath, ["cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      // Happens when a work item frozen mid-flight resumes after the project
      // was repointed: its recorded commit lives in the old repository.
      throw new Error(`commit ${commit} does not exist in the configured project repository ${projectPath}`);
    }
    const target = path.join(this.runPath(workflowId), "tester");
    if (fs.existsSync(target)) {
      this.assertManagedDirectory(target, "Tester workspace");
      makeWritable(target);
      runGit(projectPath, ["worktree", "remove", "--force", target]);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    runGit(projectPath, ["worktree", "add", "--detach", target, commit]);
    this.verifyTesterCheckout(slug, workflowId, commit);
    return target;
  }

  verifyTesterCheckout(slug: string, workflowId: number, commit: string): void {
    assertSlug(slug);
    const projectPath = this.projectPath(slug);
    this.assertManagedDirectory(projectPath, "project");
    const target = path.join(this.runPath(workflowId), "tester");
    const testerPath = this.assertManagedDirectory(target, "Tester workspace");
    const commonDirectory = fs.realpathSync(path.resolve(testerPath, runGit(testerPath, ["rev-parse", "--git-common-dir"])));
    const expectedCommonDirectory = fs.realpathSync(path.join(projectPath, ".git"));
    if (commonDirectory !== expectedCommonDirectory) throw new Error("Tester checkout is not attached to the managed project");
    const worktreeFields = runGit(projectPath, ["worktree", "list", "--porcelain", "-z"]).split("\0");
    if (!worktreeFields.includes(`worktree ${testerPath}`)) throw new Error("Tester checkout is not a registered managed worktree");
    const actual = runGit(target, ["rev-parse", "HEAD"]);
    if (actual !== commit) throw new Error(`Tester checkout drifted from exact commit ${commit}`);
    if (runGit(target, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD") {
      throw new Error("Tester checkout must be a detached worktree");
    }
    const trackedChanges = runGit(target, ["status", "--porcelain", "--untracked-files=no"]);
    if (trackedChanges) throw new Error("Tester modified tracked source; test result is invalid");
  }

  commitDeveloperChanges(slug: string, workflowId: number, message: string): string {
    assertSlug(slug);
    const target = this.verifyDeveloperWorkspace(slug, workflowId);
    runGit(target, ["add", "-A"]);
    const staged = runGit(target, ["diff", "--cached", "--name-only"]);
    if (staged) runGit(target, ["commit", "-m", message]);
    return runGit(target, ["rev-parse", "HEAD"]);
  }

  projectExists(slug: string): boolean {
    assertSlug(slug);
    return fs.existsSync(path.join(this.projectPath(slug), ".git"));
  }

  promotePassingCommit(slug: string, commit: string): void {
    assertSlug(slug);
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error("valid commit SHA required");
    const projectPath = this.projectPath(slug);
    runGit(projectPath, ["cat-file", "-e", `${commit}^{commit}`]);
    runGit(projectPath, ["merge", "--ff-only", commit]);
  }

  testerWorkspacePath(workflowId: number): string {
    return path.join(this.runPath(workflowId), "tester");
  }

  /**
   * Without a commit this is the work item's evidence root. With one it is a
   * per-commit subdirectory, which is how the Tester stops adjudicating a
   * mixture of two builds: receipts were already keyed by commit while
   * screenshots collided by filename across cycles, so a pre-fix capture sat
   * under the canonical name beside a receipt saying fixed.
   */
  evidencePath(workflowId: number, commit?: string): string {
    const root = this.managedWorkflowDirectory("evidence", workflowId);
    if (commit === undefined) return root;
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error("valid commit SHA required");
    const target = path.join(root, commit.slice(0, 12));
    if (!fs.existsSync(target)) fs.mkdirSync(target);
    return this.assertManagedDirectory(target, "evidence commit directory");
  }

  artifactPath(workflowId: number): string {
    return this.managedWorkflowDirectory("artifacts", workflowId);
  }

  private projectPath(slug: string): string {
    assertSlug(slug);
    const managedSlot = path.join(this.managedBase("projects"), slug);
    const configured = this.resolveProjectPath?.(slug);
    if (configured === undefined) return managedSlot;
    if (!path.isAbsolute(configured)) {
      throw new Error(`project ${slug} has a non-absolute repository path: ${configured}`);
    }
    // Canonicalized before classifying: the stored path may reach the managed
    // slot through a symlinked prefix while this.root is already a realpath.
    // Operator configuration is trusted enough to normalize; the symlink-free
    // rule still applies to every directory the canonical path names.
    const canonical = canonicalize(path.resolve(configured));
    if (canonical === managedSlot) return managedSlot;
    // A configured path is an explicit allowlist entry for one external
    // repository. Inside the workspace only the managed slot is legitimate —
    // anything else (runs/, another project's slot) is a misconfiguration —
    // and a path containing the workspace (/, the home directory) would hand
    // agents the workspace's own internals.
    if (isWithin(canonical, this.root)) {
      throw new Error(`project ${slug} repository path ${canonical} is inside the managed workspace but is not its managed slot`);
    }
    if (isWithin(this.root, canonical)) {
      throw new Error(`project ${slug} repository path ${canonical} contains the managed workspace`);
    }
    return canonical;
  }

  private runPath(workflowId: number): string {
    return this.managedWorkflowDirectory("runs", workflowId);
  }

  private managedWorkflowDirectory(category: "runs" | "evidence" | "artifacts", workflowId: number): string {
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new Error("valid workflow id required");
    const target = path.join(this.managedBase(category), String(workflowId));
    if (!fs.existsSync(target)) fs.mkdirSync(target);
    return this.assertManagedDirectory(target, `${category} workflow directory`);
  }

  private managedBase(category: "projects" | "runs" | "evidence" | "artifacts"): string {
    return this.assertManagedDirectory(path.join(this.root, category), `${category} directory`);
  }

  private assertManagedDirectory(target: string, label: string): string {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
    const real = fs.realpathSync(target);
    if (real !== path.resolve(target)) throw new Error(`${label} escaped the managed workspace`);
    return real;
  }
}
