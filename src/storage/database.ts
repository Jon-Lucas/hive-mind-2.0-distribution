import Database from "better-sqlite3";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  accepted_commit TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft_plan',
  approved_plan_id INTEGER,
  developer_commit TEXT,
  tested_commit TEXT,
  blocked_stage TEXT,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  test_targets_json TEXT NOT NULL,
  reference_images_json TEXT NOT NULL DEFAULT '[]',
  frozen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(work_item_id, version)
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plan_versions(id),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(plan_id, ordinal)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  severity TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product',
  target TEXT,
  title TEXT NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  found_commit TEXT,
  resolved_at TEXT,
  resolved_commit TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER REFERENCES work_items(id),
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export interface HiveDatabase {
  sqlite: Database.Database;
  close(): void;
}

export function createDatabase(path: string): HiveDatabase {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(SCHEMA);
  const criterionColumns = sqlite.pragma("table_info(acceptance_criteria)") as Array<{ name: string }>;
  if (!criterionColumns.some((column) => column.name === "evidence_json")) {
    sqlite.exec("ALTER TABLE acceptance_criteria ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'");
  }
  // Providers report cost and duration per run; record them so spend is
  // visible and enforceable rather than discovered after the fact.
  const runColumns = sqlite.pragma("table_info(agent_runs)") as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "cost_usd")) {
    sqlite.exec("ALTER TABLE agent_runs ADD COLUMN cost_usd REAL");
  }
  if (!runColumns.some((column) => column.name === "duration_ms")) {
    sqlite.exec("ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER");
  }
  // Brain conversation turns are runs with no work item, so work_item_id must
  // accept NULL. SQLite cannot drop NOT NULL in place; rebuild the table once.
  // Runs after the ALTERs above so every copied database has every column.
  const workItemIdRequired = (sqlite.pragma("table_info(agent_runs)") as Array<{ name: string; notnull: number }>)
    .some((column) => column.name === "work_item_id" && column.notnull === 1);
  if (workItemIdRequired) {
    sqlite.exec(`
      BEGIN;
      CREATE TABLE agent_runs_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER REFERENCES work_items(id),
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        duration_ms INTEGER,
        error TEXT
      );
      INSERT INTO agent_runs_rebuilt (id, work_item_id, role, provider, model, effort, status,
        started_at, last_activity_at, finished_at, restart_count, cost_usd, duration_ms, error)
        SELECT id, work_item_id, role, provider, model, effort, status,
          started_at, last_activity_at, finished_at, restart_count, cost_usd, duration_ms, error
        FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_rebuilt RENAME TO agent_runs;
      COMMIT;
    `);
  }
  // Which pipeline stage a blocked work item failed in, so retry can resume
  // from the checkpoint instead of always rebuilding from scratch.
  const itemColumns = sqlite.pragma("table_info(work_items)") as Array<{ name: string }>;
  if (!itemColumns.some((column) => column.name === "blocked_stage")) {
    sqlite.exec("ALTER TABLE work_items ADD COLUMN blocked_stage TEXT");
  }
  // Reference images attached to a chat message, as [{file, name, mime}].
  const messageColumns = sqlite.pragma("table_info(messages)") as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "attachments_json")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
  }
  // Reference images frozen with a plan, as [{file, name}], so build agents
  // receive them with the spec instead of digging through chat history.
  const planColumns = sqlite.pragma("table_info(plan_versions)") as Array<{ name: string }>;
  if (!planColumns.some((column) => column.name === "reference_images_json")) {
    sqlite.exec("ALTER TABLE plan_versions ADD COLUMN reference_images_json TEXT NOT NULL DEFAULT '[]'");
  }
  // A finding used to live forever: the Developer prompt pulled every blocking
  // finding a work item had ever collected, so fixed defects and dead-commit
  // harness aborts came back as live work cycle after cycle. These columns are
  // what lets a finding close, and what separates a product defect the
  // Developer must fix from a platform run that simply did not complete.
  const findingColumns = sqlite.pragma("table_info(findings)") as Array<{ name: string }>;
  const addFindingColumn = (name: string, definition: string): void => {
    if (!findingColumns.some((column) => column.name === name)) {
      sqlite.exec(`ALTER TABLE findings ADD COLUMN ${name} ${definition}`);
    }
  };
  // The backfill runs once, on the boot that adds the resolution columns —
  // never again. Rows written after that are live policy, not legacy debris:
  // an advisory finding recorded alongside a passing verdict stays open on
  // purpose, and re-running the backfill every boot stamped it "resolved" at
  // a commit that never addressed it.
  const findingsPredateResolution = !findingColumns.some((column) => column.name === "resolved_at");
  addFindingColumn("kind", "TEXT NOT NULL DEFAULT 'product'");
  addFindingColumn("target", "TEXT");
  addFindingColumn("found_commit", "TEXT");
  addFindingColumn("resolved_at", "TEXT");
  addFindingColumn("resolved_commit", "TEXT");
  if (findingsPredateResolution) backfillHarnessFindings(sqlite);
  seedAgents(sqlite);
  migrateLegacyAgentModels(sqlite);
  migrateLegacyAgentEfforts(sqlite);
  return { sqlite, close: () => sqlite.close() };
}

/**
 * Existing rows predate the kind/target split. A platform abort has always been
 * written with the same generated title, so it is recoverable; and a finding
 * still open on a work item the Tester already passed cannot be live work, so
 * close it against the commit that passed rather than leaving it to be handed
 * to the next Developer as a punch-list item.
 */
function backfillHarnessFindings(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE findings
      SET kind = 'harness', target = REPLACE(title, ' target did not pass', '')
      WHERE kind = 'product' AND title LIKE '% target did not pass'
    `).run();
    sqlite.prepare(`
      UPDATE findings
      SET resolved_at = CURRENT_TIMESTAMP,
          resolved_commit = (SELECT tested_commit FROM work_items WHERE id = findings.work_item_id)
      WHERE resolved_at IS NULL
        AND work_item_id IN (SELECT id FROM work_items WHERE state = 'complete')
    `).run();
  });
  migrate();
}

function seedAgents(sqlite: Database.Database): void {
  const insert = sqlite.prepare(`
    INSERT INTO agents (id, name, role, status, provider, model, effort, sort_order)
    VALUES (?, ?, ?, 'idle', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const seed = sqlite.transaction(() => {
    insert.run("brain", "Brain", "Plans, delegates, and talks with you", "openai", "gpt-5.6-sol", "high", 1);
    insert.run("developer", "Backend Developer", "Builds the approved plan's logic and data", "openai", "gpt-5.6-sol", "high", 2);
    insert.run("frontend", "Frontend Developer", "Builds and polishes the interface", "claude", "claude-opus-5", "high", 3);
    insert.run("tester", "Tester", "Tests every accepted behavior", "openai", "gpt-5.5", "high", 4);
    // Existing databases already hold the old developer/tester rows, which
    // ON CONFLICT leaves untouched — bring their labels and ordering along.
    sqlite.prepare("UPDATE agents SET name = 'Backend Developer', role = 'Builds the approved plan''s logic and data' WHERE id = 'developer' AND name = 'Developer'").run();
    sqlite.prepare("UPDATE agents SET sort_order = 4 WHERE id = 'tester' AND sort_order = 3").run();
  });
  seed();
}

/**
 * "maximum" used to be one slot meaning xhigh on OpenAI and max on Claude.
 * Those are separate selectable levels now, so settle stored rows onto the
 * level their provider actually ran.
 */
function migrateLegacyAgentEfforts(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.prepare("UPDATE agents SET effort = 'xhigh' WHERE effort = 'maximum' AND provider = 'openai'").run();
    sqlite.prepare("UPDATE agents SET effort = 'max' WHERE effort = 'maximum' AND provider = 'claude'").run();
  });
  migrate();
}

function migrateLegacyAgentModels(sqlite: Database.Database): void {
  const update = sqlite.prepare("UPDATE agents SET model = ? WHERE provider = 'claude' AND model = ?");
  const migrate = sqlite.transaction(() => {
    update.run("claude-opus-5", "claude-opus-4-6");
    update.run("claude-sonnet-5", "claude-sonnet-4-6");
  });
  migrate();
}
