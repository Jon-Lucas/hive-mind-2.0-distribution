import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HiveDatabase } from "../storage/database.js";
import { validateTestTargets } from "../tester/platform-driver.js";

export type WorkItemState =
  | "draft_plan"
  | "awaiting_plan_approval"
  | "ready_to_build"
  | "building"
  | "ready_to_test"
  | "testing"
  | "needs_fix"
  | "blocked"
  | "complete";

export class WorkflowConflictError extends Error {}

/**
 * Which pipeline stage a work item failed in. "tester" means the commit had
 * already been built and had passed the harness's own platform scripts — the
 * failure was confined to the Tester agent or its report, so a retry may
 * resume at ready_to_test instead of rebuilding.
 */
export type BlockStage = "developer" | "frontend" | "platform" | "tester" | "harness" | "cancelled";

export interface PlanReferenceImage {
  /** Stored filename inside the workspace attachments directory. */
  file: string;
  /** The user's original filename, display only. */
  name: string;
}

interface PlanInput {
  goal: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  testTargets: string[];
  referenceImages?: PlanReferenceImage[];
}

/**
 * `product` findings are defects in the thing being built; `harness` findings
 * are platform runs that did not complete. Both must reach the Developer, but
 * they expire on different evidence — a product defect is answered by the next
 * Tester verdict, a harness abort by the target passing — so they are stored
 * apart rather than mixed into one ever-growing punch list.
 */
export type FindingKind = "product" | "harness";

interface FindingInput {
  severity: "blocker" | "defect" | "suggestion";
  title: string;
  expected: string;
  actual: string;
  steps: string[];
  evidence: string[];
  kind?: FindingKind;
  /** Which platform target aborted; set on harness findings only. */
  target?: string;
}

function defaultWorkspaceRoot(): string {
  return process.env.HIVE_WORKSPACE?.trim() || path.join(os.homedir(), "HiveMindWorkspace");
}

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new WorkflowConflictError("project name must contain letters or numbers");
  return slug;
}

export class WorkflowService {
  constructor(
    private readonly database: HiveDatabase,
    private readonly workspaceRoot = defaultWorkspaceRoot(),
  ) {}

  listAgents(): Array<Record<string, unknown>> {
    return this.database.sqlite.prepare("SELECT * FROM agents ORDER BY sort_order").all() as Array<Record<string, unknown>>;
  }

  createProject(name: string, repositoryPath?: string): { id: number; name: string; slug: string } {
    const trimmed = name.trim();
    if (!trimmed) throw new WorkflowConflictError("project name is required");
    const slug = slugify(trimmed);
    const workspacePath = repositoryPath === undefined
      ? path.join(this.workspaceRoot, "projects", slug)
      : this.validatedRepositoryPath(slug, repositoryPath);
    let result;
    try {
      result = this.database.sqlite
        .prepare("INSERT INTO projects (name, slug, workspace_path) VALUES (?, ?, ?)")
        .run(trimmed, slug, workspacePath);
    } catch (error) {
      // A duplicate slug is a caller conflict, not an internal fault.
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new WorkflowConflictError(`project already exists: ${slug}`);
      }
      throw error;
    }
    this.event("project_created", "brain", { projectId: Number(result.lastInsertRowid), name: trimmed });
    return { id: Number(result.lastInsertRowid), name: trimmed, slug };
  }

  /**
   * An explicit repository path must already be a real git repository: the
   * studio never scaffolds outside its own workspace, so a typo here has to
   * fail at creation, not as a fresh empty app at first build.
   */
  private validatedRepositoryPath(slug: string, repositoryPath: string): string {
    let trimmed = repositoryPath.trim();
    // People naturally write "~/reps"; expand it rather than bounce them.
    if (trimmed === "~" || trimmed.startsWith("~/")) trimmed = path.join(os.homedir(), trimmed.slice(1));
    if (!path.isAbsolute(trimmed)) throw new WorkflowConflictError("repository path must be absolute");
    const resolved = path.resolve(trimmed);
    const managedSlot = path.join(this.workspaceRoot, "projects", slug);
    if (resolved !== managedSlot) {
      const relativeToWorkspace = path.relative(this.workspaceRoot, resolved);
      if (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)) {
        throw new WorkflowConflictError("repository path may not point inside the managed workspace");
      }
      const relativeFromRepository = path.relative(resolved, this.workspaceRoot);
      if (!relativeFromRepository.startsWith("..") && !path.isAbsolute(relativeFromRepository)) {
        throw new WorkflowConflictError("repository path may not contain the managed workspace");
      }
      if (!fs.existsSync(path.join(resolved, ".git"))) {
        throw new WorkflowConflictError(`repository path is not an existing git repository: ${resolved}`);
      }
      // Stored canonical so the workspace's symlink-free realpath checks hold.
      return fs.realpathSync(resolved);
    }
    return managedSlot;
  }

  /**
   * The stored path a createProject(name, repositoryPath) call would record,
   * without creating anything. Callers that need a bad path to become a
   * conversational reply instead of a crashed transaction validate here first.
   */
  resolveRepositoryPath(name: string, repositoryPath: string): string {
    return this.validatedRepositoryPath(slugify(name), repositoryPath);
  }

  /** Where this project's repository lives; the ManagedWorkspace path resolver. */
  projectWorkspacePath(slug: string): string | undefined {
    const row = this.database.sqlite
      .prepare("SELECT workspace_path FROM projects WHERE slug = ?")
      .get(slug) as { workspace_path: string } | undefined;
    return row?.workspace_path;
  }

  findProjectByName(name: string): { id: number; name: string; slug: string } | undefined {
    const slug = slugify(name);
    return this.database.sqlite.prepare("SELECT id, name, slug FROM projects WHERE slug = ?").get(slug) as
      { id: number; name: string; slug: string } | undefined;
  }

  getProject(id: number): { id: number; name: string; slug: string; workspacePath: string; acceptedCommit: string | null } {
    const row = this.database.sqlite
      .prepare("SELECT id, name, slug, workspace_path, accepted_commit FROM projects WHERE id = ?")
      .get(id) as { id: number; name: string; slug: string; workspace_path: string; accepted_commit: string | null } | undefined;
    if (!row) throw new WorkflowConflictError("project not found");
    return { id: row.id, name: row.name, slug: row.slug, workspacePath: row.workspace_path, acceptedCommit: row.accepted_commit };
  }

  createWorkItem(projectId: number, title: string): { id: number; projectId: number; title: string } {
    if (!this.getProject(projectId)) throw new WorkflowConflictError("project not found");
    const result = this.database.sqlite
      .prepare("INSERT INTO work_items (project_id, title) VALUES (?, ?)")
      .run(projectId, title.trim());
    return { id: Number(result.lastInsertRowid), projectId, title: title.trim() };
  }

  findPlanningWorkItem(projectId: number, title: string): { id: number; projectId: number; title: string } | undefined {
    const row = this.database.sqlite.prepare(`
      SELECT id, project_id, title FROM work_items
      WHERE project_id = ? AND title = ? COLLATE NOCASE AND state IN ('draft_plan', 'awaiting_plan_approval')
      ORDER BY id DESC LIMIT 1
    `).get(projectId, title.trim()) as { id: number; project_id: number; title: string } | undefined;
    return row ? { id: row.id, projectId: row.project_id, title: row.title } : undefined;
  }

  getWorkItem(id: number): { id: number; projectId: number; state: WorkItemState; developerCommit: string | null; testedCommit: string | null; blockedStage: BlockStage | null } {
    const row = this.database.sqlite.prepare(`
      SELECT id, project_id, state, developer_commit, tested_commit, blocked_stage FROM work_items WHERE id = ?
    `).get(id) as {
      id: number; project_id: number; state: WorkItemState; developer_commit: string | null; tested_commit: string | null;
      blocked_stage: BlockStage | null;
    } | undefined;
    if (!row) throw new WorkflowConflictError("work item not found");
    return {
      id: row.id,
      projectId: row.project_id,
      state: row.state,
      developerCommit: row.developer_commit,
      testedCommit: row.tested_commit,
      blockedStage: row.blocked_stage,
    };
  }

  createPlan(workItemId: number, input: PlanInput): { id: number; version: number; frozenAt: string | null } {
    const item = this.getWorkItem(workItemId);
    if (!["draft_plan", "awaiting_plan_approval"].includes(item.state)) {
      throw new WorkflowConflictError("cannot create a plan after work has started");
    }
    if (!input.goal.trim() || input.acceptanceCriteria.length === 0 || input.testTargets.length === 0) {
      throw new WorkflowConflictError("goal, acceptance criteria, and test targets are required");
    }
    // A bad target is the planner's mistake, not an internal fault: surface it
    // as a conflict so the operator sees which target was rejected.
    let testTargets;
    try {
      testTargets = validateTestTargets(input.testTargets);
    } catch (error) {
      throw new WorkflowConflictError(error instanceof Error ? error.message : String(error));
    }
    const result = this.database.sqlite.transaction(() => {
      const current = this.database.sqlite
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM plan_versions WHERE work_item_id = ?")
        .get(workItemId) as { version: number };
      const version = current.version + 1;
      const plan = this.database.sqlite.prepare(`
        INSERT INTO plan_versions (work_item_id, version, goal, assumptions_json, test_targets_json, reference_images_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        workItemId,
        version,
        input.goal.trim(),
        JSON.stringify(input.assumptions),
        JSON.stringify(testTargets),
        JSON.stringify(input.referenceImages ?? []),
      );
      const planId = Number(plan.lastInsertRowid);
      const criterion = this.database.sqlite.prepare(`
        INSERT INTO acceptance_criteria (plan_id, ordinal, text) VALUES (?, ?, ?)
      `);
      input.acceptanceCriteria.forEach((text, index) => criterion.run(planId, index + 1, text.trim()));
      this.database.sqlite.prepare(`
        UPDATE work_items SET state = 'awaiting_plan_approval', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(workItemId);
      return { id: planId, version, frozenAt: null };
    })();
    this.event("plan_drafted", "brain", { workItemId, planId: result.id, version: result.version });
    return result;
  }

  approvePlan(planId: number): { id: number; workItemId: number; frozenAt: string } {
    const plan = this.database.sqlite.prepare(`
      SELECT id, work_item_id, frozen_at FROM plan_versions WHERE id = ?
    `).get(planId) as { id: number; work_item_id: number; frozen_at: string | null } | undefined;
    if (!plan) throw new WorkflowConflictError("plan not found");
    const latest = this.database.sqlite.prepare(`
      SELECT id FROM plan_versions WHERE work_item_id = ? ORDER BY version DESC LIMIT 1
    `).get(plan.work_item_id) as { id: number };
    if (latest.id !== plan.id) throw new WorkflowConflictError("only the latest plan version may be approved");
    const item = this.getWorkItem(plan.work_item_id);
    if (item.state !== "awaiting_plan_approval") throw new WorkflowConflictError("plan is not awaiting approval");
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("UPDATE plan_versions SET frozen_at = CURRENT_TIMESTAMP WHERE id = ?").run(planId);
      this.database.sqlite.prepare(`
        UPDATE work_items SET approved_plan_id = ?, state = 'ready_to_build', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(planId, plan.work_item_id);
    })();
    const frozen = this.database.sqlite.prepare("SELECT frozen_at FROM plan_versions WHERE id = ?").get(planId) as { frozen_at: string };
    this.event("plan_approved", "brain", { workItemId: plan.work_item_id, planId });
    return { id: planId, workItemId: plan.work_item_id, frozenAt: frozen.frozen_at };
  }

  replacePlanGoal(planId: number, goal: string): void {
    const plan = this.database.sqlite.prepare("SELECT frozen_at FROM plan_versions WHERE id = ?").get(planId) as { frozen_at: string | null } | undefined;
    if (!plan) throw new WorkflowConflictError("plan not found");
    if (plan.frozen_at) throw new WorkflowConflictError("approved plans are frozen");
    this.database.sqlite.prepare("UPDATE plan_versions SET goal = ? WHERE id = ?").run(goal, planId);
  }

  startDeveloper(workItemId: number): void {
    this.requireState(workItemId, ["ready_to_build", "needs_fix"]);
    this.database.sqlite.prepare(`
      UPDATE work_items SET state = 'building', cycle_count = cycle_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(workItemId);
    this.refreshExecutionAgentStatuses();
    this.event("developer_started", "developer", { workItemId });
  }

  finishDeveloper(workItemId: number, commit: string): void {
    this.requireState(workItemId, ["building"]);
    if (!commit.trim()) throw new WorkflowConflictError("developer commit is required");
    this.database.sqlite.prepare(`
      UPDATE work_items SET state = 'ready_to_test', developer_commit = ?, tested_commit = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(commit.trim(), workItemId);
    this.refreshExecutionAgentStatuses();
    this.event("developer_finished", "developer", { workItemId, commit });
  }

  startTester(workItemId: number): void {
    const item = this.requireState(workItemId, ["ready_to_test"]);
    this.database.sqlite.prepare(`
      UPDATE work_items SET state = 'testing', tested_commit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(item.developerCommit, workItemId);
    this.refreshExecutionAgentStatuses();
    this.event("tester_started", "tester", { workItemId, commit: item.developerCommit });
  }

  /**
   * `returnToDeveloper` decides whether recording this finding also sends the
   * item back for another cycle. It defaults to the old rule — anything above
   * a suggestion does — but the Tester may now file a `defect` alongside a
   * passing verdict, and that finding must be stored without dragging a
   * finished work item back into `needs_fix`.
   */
  reportFinding(
    workItemId: number,
    finding: FindingInput,
    options: { returnToDeveloper?: boolean; commit?: string | null } = {},
  ): void {
    this.requireState(workItemId, ["testing", "needs_fix"]);
    if (finding.severity !== "suggestion" && (finding.steps.length === 0 || finding.evidence.length === 0)) {
      throw new WorkflowConflictError("blocking findings require reproduction steps and evidence");
    }
    const returnToDeveloper = (options.returnToDeveloper ?? true) && finding.severity !== "suggestion";
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(`
        INSERT INTO findings (work_item_id, severity, kind, target, title, expected, actual, steps_json, evidence_json, found_commit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workItemId,
        finding.severity,
        finding.kind ?? "product",
        finding.target ?? null,
        finding.title,
        finding.expected,
        finding.actual,
        JSON.stringify(finding.steps),
        JSON.stringify(finding.evidence),
        options.commit ?? null,
      );
      if (returnToDeveloper) {
        this.database.sqlite.prepare("UPDATE work_items SET state = 'needs_fix', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workItemId);
        this.refreshExecutionAgentStatuses();
      }
    })();
    this.event("finding_reported", "tester", { workItemId, severity: finding.severity, kind: finding.kind ?? "product", title: finding.title });
  }

  /**
   * A Tester verdict re-examines the whole frozen plan at one commit, so every
   * product finding still open when it lands has just been re-adjudicated:
   * anything still real is in the new report. Close the old ones against the
   * commit that answered them, or the next Developer is handed a punch list
   * that only ever grows — the failure that cost work item #4 eleven cycles.
   *
   * Call before recording the new report's findings; they stay open.
   */
  resolveOpenProductFindings(workItemId: number, commit: string): number {
    const result = this.database.sqlite.prepare(`
      UPDATE findings SET resolved_at = CURRENT_TIMESTAMP, resolved_commit = ?
      WHERE work_item_id = ? AND kind = 'product' AND resolved_at IS NULL
    `).run(commit, workItemId);
    if (result.changes > 0) this.event("findings_resolved", "tester", { workItemId, commit, kind: "product", count: result.changes });
    return result.changes;
  }

  /** A target that passes at any commit answers every open abort recorded for it. */
  resolveHarnessFindings(workItemId: number, target: string, commit: string): number {
    const result = this.database.sqlite.prepare(`
      UPDATE findings SET resolved_at = CURRENT_TIMESTAMP, resolved_commit = ?
      WHERE work_item_id = ? AND kind = 'harness' AND target = ? AND resolved_at IS NULL
    `).run(commit, workItemId, target);
    if (result.changes > 0) this.event("findings_resolved", "system", { workItemId, commit, kind: "harness", target, count: result.changes });
    return result.changes;
  }

  passTesting(workItemId: number, testedCommit: string): { state: WorkItemState } {
    const item = this.requireState(workItemId, ["testing"]);
    if (!item.developerCommit || item.testedCommit !== testedCommit || item.developerCommit !== testedCommit) {
      throw new WorkflowConflictError("Tester may only pass the exact current Developer commit");
    }
    this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("UPDATE work_items SET state = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workItemId);
      this.database.sqlite.prepare("UPDATE projects SET accepted_commit = ? WHERE id = ?").run(testedCommit, item.projectId);
      this.refreshExecutionAgentStatuses();
    })();
    this.event("workflow_complete", "tester", { workItemId, commit: testedCommit });
    return { state: "complete" };
  }

  getExecutionContext(workItemId: number) {
    const item = this.getWorkItem(workItemId);
    const project = this.getProject(item.projectId);
    const plan = this.database.sqlite.prepare(`
      SELECT pv.id, pv.version, pv.goal, pv.assumptions_json, pv.test_targets_json, pv.reference_images_json, pv.frozen_at
      FROM plan_versions pv JOIN work_items wi ON wi.approved_plan_id = pv.id
      WHERE wi.id = ?
    `).get(workItemId) as {
      id: number; version: number; goal: string; assumptions_json: string; test_targets_json: string;
      reference_images_json: string; frozen_at: string | null;
    } | undefined;
    if (!plan?.frozen_at) throw new WorkflowConflictError("work item has no frozen approved plan");
    const criteria = this.database.sqlite.prepare(`
      SELECT id, ordinal, text, status FROM acceptance_criteria WHERE plan_id = ? ORDER BY ordinal
    `).all(plan.id) as Array<{ id: number; ordinal: number; text: string; status: string }>;
    // Unresolved only: a finding the last Tester verdict answered is history,
    // not work, and handing it forward is indistinguishable to a Developer from
    // a live defect.
    const findings = this.database.sqlite.prepare(`
      SELECT id, severity, kind, target, title, expected, actual, steps_json, evidence_json, found_commit
      FROM findings WHERE work_item_id = ? AND resolved_at IS NULL ORDER BY id
    `).all(workItemId).map((row) => {
      const typed = row as Record<string, unknown>;
      return {
        id: typed.id,
        severity: typed.severity as string,
        kind: (typed.kind as FindingKind | null) ?? "product",
        target: (typed.target as string | null) ?? undefined,
        title: typed.title,
        expected: typed.expected,
        actual: typed.actual,
        steps: JSON.parse(String(typed.steps_json)) as string[],
        evidence: JSON.parse(String(typed.evidence_json)) as string[],
        foundCommit: (typed.found_commit as string | null) ?? undefined,
      };
    });
    return {
      item,
      project,
      plan: {
        id: plan.id,
        version: plan.version,
        goal: plan.goal,
        assumptions: JSON.parse(plan.assumptions_json) as string[],
        testTargets: JSON.parse(plan.test_targets_json) as string[],
        // Absolute paths, because this object is serialized straight into
        // build-agent prompts and the agents view the files with Read.
        referenceImages: (JSON.parse(plan.reference_images_json) as PlanReferenceImage[]).map((image) => ({
          ...image,
          path: path.join(this.workspaceRoot, "system", "attachments", image.file),
        })),
        criteria,
      },
      findings,
    };
  }

  getAgentConfiguration(id: "brain" | "developer" | "frontend" | "tester"): { provider: string; model: string; effort: string } {
    const row = this.database.sqlite.prepare("SELECT provider, model, effort FROM agents WHERE id = ?").get(id) as {
      provider: string; model: string; effort: string;
    } | undefined;
    if (!row) throw new WorkflowConflictError("agent not found");
    return row;
  }

  setCriterionStatus(workItemId: number, ordinal: number, status: "pending" | "passed" | "failed", evidence: string[]): void {
    const updated = this.database.sqlite.prepare(`
      UPDATE acceptance_criteria SET status = ?, evidence_json = ?
      WHERE ordinal = ? AND plan_id = (SELECT approved_plan_id FROM work_items WHERE id = ?)
    `).run(status, JSON.stringify(evidence), ordinal, workItemId);
    if (updated.changes !== 1) throw new WorkflowConflictError(`unknown acceptance criterion ${ordinal}`);
  }

  retryBlockedWorkItem(workItemId: number, options: { auto?: boolean } = {}): { state: WorkItemState } {
    const item = this.requireState(workItemId, ["blocked"]);
    const approved = this.database.sqlite.prepare("SELECT approved_plan_id FROM work_items WHERE id = ?").get(workItemId) as { approved_plan_id: number | null };
    if (!approved.approved_plan_id) throw new WorkflowConflictError("blocked work item has no approved plan");
    // A "tester" block means the commit was already built and had passed the
    // harness's own platform scripts — only the Tester agent or its report
    // failed. Resume there instead of rebuilding the whole cycle.
    const resumeAtTester = item.blockedStage === "tester" && item.developerCommit !== null;
    const state: WorkItemState = resumeAtTester ? "ready_to_test" : "ready_to_build";
    this.database.sqlite.prepare(`
      UPDATE work_items SET state = ?, tested_commit = NULL, blocked_stage = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(state, workItemId);
    this.refreshExecutionAgentStatuses();
    // `auto` marks the harness retrying on its own; the auto-retry policy
    // reads it back to grant each block at most one automatic attempt.
    this.event("workflow_retried", "system", { workItemId, resumedAt: state, ...(options.auto ? { auto: true } : {}) });
    return { state };
  }

  recoverInterruptedWorkItems(): number[] {
    const interruptedRuns = this.database.sqlite.prepare(`
      UPDATE agent_runs SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP,
        last_activity_at = CURRENT_TIMESTAMP, error = 'runtime restarted before this run completed'
      WHERE status = 'running'
    `).run();
    if (interruptedRuns.changes > 0) this.event("agent_runs_reconciled", "system", { count: interruptedRuns.changes });
    const rows = this.database.sqlite.prepare(`
      SELECT id, state, developer_commit FROM work_items
      WHERE approved_plan_id IS NOT NULL
        AND state IN ('ready_to_build', 'building', 'ready_to_test', 'testing', 'needs_fix')
      ORDER BY id
    `).all() as Array<{ id: number; state: WorkItemState; developer_commit: string | null }>;
    const interrupted = rows.filter((row) => ["building", "ready_to_test", "testing"].includes(row.state));
    this.database.sqlite.transaction(() => {
      for (const row of interrupted) {
        // A run killed during testing still has its built commit; resume there
        // rather than paying for a full rebuild the restart didn't invalidate.
        const state: WorkItemState = row.state !== "building" && row.developer_commit ? "ready_to_test" : "ready_to_build";
        this.database.sqlite.prepare(`
          UPDATE work_items SET state = ?, tested_commit = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(state, row.id);
        this.event("workflow_recovered", "system", { workItemId: row.id, previousState: row.state, resumedAt: state });
      }
      this.refreshExecutionAgentStatuses();
    })();
    return rows.map((row) => row.id);
  }

  block(workItemId: number, reason: string, stage: BlockStage | null = null): void {
    this.database.sqlite.prepare("UPDATE work_items SET state = 'blocked', blocked_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(stage, workItemId);
    this.refreshExecutionAgentStatuses();
    this.event("workflow_blocked", "system", { workItemId, reason, ...(stage ? { stage } : {}) });
  }

  private requireState(workItemId: number, allowed: WorkItemState[]) {
    const item = this.getWorkItem(workItemId);
    if (!allowed.includes(item.state)) {
      throw new WorkflowConflictError(`work item is ${item.state}; expected ${allowed.join(" or ")}`);
    }
    return item;
  }

  private setAgentStatus(id: string, status: string): void {
    this.database.sqlite.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
  }

  private refreshExecutionAgentStatuses(): void {
    const active = this.database.sqlite.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM work_items WHERE state = 'building') AS developer,
        EXISTS(SELECT 1 FROM work_items WHERE state = 'testing') AS tester
    `).get() as { developer: number; tester: number };
    this.setAgentStatus("developer", active.developer ? "working" : "idle");
    // Both build specialists share the 'building' phase of the state machine.
    this.setAgentStatus("frontend", active.developer ? "working" : "idle");
    this.setAgentStatus("tester", active.tester ? "working" : "idle");
  }

  private event(kind: string, actor: string, detail: Record<string, unknown>): void {
    this.database.sqlite.prepare("INSERT INTO events (kind, actor, detail_json) VALUES (?, ?, ?)")
      .run(kind, actor, JSON.stringify(detail));
  }
}
