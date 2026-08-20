import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupGuard,
  evaluateBackup,
  readRepositoryState,
  type RepositoryState,
} from "../src/runtime/backup-guard.js";

const clean = (slug: string): RepositoryState => ({ slug, uncommitted: 0, unpushed: 0 });

describe("backup guard", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("names what is exposed and where", () => {
    const decision = evaluateBackup(
      [clean("ebb"), { slug: "reps", uncommitted: 9, unpushed: 2 }],
      false,
    );

    expect(decision.notify).toBe(true);
    expect(decision.message).toContain("reps: 9 uncommitted files, 2 unpushed commits");
    expect(decision.message).not.toContain("ebb");
  });

  it("says nothing when every repository is committed and pushed", () => {
    expect(evaluateBackup([clean("ebb"), clean("reps")], false).notify).toBe(false);
  });

  it("reminds once rather than every tick, and re-arms after the work is safe", () => {
    const exposed = [{ slug: "reps", uncommitted: 3, unpushed: 0 }];

    expect(evaluateBackup(exposed, true).notify).toBe(false);
    expect(evaluateBackup([clean("reps")], true).recovered).toBe(true);
    expect(evaluateBackup(exposed, false).notify).toBe(true);
  });

  it("treats a repository with no remote as at risk once it has uncommitted work", () => {
    expect(evaluateBackup([{ slug: "solo", uncommitted: 1, unpushed: null }], false).notify).toBe(true);
    // Committed, no remote: nothing this guard can claim is unsafe without an
    // upstream to compare against, so it stays quiet rather than crying wolf.
    expect(evaluateBackup([{ slug: "solo", uncommitted: 0, unpushed: null }], false).notify).toBe(false);
  });

  it("reads real uncommitted state from a repository on disk", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "hive-backup-"));
    roots.push(repository);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@local.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repository, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-m", "first");

    expect(readRepositoryState("demo", repository)).toEqual({ slug: "demo", uncommitted: 0, unpushed: null });

    fs.writeFileSync(path.join(repository, "b.txt"), "two\n");
    expect(readRepositoryState("demo", repository)?.uncommitted).toBe(1);
  });

  it("ignores a configured path that is not a repository instead of failing the tick", async () => {
    const messages: string[] = [];
    const guard = new BackupGuard(
      () => [{ slug: "ghost", repositoryPath: "/nowhere/at/all" }],
      async (message) => { messages.push(message); },
      60_000,
    );

    await guard.tick();

    expect(messages).toEqual([]);
  });

  it("does not repeat the reminder when delivery throws", async () => {
    let attempts = 0;
    const guard = new BackupGuard(
      () => [{ slug: "reps", repositoryPath: "/unused" }],
      async () => { attempts += 1; throw new Error("discord is down"); },
      60_000,
      () => ({ slug: "reps", uncommitted: 4, unpushed: 0 }),
    );

    await expect(guard.tick()).rejects.toThrow("discord is down");
    await guard.tick();

    expect(attempts).toBe(1);
  });
});
