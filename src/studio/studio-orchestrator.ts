import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentGateway, AgentRequest, AgentUsage } from "../agents/agent-gateway.js";
import { AgentRunError } from "../agents/process-agent-gateway.js";
import type { RunBudget } from "../config/runtime-config.js";
import type { ManagedWorkspace } from "../projects/managed-workspace.js";
import type { HiveDatabase } from "../storage/database.js";
import type { WorkflowService } from "../workflow/workflow-service.js";
import type { DriverRegistry } from "../tester/driver-registry.js";
import { TARGET_CONTRACT, TEST_TARGETS } from "../tester/platform-driver.js";
import type { KnowledgeContributor, KnowledgeUpdate, SecondBrainService } from "../knowledge/second-brain-service.js";
import type { SoulRegistry } from "../agents/soul-registry.js";
import type { BlockStage } from "../workflow/workflow-service.js";
import { code, fields, plural, renderNotice } from "../discord/notice.js";

/**
 * Evidence that shows the running product rather than describing it. Extension
 * is the whole test on purpose: the Tester writes these files itself, and a
 * stricter check (decoding headers) would reject a valid capture over an
 * encoder quirk and block a run for a reason nobody could act on.
 */
export function isScreenshot(evidencePath: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(evidencePath);
}

/** Keeps a notification readable when the underlying detail is script output. */
function truncate(value: string, limit: number): string {
  const collapsed = value.trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit).trimEnd()}…`;
}

/** Structured progress signal for observers (GUI, Discord status line). */
export interface PhaseUpdate {
  workItemId: number;
  phase: "developer" | "frontend" | "platform" | "tester" | "idle";
  cycle?: number;
  detail?: string;
}

/**
 * Agents routinely give a single value where a list is specified — one evidence
 * path as a bare string rather than a one-element array. Rejecting that threw
 * away a Tester run that had judged all nine criteria, so accept the singular
 * form and normalise it instead of losing the verdict.
 */
function stringList(minimum = 0) {
  const base = z.array(z.string());
  return z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    minimum > 0 ? base.min(minimum) : base,
  );
}

const knowledgeUpdateSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(8_000),
  sourceFiles: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value ?? []),
    z.array(z.string().max(500)).max(50),
  ).default([]),
}).strict();

const developerReportSchema = z.object({
  knowledgeUpdates: z.array(knowledgeUpdateSchema).max(20).default([]),
}).passthrough();

export const testerReportSchema = z.object({
  status: z.enum(["passed", "needs_fix"]),
  criteria: z.array(z.object({
    ordinal: z.number().int().positive(),
    status: z.enum(["passed", "failed"]),
    evidence: stringList(1),
  }).strict()),
  findings: z.array(z.object({
    severity: z.enum(["blocker", "defect", "suggestion"]),
    title: z.string().min(1),
    expected: z.string().min(1),
    actual: z.string().min(1),
    steps: stringList(),
    evidence: stringList(),
  }).strict()),
  knowledgeUpdates: z.array(knowledgeUpdateSchema).max(20).default([]),
}).strict();

type NotificationSink = (message: string) => void | Promise<void>;

/** Replaced wholesale by the developer soul file when one is usable. */
const DEVELOPER_IDENTITY = `You are Developer in Hive Mind 2.0.`;

const DEVELOPER_RULES = `Implement the exact frozen plan in the assigned managed workspace. Do not change product scope.
Resolve every structured blocking finding. blockingFindings holds defects in the product and is your punch list; platformFailures holds test targets whose script did not complete in a clean checkout, which is a build or harness problem rather than a product one. Both are still open — a finding the Tester has since answered is not sent to you at all — so treat everything you are given as live work.
You may create, edit, delete, install, build, and test inside this workspace.
Do not push, publish, deploy, message third parties, access unrelated repositories, or alter system security settings.
Never merge, pull, rebase onto, or cherry-pick from another work item's branch (e.g. hive/work-<other-id>) or any ref besides your own workspace's history — only ever build on top of main, even if the plan text references functionality another in-progress work item is adding. If your work genuinely depends on that other work item, report it as a blocking finding instead of reaching into its branch.
Run relevant quality checks before finishing. Do not merely describe changes: modify and exercise the project.
Your commit must leave the project able to run every target in the frozen plan's testTargets. Tester executes these npm scripts in a clean checkout of your exact commit, so each required script and its packages must be committed as project dependencies:
${TEST_TARGETS.map((target) => `  ${target} -> "${TARGET_CONTRACT[target].script}", requires ${TARGET_CONTRACT[target].packages.join(" and ")} resolvable in the project`).join("\n")}
Each script is responsible for starting whatever it needs, including booting an iOS simulator or Android emulator; assume none are running. A missing script, missing dependency, or unbooted device blocks completion.
When frozenPlan.referenceImages is non-empty, open every listed image with your Read tool before writing code. They are the user's own pictures of what the product should be — where a criterion's words and a reference image disagree on visual intent, the image wins.
Use Second Brain context only for orientation and verify technical claims against the checkout.
Finish with JSON containing summary and knowledgeUpdates. Each knowledge update has title, summary, and relative sourceFiles. Use an empty array when nothing durable was learned.`;

/** Replaced wholesale by the frontend soul file when one is usable. */
const FRONTEND_IDENTITY = `You are Frontend Developer in Hive Mind 2.0.`;

const FRONTEND_RULES = `The Backend Developer has already implemented and committed this cycle's logic, data, and services in this same workspace. Build and polish the user interface on top of that work.
Implement the exact frozen plan's interface. Do not change product scope, the data model, or business logic — if the backend layer blocks correct interface work, report it in your summary rather than reworking it.
Resolve every structured blocking finding that concerns the interface: layout, styling, interaction states, navigation, accessibility, and rendering. blockingFindings holds product defects; platformFailures holds test targets whose script did not complete, which is usually the Backend Developer's or the harness's problem rather than yours. Everything you are given is still open — answered findings are not sent to you.
You may create, edit, delete, install, build, and test inside this workspace. Do not push, publish, deploy, message third parties, access unrelated repositories, or alter system security settings.
Never merge, pull, rebase onto, or cherry-pick from another work item's branch (e.g. hive/work-<other-id>) or any ref besides your own workspace's history — only ever build on top of main, even if the plan text references functionality another in-progress work item is adding. If your work genuinely depends on that other work item, report it as a blocking finding instead of reaching into its branch.
Exercise the screens you change before finishing. Do not merely describe changes: modify and run the project.
When frozenPlan.referenceImages is non-empty, open every listed image with your Read tool before touching the interface, and again beside your own screenshots when you self-review. They are the user's own pictures of what the product should look like — match their visual intent (what each element encodes and communicates), not their pixels; where a criterion's words and a reference image disagree, the image wins.
Before finishing, review your own work visually: launch the app on the plan's test target, capture a screenshot of every screen you created or changed (light and dark mode when the plan requires both), and open each image and look at it. Judge each screenshot as a product about to ship, not as evidence a criterion was met: nothing may sit under the status bar or system bars, no text may clip or overlap, spacing comes from one consistent scale without large dead regions, and navigation and controls look like the platform's own apps. Fix what looks wrong and re-capture until the screens look finished — the Tester and the user see these exact pixels next, and a criterion phrased as words is satisfied only by a screen that communicates what the words intend.
Your changes must leave the project able to run every target in the frozen plan's testTargets exactly as the Backend Developer's commit could.
Use Second Brain context only for orientation and verify technical claims against the checkout.
Finish with JSON containing summary and knowledgeUpdates. Each knowledge update has title, summary, and relative sourceFiles. Use an empty array when nothing durable was learned.`;

/** Replaced wholesale by the tester soul file when one is usable. */
const TESTER_IDENTITY = `You are Tester in Hive Mind 2.0.`;

const TESTER_RULES = `Independently test the exact commit in this clean workspace against every frozen acceptance criterion.
Before you were started, the harness ran every frozen testTarget script itself, in this checkout, at this exact commit. platformResults in your prompt holds each run's command, exit code, and full stdout and stderr, and each run's receipt file is already in your evidence directory. Do not run those scripts again: an identical second run in the same checkout adds no independent signal and costs minutes of emulator time. Cite the receipt path as evidence for criteria that run covers. Re-run a target only when its receipt is missing or records a different commit, and report why in a finding.
Spend your own effort on what those scripts do not cover: regressions, and exploration for reproducible crashes, state errors, broken controls, layouts, and runtime errors.
When frozenPlan.referenceImages is non-empty, open every listed image with your Read tool before judging visual criteria, and compare the app's actual screens against them. They show the user's visual intent; a screen that satisfies a criterion's words while plainly missing what its reference image communicates is a defect.
Do not modify tracked source. Copy every screenshot, log excerpt, or artifact you cite as evidence into the supplied evidence directory yourself — a file left in your own working directory does not count, even if you already viewed it there.
Each evidence entry must be the bare filename of one real file already in the evidence directory (e.g. "08-home-light.png"), never a sentence, a description, or a path outside it. A criterion needing several files gets several array entries, not one string describing all of them. Put your reasoning and observations in the finding or the report's prose, not inside an evidence entry.
Every blocker or defect requires reproduction steps and evidence. Subjective preferences are suggestions.
Every finding's severity must be exactly one of these three words: "blocker", "defect", or "suggestion" — never a synonym such as "moderate", "major", "minor", or "critical". Pick whichever of the three is closest; inventing a fourth word is not allowed.
Only a "blocker" contradicts a passing verdict. If every criterion passes but you found something real that does not stop the release, say status 'passed' and file it as a "defect" — it will be recorded and reported to the operator rather than sending the work back. Reserve status 'needs_fix' for work that must not ship as it stands.
Use Second Brain context only as a risk map; never let it weaken frozen criteria or exact-commit verification.
Return strict JSON only: {status:'passed'|'needs_fix',criteria:[{ordinal,status,evidence}],findings:[{severity,title,expected,actual,steps,evidence}],knowledgeUpdates:[{title,summary,sourceFiles}]}.
Include every acceptance criterion exactly once. Do not use markdown fences.`;

/**
 * Agents are told to return strict JSON and mostly do, but one sentence of
 * preamble or a markdown fence used to throw and block the whole work item —
 * a Tester verdict of "Manifest s..." cost a full cycle. The report is still
 * schema-checked; this only finds where it starts and ends.
 */
export function parseAgentJson(text: string): unknown {
  const withoutFences = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(withoutFences);
  } catch {
    const start = withoutFences.indexOf("{");
    const end = withoutFences.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error(`agent reply contained no JSON object: ${withoutFences.slice(0, 120)}`);
    return JSON.parse(withoutFences.slice(start, end + 1));
  }
}

function developerKnowledgeUpdates(text: string): KnowledgeUpdate[] {
  try {
    const parsed = developerReportSchema.safeParse(parseAgentJson(text));
    return parsed.success ? parsed.data.knowledgeUpdates : [];
  } catch {
    return [];
  }
}

export class StudioOrchestrator {
  constructor(
    private readonly database: HiveDatabase,
    private readonly workflow: WorkflowService,
    private readonly workspace: ManagedWorkspace,
    private readonly gateway: AgentGateway,
    private readonly notify: NotificationSink = () => undefined,
    private readonly maxCycles = 5,
    private readonly drivers?: DriverRegistry,
    private readonly secondBrain?: SecondBrainService,
    private readonly budget?: RunBudget,
    private readonly souls?: SoulRegistry,
    private readonly onPhase: (update: PhaseUpdate) => void = () => undefined,
    private readonly cancellation?: { isRequested(workItemId: number): boolean; clear(workItemId: number): void },
  ) {}

  /** Honors a pending user cancellation at a phase boundary. */
  private assertNotCancelled(workItemId: number): void {
    if (this.cancellation?.isRequested(workItemId)) {
      throw new Error("cancelled by user");
    }
  }

  private phase(workItemId: number, phase: PhaseUpdate["phase"], cycle?: number, detail?: string): void {
    try {
      this.onPhase({ workItemId, phase, cycle, detail });
    } catch { /* observers must never break the workflow */ }
  }

  /** "14m 30s ($2.95)" from a run's reported usage, for notifications. */
  /** Run cost and duration as subtext fields, in the order they read best. */
  private static usageMeta(usage: { costUSD?: number; durationMs?: number } | undefined): string[] {
    if (!usage) return [];
    const parts: string[] = [];
    if (usage.durationMs !== undefined) {
      const total = Math.round(usage.durationMs / 1000);
      parts.push(total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`);
    }
    if (usage.costUSD !== undefined) parts.push(`$${usage.costUSD.toFixed(2)}`);
    return parts;
  }

  /** Role identity (soul file when usable, built-in otherwise) plus its rules. */
  private systemPromptFor(role: "developer" | "frontend" | "tester", identity: string, rules: string): string {
    return this.souls ? this.souls.compose(role, identity, rules) : `${identity}\n${rules}`;
  }

  /**
   * The frozen plan cites reference images by absolute path, but a restricted
   * Claude role cannot Read outside its working directory. Grant the
   * attachments directory only when this plan actually carries images.
   */
  private referenceImageAccess(plan: { referenceImages: Array<{ file: string }> }): string[] | undefined {
    return plan.referenceImages.length > 0 ? [this.workspace.attachmentsPath()] : undefined;
  }

  /** Both build specialists propose knowledge the same way; neither may block the workflow over it. */
  private recordDeveloperKnowledge(
    workItemId: number,
    projectSlug: string,
    cycle: number,
    sourceCommit: string,
    responseText: string,
    label: string,
    contributor: KnowledgeContributor = "developer",
  ): void {
    try {
      this.secondBrain?.recordRoleProposal(contributor, {
        projectSlug,
        workItemId,
        cycle,
        sourceCommit,
        updates: developerKnowledgeUpdates(responseText),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void Promise.resolve(this.notify(renderNotice({
        icon: "📓",
        headline: `${label} knowledge proposal rejected`,
        body: [message],
        meta: [`work item #${workItemId}`],
      }))).catch(() => undefined);
    }
  }

  async runApprovedWorkItem(workItemId: number): Promise<{ state: string; commit?: string }> {
    let stage: BlockStage = "harness";
    try {
      let context = this.workflow.getExecutionContext(workItemId);
      if (!this.workspace.projectExists(context.project.slug)) {
        this.workspace.createProject(context.project.slug, context.project.name);
      }
      const projectIdentity = { slug: context.project.slug, name: context.project.name };
      this.secondBrain?.ensureProject(projectIdentity, this.workspace.projectCommit(context.project.slug));
      const developerDir = this.workspace.createDeveloperWorkspace(context.project.slug, workItemId);
      // Which tree this run builds in must be answerable without reading
      // commit graphs — it goes into the start notices and the evidence.
      const repositoryPath = this.workspace.projectLocation(context.project.slug);
      // The build agents run before this cycle's commit exists, so they get the
      // work item's evidence root. Everything that judges a commit — platform
      // receipts, Tester screenshots — gets that commit's own subdirectory.
      const itemEvidenceDir = this.workspace.evidencePath(workItemId);
      const artifactDir = this.workspace.artifactPath(workItemId);

      for (let cycle = 1; cycle <= this.maxCycles; cycle += 1) {
        this.assertNotCancelled(workItemId);
        context = this.workflow.getExecutionContext(workItemId);
        // A retry after a Tester-side failure re-enters here at ready_to_test:
        // the commit was already built and had passed the platform scripts, so
        // skip straight to testing it rather than paying for a rebuild.
        const resumeCommit = cycle === 1 && context.item.state === "ready_to_test"
          ? context.item.developerCommit
          : null;
        let commit: string;
        if (resumeCommit) {
          commit = resumeCommit;
          await this.notify(renderNotice({
            icon: "▶️",
            headline: "Resuming at Tester",
            body: ["The built Developer and Frontend work is preserved."],
            meta: [`commit ${code(commit.slice(0, 8))}`],
          }));
        } else {
        stage = "developer";
        this.workflow.startDeveloper(workItemId);
        this.phase(workItemId, "developer", cycle);
        await this.notify(renderNotice({
          icon: "🔨",
          headline: "Backend Developer started",
          body: [fields(context.project.name, `work item #${workItemId}`, `cycle ${cycle}`)],
          meta: [`repo ${code(repositoryPath)}`],
        }));
        const developerCommitBeforeRun = this.workspace.developerWorkspaceCommit(workItemId);
        // Unresolved product defects are the punch list. A platform run that
        // aborted is real work too, but it is a different job and it used to
        // outnumber the defects two to one in the same list — keep it named
        // for what it is.
        const openFindings = context.findings.filter((finding) => finding.severity !== "suggestion");
        const blockingFindings = openFindings.filter((finding) => finding.kind !== "harness");
        const platformFailures = openFindings.filter((finding) => finding.kind === "harness");
        // Every completed cycle ends with a commit, so uncommitted files here are
        // the remains of a run that was killed mid-flight. The workspace outlives
        // the process; say so, or the Developer rewrites what is already there.
        const unfinishedWork = this.workspace.developerWorkspaceChanges(workItemId);
        if (unfinishedWork.length > 0) {
          await this.notify(renderNotice({
            icon: "▶️",
            headline: "Resuming an interrupted Developer run",
            body: [`${unfinishedWork.length} uncommitted file(s) from the previous run are preserved in the workspace.`],
            meta: [`work item #${workItemId}`, `cycle ${cycle}`],
          }));
        }
        const developerResponse = await this.runAgent(workItemId, {
          role: "developer",
          ...this.workflow.getAgentConfiguration("developer"),
          prompt: JSON.stringify({
            frozenPlan: context.plan,
            blockingFindings,
            platformFailures,
            cycle,
            ...(unfinishedWork.length > 0
              ? {
                resumedRun: {
                  note: "A previous run of this work item was interrupted. Its uncommitted changes are still in your workspace. Read them first and continue that work; do not start over.",
                  uncommittedFiles: unfinishedWork.slice(0, 100),
                },
              }
              : {}),
          }, null, 2),
          systemPrompt: this.secondBrain
            ? `${this.systemPromptFor("developer", DEVELOPER_IDENTITY, DEVELOPER_RULES)}\n\n${this.secondBrain.contextForProject(projectIdentity, developerCommitBeforeRun)}`
            : this.systemPromptFor("developer", DEVELOPER_IDENTITY, DEVELOPER_RULES),
          conversation: [],
          cwd: developerDir,
          artifactDir,
          evidenceDir: itemEvidenceDir,
          allowedDirectories: this.referenceImageAccess(context.plan),
        });
        const backendCommit = this.workspace.commitDeveloperChanges(
          context.project.slug,
          workItemId,
          `feat: backend for ${context.plan.goal} (cycle ${cycle})`,
        );
        this.recordDeveloperKnowledge(workItemId, context.project.slug, cycle, backendCommit, developerResponse.text, "Backend Developer");
        await this.notify(renderNotice({
          icon: "✅",
          headline: "Backend Developer finished",
          body: [
            fields(context.project.name, `cycle ${cycle}`),
            fields(code(backendCommit.slice(0, 8)), this.workspace.commitStats(workItemId, backendCommit)),
          ],
          meta: StudioOrchestrator.usageMeta(developerResponse.usage),
        }));

        // The Frontend Developer works in the same checkout, after the backend
        // commit, so it builds on real services rather than its own guesses.
        // Both specialists see the same blocking findings; each resolves the
        // ones in its own layer.
        stage = "frontend";
        this.phase(workItemId, "frontend", cycle);
        await this.notify(renderNotice({
          icon: "🎨",
          headline: "Frontend Developer started",
          body: [fields(context.project.name, `work item #${workItemId}`, `cycle ${cycle}`)],
        }));
        const frontendResponse = await this.runAgent(workItemId, {
          role: "frontend",
          ...this.workflow.getAgentConfiguration("frontend"),
          prompt: JSON.stringify({
            frozenPlan: context.plan,
            blockingFindings,
            platformFailures,
            cycle,
            backendCommit,
          }, null, 2),
          systemPrompt: this.secondBrain
            ? `${this.systemPromptFor("frontend", FRONTEND_IDENTITY, FRONTEND_RULES)}\n\n${this.secondBrain.contextForProject(projectIdentity, backendCommit)}`
            : this.systemPromptFor("frontend", FRONTEND_IDENTITY, FRONTEND_RULES),
          conversation: [],
          cwd: developerDir,
          artifactDir,
          evidenceDir: itemEvidenceDir,
          allowedDirectories: this.referenceImageAccess(context.plan),
        });
        commit = this.workspace.commitDeveloperChanges(
          context.project.slug,
          workItemId,
          `feat: frontend for ${context.plan.goal} (cycle ${cycle})`,
        );
        this.recordDeveloperKnowledge(workItemId, context.project.slug, cycle, commit, frontendResponse.text, "Frontend Developer", "frontend");
        this.secondBrain?.refreshProjectStatus(projectIdentity, commit, `Backend and frontend produced commit ${commit}; awaiting exact-commit testing.`);
        this.workflow.finishDeveloper(workItemId, commit);
        await this.notify(renderNotice({
          icon: "✅",
          headline: "Frontend Developer finished",
          body: [
            fields(context.project.name, `cycle ${cycle}`),
            fields(code(commit.slice(0, 8)), this.workspace.commitStats(workItemId, commit)),
          ],
          meta: StudioOrchestrator.usageMeta(frontendResponse.usage),
        }));
        }

        stage = "platform";
        const evidenceDir = this.workspace.evidencePath(workItemId, commit);
        const testerDir = this.workspace.createTesterWorkspace(context.project.slug, workItemId, commit);
        fs.writeFileSync(
          path.join(evidenceDir, "repository.json"),
          `${JSON.stringify({ repository: repositoryPath, commit }, null, 2)}\n`,
        );
        this.workflow.startTester(workItemId);
        // The platform scripts run as harness code with no agent process, so
        // without this signal the studio looks hung for their whole duration.
        this.phase(workItemId, "platform", cycle, context.plan.testTargets.join(", "));
        await this.notify(renderNotice({
          icon: "🧪",
          headline: "Tester started",
          body: [
            fields(`exact commit ${code(commit.slice(0, 8))}`, `targets: ${context.plan.testTargets.join(", ")}`),
            "Platform scripts run first. This phase can take 10–20 minutes with no agent visible — that is normal, not a hang.",
          ],
          meta: [`repo ${code(repositoryPath)}`],
        }));
        const platformResults = this.drivers
          ? await this.drivers.runRequired(context.plan.testTargets, { cwd: testerDir, commit, evidenceDir })
          : [];
        // A target that passes answers every abort recorded against it, whatever
        // commit those aborts named. Nothing else ever closed them, so they were
        // handed to the next Developer as live work for the rest of the item.
        // Recorded before the cancellation check on purpose: the pass is a fact
        // about the suite, not about what the operator does next, and a cancel
        // arriving now must not resurrect an abort the run just answered.
        for (const result of platformResults) {
          if (result.status === "passed") this.workflow.resolveHarnessFindings(workItemId, result.target, commit);
        }
        // A cancel during the platform phase kills the scripts, whose deaths
        // would otherwise read as an ordinary target failure and start the
        // next cycle. Stop here instead.
        this.assertNotCancelled(workItemId);
        // A replayed receipt is still a real result, but it was not produced
        // just now — say so, rather than letting an instant "passed" read as a
        // suite that ran in seconds.
        const reusedTargets = platformResults.filter((result) => result.reused).map((result) => result.target);
        if (reusedTargets.length > 0) {
          await this.notify(renderNotice({
            icon: "▶️",
            headline: "Resumed a completed platform run",
            body: [`${reusedTargets.join(", ")} already passed at this commit; replaying the stored receipt instead of re-running.`],
            meta: [`commit ${code(commit.slice(0, 8))}`, `cycle ${cycle}`],
          }));
        }
        // A red platform run used to kill the work item outright, which gave
        // Developer every reason to grind for hours rather than hand over a
        // failing target. Return it as a blocking finding so the normal
        // Developer/Tester cycle can fix it, with maxCycles as the real ceiling.
        const platformFailure = platformResults.find((result) => result.status !== "passed");
        if (platformFailure) {
          const detail = `platform ${platformFailure.target} ${platformFailure.status}: ${platformFailure.detail}`;
          if (cycle >= this.maxCycles) throw new Error(detail);
          // An unavailable target produces no receipt of its own, and a blocking
          // finding must always be backed by evidence, so record one.
          const evidence = platformFailure.evidence.length > 0
            ? platformFailure.evidence
            : [this.writePlatformReceipt(evidenceDir, platformFailure.target, commit, detail)];
          this.workflow.reportFinding(workItemId, {
            severity: "blocker",
            kind: "harness",
            target: platformFailure.target,
            title: `${platformFailure.target} target did not pass`,
            expected: `npm run ${TARGET_CONTRACT[platformFailure.target].script} passes in a clean checkout`,
            actual: platformFailure.detail.slice(0, 4_000),
            steps: [`Run npm run ${TARGET_CONTRACT[platformFailure.target].script} in the Tester checkout at ${commit}`],
            evidence,
          }, { commit });
          this.secondBrain?.refreshProjectStatus(projectIdentity, commit, detail);
          await this.notify(renderNotice({
            icon: "❌",
            headline: `Platform target ${platformFailure.target} ${platformFailure.status}`,
            // Script output can run to thousands of characters; the finding
            // keeps the full text, the notification only needs the opening.
            body: [truncate(platformFailure.detail, 600), "Returning work to Developer."],
            meta: [`commit ${code(commit.slice(0, 8))}`, `cycle ${cycle}`],
          }));
          continue;
        }
        stage = "tester";
        this.phase(workItemId, "tester", cycle);
        const testerPrompt = JSON.stringify({
          exactCommit: commit,
          frozenPlan: context.plan,
          evidenceDirectory: evidenceDir,
          artifactDirectory: artifactDir,
          platformResults,
        }, null, 2);
        const testerSystemPrompt = this.secondBrain
          ? `${this.systemPromptFor("tester", TESTER_IDENTITY, TESTER_RULES)}\n\n${this.secondBrain.contextForProject(projectIdentity, commit)}`
          : this.systemPromptFor("tester", TESTER_IDENTITY, TESTER_RULES);
        const testerAllowedDirectories = this.referenceImageAccess(context.plan);
        let testerResponse = await this.runAgent(workItemId, {
          role: "tester",
          ...this.workflow.getAgentConfiguration("tester"),
          prompt: testerPrompt,
          systemPrompt: testerSystemPrompt,
          conversation: [],
          cwd: testerDir,
          evidenceDir,
          artifactDir,
          allowedDirectories: testerAllowedDirectories,
        });
        this.workspace.verifyTesterCheckout(context.project.slug, workItemId, commit);
        const verifiedEvidenceDir = this.workspace.evidencePath(workItemId, commit);
        if (verifiedEvidenceDir !== evidenceDir) throw new Error("managed evidence directory changed during Tester execution");
        // Everything that can reject a Tester reply — prose with no JSON,
        // schema drift, a described file instead of its filename, a blocking
        // finding with no reproduction steps — funnels through one
        // interpreter, so every rejection is repairable, not just the
        // unparseable ones.
        const interpretTesterReply = (text: string) => {
          const report = testerReportSchema.parse(parseAgentJson(text));
          this.validateCriteria(context.plan.criteria.map((criterion) => criterion.ordinal), report.criteria);
          const criteria = report.criteria.map((criterion) => ({
            ...criterion,
            evidence: criterion.evidence.map((entry) => this.validateEvidence(verifiedEvidenceDir, entry, "criterion")),
          }));
          const findings = report.findings.map((finding) => ({
            ...finding,
            evidence: finding.evidence.map((entry) => this.validateEvidence(verifiedEvidenceDir, entry, finding.severity)),
          }));
          const reproducible = findings.filter((finding) => finding.severity !== "suggestion");
          if (reproducible.some((finding) => finding.steps.length === 0 || finding.evidence.length === 0)) {
            throw new Error("Every blocking Tester finding requires reproduction steps and evidence");
          }
          // Every plan is required to carry visual and UX criteria, and every
          // test target renders a screen — so a pass backed only by logs means
          // nobody looked at the product. A suite can be green while the
          // screen is plainly wrong; that is the failure this catches.
          if (report.status === "passed" && !criteria.some((criterion) => criterion.evidence.some(isScreenshot))) {
            throw new Error(
              "A passing verdict must cite at least one screenshot of the running app; "
              + "logs and receipts alone cannot show that a screen looks finished",
            );
          }
          return { report, criteria, findings, reproducible };
        };
        let interpreted: ReturnType<typeof interpretTesterReply>;
        try {
          interpreted = interpretTesterReply(testerResponse.text);
        } catch (rejection) {
          // The verdict usually exists — it is the packaging that failed.
          // Production blocked nine times on this class while only parse
          // failures earned a repair. Ask once for a restatement naming the
          // exact rejection; a second rejection still blocks as before.
          const detail = rejection instanceof Error ? rejection.message : String(rejection);
          await this.notify(renderNotice({
            icon: "🛠️",
            headline: "Tester report was rejected — asking it to restate",
            body: [truncate(detail, 300)],
            meta: [`work item #${workItemId}`, `cycle ${cycle}`],
          }));
          const repairResponse = await this.runAgent(workItemId, {
            role: "tester",
            ...this.workflow.getAgentConfiguration("tester"),
            prompt: [
              `Your previous reply was rejected: ${truncate(detail, 2_000)}`,
              "Restate the same verdict as strict JSON only, matching the schema you were given, fixing exactly what the rejection names.",
              "Do not re-test anything. You may copy a file you already produced into the evidence directory if a cited file is missing from it.",
              "Every evidence entry must be the bare filename of a real file in the evidence directory; every blocker or defect keeps its reproduction steps and evidence.",
              "No prose before or after the JSON object.",
            ].join("\n"),
            systemPrompt: testerSystemPrompt,
            conversation: [
              { role: "user", text: testerPrompt },
              { role: "assistant", text: testerResponse.text },
            ],
            cwd: testerDir,
            evidenceDir,
            artifactDir,
            allowedDirectories: testerAllowedDirectories,
          });
          // The repair run has the same tool access as the original; make
          // sure it did not disturb the exact-commit checkout.
          this.workspace.verifyTesterCheckout(context.project.slug, workItemId, commit);
          testerResponse = repairResponse;
          interpreted = interpretTesterReply(repairResponse.text);
        }
        const { report, criteria, findings, reproducible } = interpreted;
        // Only a blocker contradicts a passing verdict. A `defect` filed
        // alongside `passed` is the Tester saying "true, and it doesn't stop
        // the release" — the severity list has no word for that, so treating
        // it as a contradiction threw away a whole tester cycle over an
        // observation worth keeping. It is recorded and reported instead.
        const blockers = findings.filter((finding) => finding.severity === "blocker");
        const failedCriteria = criteria.filter((criterion) => criterion.status !== "passed");
        const contradiction = report.status === "needs_fix"
          ? (reproducible.length === 0 ? "Tester requested fixes without a reproducible blocking finding" : null)
          : (blockers.length > 0 || failedCriteria.length > 0
            ? "Tester reported passed while blocking findings or failed criteria remain"
            : null);

        // Persist before judging. A contradiction used to throw here, and the
        // throw discarded the criteria, findings, and evidence the Tester had
        // just spent a full run producing — the work item blocked with nothing
        // stored to explain it. Recording first makes the contradiction a
        // reportable state rather than an erasure.
        const returnToDeveloper = report.status === "needs_fix" || contradiction !== null;
        this.database.sqlite.transaction(() => {
          for (const criterion of criteria) {
            this.workflow.setCriterionStatus(workItemId, criterion.ordinal, criterion.status, criterion.evidence);
          }
          // A coherent verdict re-adjudicated the whole frozen plan at this
          // commit, so it supersedes every product finding still open: close
          // them first, and this report's own findings are inserted after and
          // stay open. A contradictory verdict gets no such authority — a
          // "needs_fix with nothing reproducible" reply would close the punch
          // list while inserting nothing to replace it, marking defects
          // resolved at a commit the Tester itself refused to pass.
          if (contradiction === null) this.workflow.resolveOpenProductFindings(workItemId, commit);
          for (const finding of findings) {
            this.workflow.reportFinding(workItemId, finding, { returnToDeveloper, commit });
          }
        })();
        try {
          this.secondBrain?.recordRoleProposal("tester", {
            projectSlug: context.project.slug,
            workItemId,
            cycle,
            sourceCommit: commit,
            updates: report.knowledgeUpdates,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await this.notify(renderNotice({
              icon: "📓",
              headline: "Tester knowledge proposal rejected",
              body: [message],
              meta: [`work item #${workItemId}`],
            }));
          } catch {
            // Knowledge reporting is auxiliary and must not block the exact-commit workflow.
          }
        }

        // Thrown only now that the verdict, criteria, findings, and knowledge
        // proposals are all on disk: the item still blocks, but the evidence
        // for why survives the block.
        if (contradiction) throw new Error(contradiction);

        if (report.status === "needs_fix") {
          const titles = reproducible.slice(0, 3).map((finding) => `“${finding.title}”`).join(", ");
          this.secondBrain?.refreshProjectStatus(projectIdentity, commit, `Tester found ${reproducible.length} reproducible defect${reproducible.length === 1 ? "" : "s"}; returning to Developer.`);
          await this.notify(renderNotice({
            icon: "🐛",
            headline: `Tester found ${plural(reproducible.length, "reproducible defect")}`,
            body: [
              `${titles}${reproducible.length > 3 ? ", …" : ""}`,
              "Returning work to Developer.",
            ],
            meta: [`commit ${code(commit.slice(0, 8))}`, `cycle ${cycle}`],
          }));
          continue;
        }
        this.workspace.promotePassingCommit(context.project.slug, commit);
        this.workflow.passTesting(workItemId, commit);
        this.cancellation?.clear(workItemId);
        // The work is merged into the project; the run's two checkouts are now
        // several gigabytes of duplicate. Nothing used to reclaim them, and
        // they are only safe to drop here — a blocked item keeps its Developer
        // workspace because uncommitted work on disk is how it resumes.
        try {
          this.workspace.releaseRunWorkspaces(context.project.slug, workItemId);
        } catch (error) {
          console.warn(`[studio] could not release run ${workItemId} workspaces:`, error);
        }
        this.phase(workItemId, "idle", cycle);
        this.secondBrain?.refreshProjectStatus(projectIdentity, commit, `Workflow complete. Exact passing commit ${commit} was promoted to local main.`);
        await this.notify(renderNotice({
          icon: "🎉",
          headline: `PRODUCT READY — ${context.project.name}`,
          heading: true,
          body: [
            `All ${context.plan.criteria.length} criteri${context.plan.criteria.length === 1 ? "on" : "a"} passed on commit ${code(commit.slice(0, 8))}.`,
            // A defect recorded alongside a pass no longer blocks, so it would
            // otherwise ship unread — the completion notice is the only place
            // the operator will see it.
            ...(reproducible.length > 0
              ? [`Recorded without blocking: ${reproducible.map((finding) => `“${finding.title}”`).join(", ")}.`]
              : []),
            `App: ${code(this.workspace.projectLocation(context.project.slug))}`,
          ],
          meta: [plural(cycle, "cycle"), `total spend $${this.spentOn(workItemId).toFixed(2)}`],
        }));
        return { state: "complete", commit };
      }
      throw new Error(`maximum Developer/Tester cycles exceeded (${this.maxCycles})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.cancellation?.isRequested(workItemId) ?? false;
      this.cancellation?.clear(workItemId);
      if (this.workflow.getWorkItem(workItemId).state !== "complete") {
        this.workflow.block(workItemId, message, cancelled ? "cancelled" : stage);
      }
      this.phase(workItemId, "idle");
      await this.notify(cancelled
        ? renderNotice({
            icon: "⏹️",
            headline: "Cancelled by user",
            body: [`Stopped during the ${stage} stage.`],
            meta: [`work item #${workItemId}`],
          })
        : renderNotice({
            icon: "🛑",
            headline: `Workflow blocked in the ${stage} stage`,
            body: [truncate(message, 600)],
            meta: [`work item #${workItemId}`],
          }));
      throw error;
    }
  }

  /** Total recorded spend across every agent run for one work item. */
  spentOn(workItemId: number): number {
    const row = this.database.sqlite
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM agent_runs WHERE work_item_id = ?")
      .get(workItemId) as { spent: number };
    return row.spent;
  }

  private assertWithinBudget(workItemId: number): void {
    const cap = this.budget?.maxCostUSD;
    if (cap === undefined) return;
    const spent = this.spentOn(workItemId);
    if (spent >= cap) {
      throw new Error(`work item budget exhausted: $${spent.toFixed(2)} spent of $${cap.toFixed(2)} limit`);
    }
  }

  private async runAgent(workItemId: number, request: AgentRequest) {
    this.assertWithinBudget(workItemId);
    const result = this.database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(workItemId, request.role, request.provider, request.model, request.effort);
    const runId = Number(result.lastInsertRowid);
    const record = (status: string, usage: AgentUsage | undefined, error?: string) => {
      this.database.sqlite.prepare(`
        UPDATE agent_runs SET status = ?, last_activity_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP,
          cost_usd = ?, duration_ms = ?, error = ? WHERE id = ?
      `).run(status, usage?.costUSD ?? null, usage?.durationMs ?? null, error ?? null, runId);
    };
    try {
      const response = await this.gateway.run({ ...request, runId });
      record("done", response.usage);
      await this.notifyBudgetThresholds(workItemId);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed run still spent money; record it so the budget accounts for it.
      record("failed", error instanceof AgentRunError ? error.usage : undefined, message);
      throw error;
    }
  }

  /** One ping each at 50% and 80% of the work item's cost cap, deduped across restarts via the events table. */
  private async notifyBudgetThresholds(workItemId: number): Promise<void> {
    const cap = this.budget?.maxCostUSD;
    if (cap === undefined) return;
    const spent = this.spentOn(workItemId);
    for (const percent of [50, 80]) {
      if (spent < (cap * percent) / 100) continue;
      const detail = JSON.stringify({ workItemId, percent });
      const seen = this.database.sqlite
        .prepare("SELECT 1 FROM events WHERE kind = 'budget_threshold' AND detail_json = ?")
        .get(detail);
      if (seen) continue;
      this.database.sqlite.prepare("INSERT INTO events (kind, actor, detail_json) VALUES ('budget_threshold', 'system', ?)").run(detail);
      try {
        await this.notify(renderNotice({
          icon: "⚠️",
          headline: `Budget ${percent}% — $${spent.toFixed(2)} of $${cap.toFixed(0)}`,
          body: [`Work item #${workItemId} crossed its ${percent}% cost threshold.`],
        }));
      } catch { /* budget reporting must never block the workflow */ }
    }
  }

  private writePlatformReceipt(evidenceDir: string, target: string, commit: string, detail: string): string {
    const receipt = path.join(evidenceDir, `${target}-unavailable-${commit.slice(0, 12)}.json`);
    fs.writeFileSync(receipt, JSON.stringify({
      target, commit, status: "unavailable", detail, recordedAt: new Date().toISOString(),
    }, null, 2));
    return this.validateEvidence(evidenceDir, receipt, "blocker");
  }

  private validateCriteria(expectedOrdinals: number[], reported: Array<{ ordinal: number }>): void {
    const expected = [...expectedOrdinals].sort((a, b) => a - b);
    const actual = reported.map((criterion) => criterion.ordinal).sort((a, b) => a - b);
    if (new Set(actual).size !== actual.length || JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Tester must report every frozen acceptance criterion exactly once");
    }
  }

  private validateEvidence(evidenceDir: string, entry: string, severity: string): string {
    if (!entry && severity === "suggestion") return entry;
    try {
      const evidenceDirectoryStat = fs.lstatSync(evidenceDir);
      if (evidenceDirectoryStat.isSymbolicLink() || !evidenceDirectoryStat.isDirectory()) {
        throw new Error("managed evidence directory is not a real directory");
      }
      const evidenceRoot = fs.realpathSync(evidenceDir);
      const candidate = path.resolve(evidenceDir, entry);
      const resolved = fs.realpathSync(candidate);
      if (!resolved.startsWith(evidenceRoot + path.sep) || !fs.statSync(resolved).isFile()) {
        throw new Error("outside managed evidence directory or not a regular file");
      }
      return resolved;
    } catch {
      throw new Error(`invalid or missing Tester evidence: ${entry}`);
    }
  }
}
