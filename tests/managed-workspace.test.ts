import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedWorkspace } from "../src/projects/managed-workspace.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

describe("managed project workspace", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => {
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }));

  it("isolates Developer and Tester and promotes only the tested commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);

    const project = workspace.createProject("pocket-tasks", "Pocket Tasks");
    expect(fs.existsSync(path.join(project, ".git"))).toBe(true);
    expect(git(project, "branch", "--show-current")).toBe("main");

    const developer = workspace.createDeveloperWorkspace("pocket-tasks", 7);
    fs.writeFileSync(path.join(developer, "app.txt"), "working app\n");
    git(developer, "add", "app.txt");
    git(developer, "commit", "-m", "feat: working app");
    const commit = git(developer, "rev-parse", "HEAD");

    const tester = workspace.createTesterWorkspace("pocket-tasks", 7, commit);
    expect(git(tester, "rev-parse", "HEAD")).toBe(commit);
    fs.writeFileSync(path.join(tester, "test-output.txt"), "allowed untracked artifact");
    expect(() => workspace.verifyTesterCheckout("pocket-tasks", 7, commit)).not.toThrow();
    fs.writeFileSync(path.join(tester, "app.txt"), "tester changed source\n");
    expect(() => workspace.verifyTesterCheckout("pocket-tasks", 7, commit)).toThrow(/modified tracked source/i);
    git(tester, "checkout", "--", "app.txt");

    workspace.promotePassingCommit("pocket-tasks", commit);
    expect(git(project, "rev-parse", "main")).toBe(commit);
    expect(fs.readFileSync(path.join(project, "app.txt"), "utf8")).toBe("working app\n");
  });

  it("rebases a clean retried Developer workspace onto the current local main", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-retry-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    const project = workspace.createProject("retry-app", "Retry App");

    const staleDeveloper = workspace.createDeveloperWorkspace("retry-app", 1);
    fs.writeFileSync(path.join(staleDeveloper, "first.txt"), "first workflow\n");
    const staleCommit = workspace.commitDeveloperChanges("retry-app", 1, "feat: first workflow");

    const otherDeveloper = workspace.createDeveloperWorkspace("retry-app", 2);
    fs.writeFileSync(path.join(otherDeveloper, "second.txt"), "second workflow\n");
    const currentMainCommit = workspace.commitDeveloperChanges("retry-app", 2, "feat: second workflow");
    workspace.promotePassingCommit("retry-app", currentMainCommit);
    expect(git(project, "rev-parse", "main")).toBe(currentMainCommit);

    const retriedDeveloper = workspace.createDeveloperWorkspace("retry-app", 1);
    const rebasedCommit = git(retriedDeveloper, "rev-parse", "HEAD");
    expect(rebasedCommit).not.toBe(staleCommit);
    expect(fs.readFileSync(path.join(retriedDeveloper, "second.txt"), "utf8")).toBe("second workflow\n");
    expect(() => workspace.promotePassingCommit("retry-app", rebasedCommit)).not.toThrow();
    expect(git(project, "rev-parse", "main")).toBe(rebasedCommit);
  });

  it("does not chmod files outside a Tester checkout through tracked symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-symlink-"));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hive-external-mode-"));
    roots.push(root, externalRoot);
    const externalFile = path.join(externalRoot, "private.txt");
    fs.writeFileSync(externalFile, "private\n", { mode: 0o600 });
    fs.chmodSync(externalFile, 0o600);
    const workspace = new ManagedWorkspace(root);
    workspace.createProject("symlink-app", "Symlink App");
    const developer = workspace.createDeveloperWorkspace("symlink-app", 3);
    fs.symlinkSync(externalFile, path.join(developer, "external-link"));
    const commit = workspace.commitDeveloperChanges("symlink-app", 3, "test: add tracked symlink");
    workspace.createTesterWorkspace("symlink-app", 3, commit);

    workspace.createTesterWorkspace("symlink-app", 3, commit);

    expect(fs.statSync(externalFile).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked Developer checkout as the Tester workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-symlinked-tester-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    workspace.createProject("demo", "Demo");
    const developer = workspace.createDeveloperWorkspace("demo", 1);
    fs.writeFileSync(path.join(developer, "feature.txt"), "done\n");
    const commit = workspace.commitDeveloperChanges("demo", 1, "feature");
    fs.symlinkSync(developer, path.join(workspace.root, "runs", "1", "tester"), "dir");

    expect(() => workspace.verifyTesterCheckout("demo", 1, commit)).toThrow("Tester workspace must be a real directory");
    expect(() => workspace.createTesterWorkspace("demo", 1, commit)).toThrow("Tester workspace must be a real directory");
  });

  it("rejects an unrelated detached clone as the Tester workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-impostor-tester-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    const project = workspace.createProject("demo", "Demo");
    const developer = workspace.createDeveloperWorkspace("demo", 1);
    fs.writeFileSync(path.join(developer, "feature.txt"), "done\n");
    const commit = workspace.commitDeveloperChanges("demo", 1, "feature");
    const tester = path.join(workspace.root, "runs", "1", "tester");
    git(path.dirname(tester), "clone", project, tester);
    git(tester, "checkout", "--detach", commit);

    expect(() => workspace.verifyTesterCheckout("demo", 1, commit)).toThrow("Tester checkout is not attached to the managed project");
  });

  it("rejects path traversal in project slugs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    expect(() => workspace.createProject("../outside", "Nope")).toThrow(/slug/i);
  });

  it("reclaims a finished work item's checkouts and leaves the project intact", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-release-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    const project = workspace.createProject("tidy-app", "Tidy App");

    const developer = workspace.createDeveloperWorkspace("tidy-app", 21);
    fs.writeFileSync(path.join(developer, "feature.txt"), "done\n");
    const commit = workspace.commitDeveloperChanges("tidy-app", 21, "feat: done");
    workspace.createTesterWorkspace("tidy-app", 21, commit);
    workspace.promotePassingCommit("tidy-app", commit);

    workspace.releaseRunWorkspaces("tidy-app", 21);

    expect(fs.existsSync(path.join(root, "runs", "21"))).toBe(false);
    // The work survives in the project; only the duplicate checkouts go.
    expect(git(project, "rev-parse", "main")).toBe(commit);
    expect(fs.readFileSync(path.join(project, "feature.txt"), "utf8")).toBe("done\n");
    // And git no longer believes those worktrees exist, so the slot is reusable.
    expect(git(project, "worktree", "list")).not.toContain("runs/21");
    expect(() => workspace.createDeveloperWorkspace("tidy-app", 21)).not.toThrow();
  });

  it("sweeps run directories whose repository is gone, and spares live ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-sweep-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    workspace.createProject("live-app", "Live App");
    workspace.createDeveloperWorkspace("live-app", 5);

    const doomed = workspace.createProject("doomed-app", "Doomed App");
    workspace.createDeveloperWorkspace("doomed-app", 9);
    // The project is deleted out from under its worktree — a repoint, or the
    // scaffold that should never have existed being removed.
    fs.rmSync(doomed, { recursive: true, force: true });

    const removed = workspace.pruneOrphanedRuns();

    expect(removed.map((run) => run.workflowId)).toEqual([9]);
    expect(fs.existsSync(path.join(root, "runs", "9"))).toBe(false);
    // An in-flight run answers git fine and must never be swept.
    expect(fs.existsSync(path.join(root, "runs", "5", "developer"))).toBe(true);
  });

  it("ignores dependencies and build output from the very first commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-ignore-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    workspace.createProject("clean-app", "Clean App");

    const developer = workspace.createDeveloperWorkspace("clean-app", 2);
    fs.mkdirSync(path.join(developer, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(developer, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    fs.mkdirSync(path.join(developer, "android", "app", "build"), { recursive: true });
    fs.writeFileSync(path.join(developer, "android", "app", "build", "app.apk"), "binary");
    fs.writeFileSync(path.join(developer, ".env"), "SECRET=hunter2\n");
    fs.writeFileSync(path.join(developer, "App.tsx"), "export default null;\n");

    workspace.commitDeveloperChanges("clean-app", 2, "feat: first build");
    const tracked = git(developer, "ls-files");

    expect(tracked).toContain("App.tsx");
    expect(tracked).not.toContain("node_modules");
    expect(tracked).not.toContain(".apk");
    expect(tracked).not.toContain(".env");
  });

  function externalRepository(prefix: string): string {
    // realpath: /tmp and /var are symlinks on macOS, and configured
    // repository paths must be symlink-free like every managed path.
    const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    roots.push(repository);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Owner");
    git(repository, "config", "user.email", "owner@local.invalid");
    fs.writeFileSync(path.join(repository, "app.txt"), "original\n");
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "chore: pre-existing history");
    return repository;
  }

  it("builds, tests, and promotes inside an externally configured repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-external-"));
    roots.push(root);
    const external = externalRepository("hive-external-repo-");
    const baseline = git(external, "rev-parse", "HEAD");
    const workspace = new ManagedWorkspace(root, (slug) => (slug === "old-app" ? external : undefined));

    expect(workspace.projectExists("old-app")).toBe(true);
    expect(workspace.projectLocation("old-app")).toBe(external);

    const developer = workspace.createDeveloperWorkspace("old-app", 4);
    fs.writeFileSync(path.join(developer, "feature.txt"), "new feature\n");
    const commit = workspace.commitDeveloperChanges("old-app", 4, "feat: new feature");

    const tester = workspace.createTesterWorkspace("old-app", 4, commit);
    expect(git(tester, "rev-parse", "HEAD")).toBe(commit);
    expect(() => workspace.verifyTesterCheckout("old-app", 4, commit)).not.toThrow();

    workspace.promotePassingCommit("old-app", commit);
    expect(git(external, "rev-parse", "main")).toBe(commit);
    expect(git(external, "rev-parse", `${commit}~1`)).toBe(baseline);
    expect(fs.readFileSync(path.join(external, "feature.txt"), "utf8")).toBe("new feature\n");
  });

  it("never scaffolds a configured external repository path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-noscaffold-"));
    const externalParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-external-missing-")));
    roots.push(root, externalParent);
    const missing = path.join(externalParent, "moved-away");
    const workspace = new ManagedWorkspace(root, () => missing);

    expect(workspace.projectExists("old-app")).toBe(false);
    expect(() => workspace.createProject("old-app", "Old App")).toThrow(/refusing to scaffold/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("refuses to initialize the managed slot over existing files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-occupied-"));
    roots.push(root);
    const workspace = new ManagedWorkspace(root);
    const slot = path.join(workspace.root, "projects", "occupied");
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, "code.txt"), "precious\n");

    expect(() => workspace.createProject("occupied", "Occupied")).toThrow(/non-empty/);
    expect(fs.readFileSync(path.join(slot, "code.txt"), "utf8")).toBe("precious\n");

    fs.mkdirSync(path.join(workspace.root, "projects", "empty-slot"));
    expect(() => workspace.createProject("empty-slot", "Empty Slot")).not.toThrow();
  });

  it("rejects configured paths inside the workspace or containing it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-containment-"));
    roots.push(root);
    const insideWorkspace = new ManagedWorkspace(root, () => path.join(fs.realpathSync(root), "runs"));
    expect(() => insideWorkspace.projectLocation("app")).toThrow(/inside the managed workspace/);

    const containsWorkspace = new ManagedWorkspace(root, () => path.dirname(fs.realpathSync(root)));
    expect(() => containsWorkspace.projectLocation("app")).toThrow(/contains the managed workspace/);
  });

  it("blocks a Developer workspace attached to a repository the project no longer points at", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-workspace-repoint-"));
    roots.push(root);
    const originalRepository = externalRepository("hive-external-original-");
    const repointedRepository = externalRepository("hive-external-repointed-");
    const configured = new Map([["app", originalRepository]]);
    const workspace = new ManagedWorkspace(root, (slug) => configured.get(slug));

    const developer = workspace.createDeveloperWorkspace("app", 9);
    fs.writeFileSync(path.join(developer, "feature.txt"), "built here\n");

    configured.set("app", repointedRepository);
    expect(() => workspace.commitDeveloperChanges("app", 9, "feat: wrong tree")).toThrow(/wrong tree/);
    expect(() => workspace.createDeveloperWorkspace("app", 9)).toThrow(/wrong tree/);
    expect(git(repointedRepository, "rev-parse", "main")).toBe(git(repointedRepository, "rev-parse", "HEAD"));
  });
});
