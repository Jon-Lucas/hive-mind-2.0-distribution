import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowConflictError, WorkflowService } from "../src/workflow/workflow-service.js";

describe("three-agent workflow", () => {
  let database: HiveDatabase | undefined;

  afterEach(() => database?.close());

  it("freezes an approved plan and only promotes the exact commit that Tester passed", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);

    expect(workflow.listAgents().map((agent) => agent.id)).toEqual([
      "brain",
      "developer",
      "frontend",
      "tester",
    ]);

    const project = workflow.createProject("Pocket Tasks");
    const item = workflow.createWorkItem(project.id, "Build the first usable version");
    const plan = workflow.createPlan(item.id, {
      goal: "A persistent mobile task list",
      assumptions: ["Local-only storage"],
      acceptanceCriteria: [
        "A user can create a task with a title",
        "Tasks remain after relaunching the app",
      ],
      testTargets: ["ios-simulator", "android-emulator"],
    });

    const approved = workflow.approvePlan(plan.id);
    expect(approved.frozenAt).toBeTruthy();
    expect(workflow.getWorkItem(item.id).state).toBe("ready_to_build");
    expect(() => workflow.replacePlanGoal(plan.id, "Quietly changed scope")).toThrow(WorkflowConflictError);

    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-a");
    expect(workflow.getWorkItem(item.id).state).toBe("ready_to_test");

    workflow.startTester(item.id);
    workflow.reportFinding(item.id, {
      severity: "defect",
      title: "Tasks disappear after relaunch",
      expected: "Tasks remain visible",
      actual: "The list is empty",
      steps: ["Create a task", "Relaunch the app"],
      evidence: ["evidence/relaunch.png"],
    });
    expect(workflow.getWorkItem(item.id).state).toBe("needs_fix");

    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-b");
    workflow.startTester(item.id);

    expect(() => workflow.passTesting(item.id, "commit-a")).toThrow(WorkflowConflictError);

    const complete = workflow.passTesting(item.id, "commit-b");
    expect(complete.state).toBe("complete");
    expect(workflow.getProject(project.id).acceptedCommit).toBe("commit-b");
  });

  it("keeps suggestions non-blocking and rejects incomplete defect reports", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Web Notes");
    const item = workflow.createWorkItem(project.id, "Build notes");
    const plan = workflow.createPlan(item.id, {
      goal: "Working notes app",
      assumptions: [],
      acceptanceCriteria: ["A note can be saved"],
      testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-1");
    workflow.startTester(item.id);

    workflow.reportFinding(item.id, {
      severity: "suggestion",
      title: "Try a different accent color",
      expected: "Optional design alternative",
      actual: "Current design follows the plan",
      steps: [],
      evidence: [],
    });
    expect(workflow.getWorkItem(item.id).state).toBe("testing");

    expect(() =>
      workflow.reportFinding(item.id, {
        severity: "defect",
        title: "Save is broken",
        expected: "A note is saved",
        actual: "Nothing happens",
        steps: [],
        evidence: [],
      }),
    ).toThrow(WorkflowConflictError);
  });

  it("records a defect alongside a passing verdict without returning the item to the Developer", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Ebb");
    const item = workflow.createWorkItem(project.id, "Release candidate");
    const plan = workflow.createPlan(item.id, {
      goal: "Ship the release candidate",
      assumptions: [],
      acceptanceCriteria: ["The signed build installs"],
      testTargets: ["android-emulator"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-1");
    workflow.startTester(item.id);

    // True, worth keeping, and not a reason to spend another build cycle.
    workflow.reportFinding(item.id, {
      severity: "defect",
      title: "Evidence directory still holds pre-fix screenshots",
      expected: "Only this commit's captures",
      actual: "Cycle-1 captures under the same names",
      steps: ["List the evidence directory"],
      evidence: ["143-largest-text-daylog-sheet.png"],
    }, { returnToDeveloper: false });

    expect(workflow.getWorkItem(item.id).state).toBe("testing");
    expect(workflow.getExecutionContext(item.id).findings).toHaveLength(1);
    expect(workflow.passTesting(item.id, "commit-1").state).toBe("complete");
  });

  it("rejects unknown and duplicate test targets before freezing a plan", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Target Guard");
    const item = workflow.createWorkItem(project.id, "Validate targets");
    const input = {
      goal: "Guard test targets",
      assumptions: [] as string[],
      acceptanceCriteria: ["Targets are valid"],
    };

    expect(() => workflow.createPlan(item.id, { ...input, testTargets: ["web", "web"] })).toThrow("duplicate test target: web");
    expect(() => workflow.createPlan(item.id, { ...input, testTargets: ["windows-phone"] })).toThrow("unsupported test target: windows-phone");
  });

  it("only allows the latest plan version to be approved", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Version Guard");
    const item = workflow.createWorkItem(project.id, "Build it");
    const input = { goal: "First", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"] };
    const first = workflow.createPlan(item.id, input);
    const second = workflow.createPlan(item.id, { ...input, goal: "Second" });

    expect(() => workflow.approvePlan(first.id)).toThrow("latest plan version");
    expect(workflow.approvePlan(second.id).id).toBe(second.id);
  });

  it("keeps global role status active while another project is still running", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const firstProject = workflow.createProject("Parallel One");
    const secondProject = workflow.createProject("Parallel Two");
    const first = workflow.createWorkItem(firstProject.id, "First release");
    const second = workflow.createWorkItem(secondProject.id, "Second release");
    for (const item of [first, second]) {
      const plan = workflow.createPlan(item.id, {
        goal: "Parallel work", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
      });
      workflow.approvePlan(plan.id);
      workflow.startDeveloper(item.id);
    }

    workflow.finishDeveloper(first.id, "commit-first");
    expect(database.sqlite.prepare("SELECT status FROM agents WHERE id = 'developer'").get()).toEqual({ status: "working" });

    workflow.finishDeveloper(second.id, "commit-second");
    expect(database.sqlite.prepare("SELECT status FROM agents WHERE id = 'developer'").get()).toEqual({ status: "idle" });
    workflow.startTester(first.id);
    workflow.startTester(second.id);
    workflow.block(first.id, "first stopped");
    expect(database.sqlite.prepare("SELECT status FROM agents WHERE id = 'tester'").get()).toEqual({ status: "working" });
    workflow.block(second.id, "second stopped");
    expect(database.sqlite.prepare("SELECT status FROM agents WHERE id = 'tester'").get()).toEqual({ status: "idle" });
  });

  it("retries an approved blocked item from the deterministic build boundary", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Retry Lab");
    const item = workflow.createWorkItem(project.id, "Retry me");
    const plan = workflow.createPlan(item.id, {
      goal: "Recover from infrastructure failure", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.block(item.id, "provider unavailable");

    expect(workflow.retryBlockedWorkItem(item.id).state).toBe("ready_to_build");
    expect(() => workflow.retryBlockedWorkItem(item.id)).toThrow("work item is ready_to_build");
  });

  it("resumes a tester-stage block at ready_to_test, preserving the built commit", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Resume Lab");
    const item = workflow.createWorkItem(project.id, "Resume me");
    const plan = workflow.createPlan(item.id, {
      goal: "Survive a tester report failure", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-resume");
    workflow.startTester(item.id);
    workflow.block(item.id, "invalid or missing Tester evidence", "tester");

    expect(workflow.getWorkItem(item.id).blockedStage).toBe("tester");
    expect(workflow.retryBlockedWorkItem(item.id).state).toBe("ready_to_test");
    const resumed = workflow.getWorkItem(item.id);
    expect(resumed.developerCommit).toBe("commit-resume");
    expect(resumed.blockedStage).toBeNull();
    // The tester can start directly from the resumed boundary.
    workflow.startTester(item.id);
    expect(workflow.getWorkItem(item.id).state).toBe("testing");
  });

  it("still rebuilds from scratch when the block happened in a build stage", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Rebuild Lab");
    const item = workflow.createWorkItem(project.id, "Rebuild me");
    const plan = workflow.createPlan(item.id, {
      goal: "Fail during the build", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    workflow.approvePlan(plan.id);
    workflow.startDeveloper(item.id);
    workflow.finishDeveloper(item.id, "commit-halfway");
    workflow.startTester(item.id);
    workflow.block(item.id, "frontend run stalled", "frontend");

    expect(workflow.retryBlockedWorkItem(item.id).state).toBe("ready_to_build");
  });

  it("recovers interrupted approved work to a deterministic build boundary", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Recovery Lab");
    const makeApproved = (title: string) => {
      const item = workflow.createWorkItem(project.id, title);
      const plan = workflow.createPlan(item.id, {
        goal: title,
        assumptions: [],
        acceptanceCriteria: ["It works"],
        testTargets: ["web"],
      });
      workflow.approvePlan(plan.id);
      return item;
    };
    const building = makeApproved("Interrupted build");
    workflow.startDeveloper(building.id);
    database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (?, 'developer', 'openai', 'gpt-5.6-sol', 'high', 'running')
    `).run(building.id);
    const testing = makeApproved("Interrupted test");
    workflow.startDeveloper(testing.id);
    workflow.finishDeveloper(testing.id, "commit-recovery");
    workflow.startTester(testing.id);

    const recovered = workflow.recoverInterruptedWorkItems();

    expect(recovered).toEqual([building.id, testing.id]);
    expect(workflow.getWorkItem(building.id).state).toBe("ready_to_build");
    // The testing item already has a built commit; a restart does not
    // invalidate it, so recovery resumes at the tester boundary instead.
    expect(workflow.getWorkItem(testing.id).state).toBe("ready_to_test");
    expect(workflow.getWorkItem(testing.id).developerCommit).toBe("commit-recovery");
    const staleRun = database.sqlite.prepare("SELECT status, finished_at, error FROM agent_runs WHERE work_item_id = ?").get(building.id) as {
      status: string; finished_at: string | null; error: string | null;
    };
    expect(staleRun.status).toBe("interrupted");
    expect(staleRun.finished_at).toBeTruthy();
    expect(staleRun.error).toContain("runtime restarted");
  });

  it("names the rejected test target as a conflict instead of an opaque internal error", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    const project = workflow.createProject("Local Period Tracker");
    const item = workflow.createWorkItem(project.id, "v1");

    expect(() => workflow.createPlan(item.id, {
      goal: "Build it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["ios"],
    })).toThrow(WorkflowConflictError);
    expect(() => workflow.createPlan(item.id, {
      goal: "Build it", assumptions: [], acceptanceCriteria: ["It launches"], testTargets: ["ios"],
    })).toThrow(/unsupported test target: ios/i);
  });

  it("reports a duplicate project as a caller conflict rather than an internal fault", () => {
    database = createDatabase(":memory:");
    const workflow = new WorkflowService(database, "/tmp/hive-test-workspace");
    workflow.createProject("Pocket Studio");

    expect(() => workflow.createProject("pocket studio")).toThrow(WorkflowConflictError);
    expect(() => workflow.createProject("Pocket Studio")).toThrow(/already exists/i);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
  });

  it("stores an explicit repository path only when it is a real external git repository", () => {
    database = createDatabase(":memory:");
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-flow-root-")));
    const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-flow-repo-")));
    try {
      fs.mkdirSync(path.join(repository, ".git"));
      const workflow = new WorkflowService(database, workspaceRoot);

      expect(() => workflow.createProject("Rel", "relative/path")).toThrow(/absolute/);
      expect(() => workflow.createProject("Inside", path.join(workspaceRoot, "projects", "other"))).toThrow(/inside the managed workspace/);
      expect(() => workflow.createProject("Parent", path.dirname(workspaceRoot))).toThrow(/contain the managed workspace/);
      expect(() => workflow.createProject("Ghost", path.join(repository, "missing"))).toThrow(/existing git repository/);

      const external = workflow.createProject("Old App", repository);
      expect(workflow.projectWorkspacePath(external.slug)).toBe(repository);

      // Naming the managed slot explicitly is the same as omitting the path.
      const explicit = workflow.createProject("Explicit Slot", path.join(workspaceRoot, "projects", "explicit-slot"));
      expect(workflow.projectWorkspacePath(explicit.slug)).toBe(path.join(workspaceRoot, "projects", "explicit-slot"));

      const fresh = workflow.createProject("Fresh App");
      expect(workflow.projectWorkspacePath(fresh.slug)).toBe(path.join(workspaceRoot, "projects", "fresh-app"));

      // "~/x" expands to the home directory before validation: the failure is
      // about the expanded path not being a repository, never about "~" not
      // being absolute.
      expect(() => workflow.createProject("Tilde", "~/hive-test-definitely-missing"))
        .toThrow(/not an existing git repository: .*hive-test-definitely-missing/);
      expect(() => workflow.createProject("Tilde", "~/hive-test-definitely-missing"))
        .not.toThrow(/absolute/);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});
