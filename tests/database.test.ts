import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";

describe("database upgrades", () => {
  let database: HiveDatabase | undefined;
  const roots: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it("migrates persisted Claude 4.6 role assignments to exact Claude 5 models on reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-database-upgrade-"));
    roots.push(root);
    const databasePath = path.join(root, "hive-mind.sqlite");
    database = createDatabase(databasePath);
    const update = database.sqlite.prepare("UPDATE agents SET provider = 'claude', model = ? WHERE id = ?");
    update.run("claude-opus-4-6", "developer");
    update.run("claude-sonnet-4-6", "tester");
    database.close();
    database = undefined;

    database = createDatabase(databasePath);

    const assignments = database.sqlite.prepare(`
      SELECT id, provider, model FROM agents WHERE id IN ('developer', 'tester') ORDER BY sort_order
    `).all();
    expect(assignments).toEqual([
      { id: "developer", provider: "claude", model: "claude-opus-5" },
      { id: "tester", provider: "claude", model: "claude-sonnet-5" },
    ]);
  });

  it("retires findings left open on a work item the Tester already passed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-database-findings-"));
    roots.push(root);
    const databasePath = path.join(root, "hive-mind.sqlite");
    database = createDatabase(databasePath);
    database.sqlite.prepare("INSERT INTO projects (id, name, slug, workspace_path) VALUES (1, 'Ebb', 'ebb', ?)").run(root);
    database.sqlite.prepare(`
      INSERT INTO work_items (id, project_id, title, state, tested_commit) VALUES (1, 1, 'shipped', 'complete', 'd792ce745c87')
    `).run();
    database.sqlite.prepare(`
      INSERT INTO work_items (id, project_id, title, state) VALUES (2, 1, 'in flight', 'needs_fix')
    `).run();
    const insert = database.sqlite.prepare(`
      INSERT INTO findings (work_item_id, severity, title, expected, actual, steps_json, evidence_json)
      VALUES (?, 'blocker', ?, 'passes', 'did not', '[]', '[]')
    `);
    insert.run(1, "android-emulator target did not pass");
    insert.run(1, "Flow chips truncate at largest text size");
    insert.run(2, "android-emulator target did not pass");
    // A genuinely legacy database has none of the resolution columns; the
    // backfill only runs on the boot that adds them.
    for (const column of ["kind", "target", "found_commit", "resolved_at", "resolved_commit"]) {
      database.sqlite.exec(`ALTER TABLE findings DROP COLUMN ${column}`);
    }
    database.close();
    database = undefined;

    database = createDatabase(databasePath);

    const findings = database.sqlite.prepare(`
      SELECT work_item_id AS workItemId, kind, target, resolved_commit AS resolvedCommit FROM findings ORDER BY id
    `).all();
    expect(findings).toEqual([
      // A platform abort is recoverable from its generated title, and both of
      // the completed item's findings are closed against the commit that passed.
      { workItemId: 1, kind: "harness", target: "android-emulator", resolvedCommit: "d792ce745c87" },
      { workItemId: 1, kind: "product", target: null, resolvedCommit: "d792ce745c87" },
      // The item still in flight keeps its open finding: nothing has answered it.
      { workItemId: 2, kind: "harness", target: "android-emulator", resolvedCommit: null },
    ]);
  });

  it("leaves a finding recorded alongside a pass open across restarts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-database-advisory-"));
    roots.push(root);
    const databasePath = path.join(root, "hive-mind.sqlite");
    database = createDatabase(databasePath);
    database.sqlite.prepare("INSERT INTO projects (id, name, slug, workspace_path) VALUES (1, 'Ebb', 'ebb', ?)").run(root);
    database.sqlite.prepare(`
      INSERT INTO work_items (id, project_id, title, state, tested_commit) VALUES (1, 1, 'shipped', 'complete', 'd792ce745c87')
    `).run();
    // A defect the Tester filed alongside its passing verdict: recorded, not
    // blocking, and deliberately still open when the item completes.
    database.sqlite.prepare(`
      INSERT INTO findings (work_item_id, severity, kind, title, expected, actual, steps_json, evidence_json)
      VALUES (1, 'defect', 'product', 'Chips truncate at largest text size', 'wraps', 'clips', '[]', '[]')
    `).run();
    database.close();
    database = undefined;

    database = createDatabase(databasePath);

    // The backfill must not touch a modern row: nothing addressed this
    // finding, so no restart may stamp it resolved.
    const finding = database.sqlite.prepare(
      "SELECT resolved_at AS resolvedAt, resolved_commit AS resolvedCommit FROM findings WHERE work_item_id = 1",
    ).get();
    expect(finding).toEqual({ resolvedAt: null, resolvedCommit: null });
  });

  it("rebuilds agent_runs so work_item_id accepts NULL, keeping existing rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-database-brain-runs-"));
    roots.push(root);
    const databasePath = path.join(root, "hive-mind.sqlite");
    // A production-shaped legacy database: work_item_id NOT NULL, with the
    // cost/duration columns ALTER-appended after error as they historically were.
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL, accepted_commit TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft_plan', approved_plan_id INTEGER, developer_commit TEXT,
        tested_commit TEXT, cycle_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER NOT NULL REFERENCES work_items(id),
        role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT, restart_count INTEGER NOT NULL DEFAULT 0, error TEXT, cost_usd REAL, duration_ms INTEGER);
      INSERT INTO projects (name, slug, workspace_path) VALUES ('Ebb', 'ebb', '/tmp/ebb');
      INSERT INTO work_items (project_id, title) VALUES (1, 'v1');
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status, cost_usd)
        VALUES (1, 'developer', 'claude', 'claude-opus-5', 'high', 'done', 29.61);
    `);
    legacy.close();

    database = createDatabase(databasePath);

    const kept = database.sqlite.prepare(
      "SELECT id, work_item_id AS workItemId, role, cost_usd AS costUsd FROM agent_runs",
    ).get();
    expect(kept).toEqual({ id: 1, workItemId: 1, role: "developer", costUsd: 29.61 });
    // The point of the rebuild: a brain turn has no work item.
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run();
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 2 });
  });
});
