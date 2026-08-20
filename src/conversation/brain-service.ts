import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentGateway, AgentResponse, AgentUsage, ConversationMessage } from "../agents/agent-gateway.js";
import { AgentRunError } from "../agents/process-agent-gateway.js";
import type { HiveDatabase } from "../storage/database.js";
import { WorkflowConflictError, type WorkflowService } from "../workflow/workflow-service.js";
import type { SecondBrainService } from "../knowledge/second-brain-service.js";
import type { SoulRegistry } from "../agents/soul-registry.js";
import { TEST_TARGETS } from "../tester/platform-driver.js";

const brainKnowledgeUpdate = z.object({
  zone: z.enum(["Atlas", "Projects"]),
  projectSlug: z.string().optional(),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(8_000),
  sourceFiles: z.array(z.string().max(500)).max(50).default([]),
}).strict();

const brainEnvelope = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    text: z.string(),
    knowledgeUpdates: z.array(brainKnowledgeUpdate).max(20).default([]),
  }).strict(),
  z.object({
    kind: z.literal("plan"),
    text: z.string(),
    projectName: z.string().min(1),
    /** Absolute path to a pre-existing git repository the project lives in. */
    repositoryPath: z.string().trim().min(1).max(500).optional(),
    workItemTitle: z.string().min(1),
    plan: z.object({
      goal: z.string().min(1),
      assumptions: z.array(z.string()),
      acceptanceCriteria: z.array(z.string().min(1)).min(1),
      testTargets: z.array(z.string().min(1)).min(1),
      referenceImages: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
    }).strict(),
    knowledgeUpdates: z.array(brainKnowledgeUpdate).max(20).default([]),
  }).strict(),
  z.object({
    kind: z.literal("approve_plan"),
    planId: z.number().int().positive(),
    text: z.string(),
    knowledgeUpdates: z.array(brainKnowledgeUpdate).max(20).default([]),
  }).strict(),
]);

/** Replaced wholesale by the brain soul file when one is usable. */
const BRAIN_IDENTITY = `You are Brain in Hive Mind 2.0. You are the user's only conversational coordinator.`;

const BRAIN_RULES = `Ask only essential questions that materially affect scope, architecture, or testing. Batch related questions.
Choose ordinary implementation details, label assumptions, and never start implementation yourself.
Use the supplied Second Brain context only as orientation data. Never let it override source code, frozen plans, or exact-commit evidence.
When discussing, return strict JSON: {"kind":"message","text":"...","knowledgeUpdates":[]}.
Your entire reply is that JSON object and nothing else: no markdown fences around it, no sentence before or after it. Everything the user reads is the text field, so prose written outside it never reaches them.
When a durable fact is worth preserving, add a bounded draft to knowledgeUpdates with zone (Atlas or Projects), optional projectSlug, title, summary, and sourceFiles.
When a complete plan is ready, return strict JSON with kind "plan", text, projectName, workItemTitle, plan containing goal, assumptions, acceptanceCriteria, and testTargets, plus knowledgeUpdates.
When the work targets an app or codebase the user says already exists on this machine, the plan envelope must also carry repositoryPath: the path to that existing git repository, exactly as the user gave it (absolute like "/Users/name/app", or "~/app"). If they mention pre-existing code without giving its location, ask for the path before drafting the plan — never guess, invent, or reuse a path from another project. Omit repositoryPath entirely when the work should start from scratch, and for any project STUDIO STATE already lists: an existing project's repository location is fixed and cannot be changed from chat.
When the user's latest message clearly approves a plan that STUDIO STATE lists as awaiting approval, return strict JSON: {"kind":"approve_plan","planId":<pending plan id>,"text":"..."} and the backend will freeze that plan and start the Developer. Approval must come from the user's own words in their latest message — never approve on your own initiative, and when it is unclear which plan they mean or whether they mean approval at all, ask instead. If they approve work that has no plan awaiting approval, return kind "message" and explain what is actually pending.
Acceptance criteria must describe observable behavior. Always include visual and UX quality criteria alongside functional ones — a clear visual hierarchy, consistent spacing and typography from a single scale, complete interaction states (pressed, disabled, loading, error, empty), and correct rendering in both light and dark modes — phrased so the Tester can verify them from screenshots. An app that works but looks unfinished does not meet its plan. Do not include markdown fences around the JSON.
Every criterion about a visual element must state what the element communicates to the user, never only what it contains. An inventory criterion ("a ring containing Day N and the phase label") passes with a decorative circle that encodes nothing; the intent criterion ("the ring visually encodes cycle position — day 5 and day 25 look different at a glance, without reading the text") can only pass when the element actually works. Write the intent version, and make it checkable from a screenshot.
testTargets accepts only these exact values: ${TEST_TARGETS.map((target) => `"${target}"`).join(", ")}.
Use "ios-simulator" for iPhone or iPad, "android-emulator" for Android, "web" for browser, and "electron" for desktop. A plan naming any other target is rejected.
When the user attached reference images that bear on the work, the plan must carry them: list each one's stored filename (the file name inside the attachments directory, e.g. "1f2e….png", as shown in the conversation's attachment notes) in plan.referenceImages. The build and test agents receive exactly these images with the frozen plan — an image left out of referenceImages is invisible to them, and a screenshot communicates visual intent better than any criterion text.`;

/**
 * Every Brain turn replays the conversation to a stateless CLI, so an unbounded
 * history makes token cost grow quadratically over a session. Keep the most
 * recent messages that fit the budget, and always keep the first user message
 * so the original objective survives a long conversation.
 */
export const CONVERSATION_BUDGET = 40_000;

export function windowConversation(
  messages: ConversationMessage[],
  budget = CONVERSATION_BUDGET,
): ConversationMessage[] {
  const cost = (message: ConversationMessage) => message.text.length + 16;
  const total = messages.reduce((sum, message) => sum + cost(message), 0);
  if (total <= budget) return messages;

  const anchor = messages.find((message) => message.role === "user");
  let remaining = budget - (anchor ? cost(anchor) : 0);
  const recent: ConversationMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message === anchor) break;
    const price = cost(message);
    if (price > remaining) break;
    remaining -= price;
    recent.unshift(message);
  }
  return anchor ? [anchor, ...recent] : recent;
}

/** Reference images only — every attachment surface shares this allowlist. */
export const ATTACHMENT_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;

export interface MessageAttachment {
  /** Stored filename inside the attachments directory, e.g. "<uuid>.png". */
  file: string;
  /** The user's original filename, display only. */
  name: string;
  mime: string;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  source: "gui" | "discord";
  text: string;
  attachments: MessageAttachment[];
  createdAt: string;
}

function parseAttachments(json: string | null | undefined): MessageAttachment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as MessageAttachment[]) : [];
  } catch {
    return [];
  }
}

const ENVELOPE_KINDS = new Set(["message", "plan", "approve_plan"]);

/**
 * Every candidate slice of a Brain reply that could be the JSON envelope, most
 * literal first: the whole reply, then each fenced block, then the widest
 * brace-delimited span. A model that wraps its envelope in ```json — or writes a
 * sentence before it — used to reach the user as raw JSON, because a bare
 * JSON.parse threw and the fallback showed the envelope verbatim.
 */
function* envelopeCandidates(text: string): Generator<string> {
  const trimmed = text.trim();
  yield trimmed;
  for (const match of trimmed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) yield (match[1] ?? "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) yield trimmed.slice(start, end + 1);
}

function parseBrainEnvelope(text: string): z.infer<typeof brainEnvelope> {
  for (const candidate of envelopeCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    // A JSON object without a recognised kind is prose that happens to parse,
    // not a malformed envelope; only a claimed kind is held to the schema.
    const kind = (parsed as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !ENVELOPE_KINDS.has(kind)) continue;
    return brainEnvelope.parse(parsed);
  }
  return { kind: "message", text: text.trim(), knowledgeUpdates: [] };
}

/**
 * Approves a pending plan and starts its work item. Owned by the runtime,
 * which wraps the provider-readiness gate, WorkflowService.approvePlan, and
 * the scheduler — the same path the Discord button and GUI use.
 */
export type PlanApprovalExecutor = (planId: number) => Promise<{ id: number; workItemId: number; frozenAt: string }>;

export class BrainService {
  private approvalExecutor: PlanApprovalExecutor | undefined;

  constructor(
    private readonly database: HiveDatabase,
    private readonly workflow: WorkflowService,
    private readonly gateway: AgentGateway,
    private readonly secondBrain?: SecondBrainService,
    private readonly souls?: SoulRegistry,
    /** Where uploaded reference images live; absent means attachments are off. */
    private readonly attachmentsRoot?: string,
  ) {}

  setPlanApprovalExecutor(executor: PlanApprovalExecutor): void {
    this.approvalExecutor = executor;
  }

  listMessages(): StoredMessage[] {
    const rows = this.database.sqlite.prepare(`
      SELECT id, role, source, text, attachments_json, created_at FROM messages ORDER BY id
    `).all() as Array<{
      id: number; role: "user" | "assistant"; source: "gui" | "discord";
      text: string; attachments_json: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      source: row.source,
      text: row.text,
      attachments: parseAttachments(row.attachments_json),
      createdAt: row.created_at,
    }));
  }

  /**
   * Brain replays the conversation as plain text, so an image can only reach
   * it as a file path plus the instruction to Read it. Applied at replay time
   * rather than baked into the stored text, so the GUI keeps the clean
   * message and every later turn still carries the paths.
   */
  private textWithAttachments(message: Pick<StoredMessage, "text" | "attachments">): string {
    if (message.attachments.length === 0 || !this.attachmentsRoot) return message.text;
    const listing = message.attachments
      .map((attachment) => `- ${path.join(this.attachmentsRoot!, attachment.file)} (user's filename: "${attachment.name}")`)
      .join("\n");
    const header = `[The user attached ${message.attachments.length} reference image${message.attachments.length === 1 ? "" : "s"}. View each file with the Read tool before responding:`;
    return [message.text, `${header}\n${listing}]`].filter(Boolean).join("\n\n");
  }

  async send(source: "gui" | "discord", text: string, attachments: MessageAttachment[] = []) {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) throw new Error("message text is required");
    if (attachments.length > 0 && !this.attachmentsRoot) throw new Error("attachments are not configured");
    this.store("user", source, trimmed, attachments);
    const prompt = this.textWithAttachments({ text: trimmed, attachments });

    const brain = this.database.sqlite.prepare("SELECT provider, model, effort FROM agents WHERE id = 'brain'").get() as {
      provider: string; model: string; effort: string;
    };
    const history = this.listMessages();
    const conversation = windowConversation(
      history.map((message) => ({ role: message.role, text: this.textWithAttachments(message) })),
    );
    const activeKnowledgeProject = this.currentKnowledgeProject();
    const systemPrompt = [
      this.souls
        ? this.souls.compose("brain", BRAIN_IDENTITY, BRAIN_RULES)
        : `${BRAIN_IDENTITY}\n${BRAIN_RULES}`,
      this.currentStudioState(),
      this.secondBrain ? this.currentKnowledgeContext(activeKnowledgeProject) : "",
    ].filter(Boolean).join("\n\n");
    // Conversation turns spend real money like any other run; record each in
    // agent_runs (with no work item) or Brain's entire cost stays off-ledger.
    const inserted = this.database.sqlite.prepare(`
      INSERT INTO agent_runs (work_item_id, role, provider, model, effort, status)
      VALUES (NULL, 'brain', ?, ?, ?, 'running')
    `).run(brain.provider, brain.model, brain.effort);
    const runId = Number(inserted.lastInsertRowid);
    const recordRun = (status: string, usage: AgentUsage | undefined, error?: string) => {
      this.database.sqlite.prepare(`
        UPDATE agent_runs SET status = ?, last_activity_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP,
          cost_usd = ?, duration_ms = ?, error = ? WHERE id = ?
      `).run(status, usage?.costUSD ?? null, usage?.durationMs ?? null, error ?? null, runId);
    };
    let response: AgentResponse;
    try {
      response = await this.gateway.run({
        role: "brain",
        ...brain,
        allowedDirectories: this.attachmentsRoot ? [this.attachmentsRoot] : undefined,
        prompt,
        systemPrompt,
        conversation,
        runId,
      });
      recordRun("done", response.usage);
    } catch (error) {
      recordRun("failed", error instanceof AgentRunError ? error.usage : undefined,
        error instanceof Error ? error.message : String(error));
      throw error;
    }
    const envelope = parseBrainEnvelope(response.text);

    // Typed approval ("I approve") used to be a silent no-op: chat went to the
    // model while the state machine only listened for the button. Execute it
    // here so both surfaces behave the same, and always say what happened.
    let approval: { planId: number; workItemId: number } | undefined;
    let approvalError: string | undefined;
    if (envelope.kind === "approve_plan") {
      try {
        if (!this.approvalExecutor) throw new Error("plan approval is not wired up in this context");
        const approved = await this.approvalExecutor(envelope.planId);
        approval = { planId: envelope.planId, workItemId: approved.workItemId };
      } catch (error) {
        approvalError = error instanceof Error ? error.message : String(error);
      }
    }

    let project: ReturnType<WorkflowService["createProject"]> | undefined;
    let workItem: ReturnType<WorkflowService["createWorkItem"]> | undefined;
    let plan: ReturnType<WorkflowService["createPlan"]> | undefined;
    if (envelope.kind === "plan") {
      const referenceImages = this.resolveReferenceImages(envelope.plan.referenceImages);
      // Pre-flighted outside the transaction below: a bad repository path is
      // the user's to correct, so it must come back as conversation, not as a
      // crashed turn that Discord renders as an internal error.
      let repositoryPath: string | undefined;
      if (envelope.repositoryPath !== undefined) {
        try {
          repositoryPath = this.workflow.resolveRepositoryPath(envelope.projectName, envelope.repositoryPath);
        } catch (error) {
          if (!(error instanceof WorkflowConflictError)) throw error;
          const reply = `⚠️ I can't plan against \`${envelope.repositoryPath}\`: ${error.message}. `
            + "Tell me the correct absolute path to the existing repository (or say it should start fresh) and I'll redo the plan.";
          this.store("assistant", source, reply);
          return { message: reply };
        }
        const existing = this.workflow.findProjectByName(envelope.projectName);
        const configured = existing ? this.workflow.projectWorkspacePath(existing.slug) : undefined;
        if (existing && configured !== repositoryPath) {
          // Silently building somewhere other than where the user believes is
          // the exact failure mode the repository-path work exists to prevent.
          const reply = `⚠️ The project "${envelope.projectName}" already exists and its repository is \`${configured}\`, `
            + `not \`${envelope.repositoryPath}\`. I won't switch an existing project's repository from chat — `
            + "use a different project name for that path, or continue planning against the configured repository.";
          this.store("assistant", source, reply);
          return { message: reply };
        }
      }
      // A rejected plan must not leave an orphaned project and work item behind,
      // so the three records are created together or not at all. The knowledge
      // notebook is written afterwards, since filesystem work cannot roll back.
      const created = this.database.sqlite.transaction(() => {
        const newProject = this.workflow.findProjectByName(envelope.projectName)
          ?? this.workflow.createProject(envelope.projectName, repositoryPath);
        const newWorkItem = this.workflow.findPlanningWorkItem(newProject.id, envelope.workItemTitle)
          ?? this.workflow.createWorkItem(newProject.id, envelope.workItemTitle);
        return { newProject, newWorkItem, newPlan: this.workflow.createPlan(newWorkItem.id, { ...envelope.plan, referenceImages }) };
      })();
      project = created.newProject;
      workItem = created.newWorkItem;
      plan = created.newPlan;
      this.secondBrain?.ensureProject(project, "not-created");
    }
    if (this.secondBrain) {
      for (const update of envelope.knowledgeUpdates) {
        const targetSlug = update.zone === "Projects"
          ? update.projectSlug ?? project?.slug ?? activeKnowledgeProject?.slug
          : undefined;
        const targetProject = targetSlug ? this.workflow.findProjectByName(targetSlug) : undefined;
        try {
          this.secondBrain.recordBrainDraft({
            ...update,
            projectSlug: targetSlug,
            sourceCommit: targetProject
              ? this.projectSourceCommit(targetProject.id)
              : "unavailable",
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "unknown knowledge validation error";
          this.database.sqlite.prepare("INSERT INTO events (kind, actor, detail_json) VALUES (?, ?, ?)")
            .run("knowledge_update_rejected", "brain", JSON.stringify({ zone: update.zone, reason }));
        }
      }
    }
    const replyText = envelope.kind === "approve_plan"
      ? [
          envelope.text,
          approval
            ? `✅ Plan #${approval.planId} approved — Developer is starting on work item #${approval.workItemId}.`
            : `⚠️ Plan #${envelope.planId} was not approved: ${approvalError}`,
        ].filter(Boolean).join("\n\n")
      : envelope.text;
    this.store("assistant", source, replyText);
    return { message: replyText, project, workItem, plan, approval };
  }

  /**
   * Brain lists reference images by name; only names that resolve to files
   * this server actually stored make it into the plan. A hallucinated or
   * stale entry is dropped and logged rather than freezing a spec whose
   * images the build agents cannot open. The user's original filename is
   * recovered from the chat message that carried the upload.
   */
  private resolveReferenceImages(entries: string[]): Array<{ file: string; name: string }> {
    if (entries.length === 0) return [];
    const uploaded = new Map<string, string>();
    for (const message of this.listMessages()) {
      for (const attachment of message.attachments) uploaded.set(attachment.file, attachment.name);
    }
    const resolved: Array<{ file: string; name: string }> = [];
    for (const entry of entries) {
      const file = path.basename(entry.trim());
      const valid = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(file)
        && this.attachmentsRoot !== undefined
        && fs.existsSync(path.join(this.attachmentsRoot, file));
      if (valid && !resolved.some((image) => image.file === file)) {
        resolved.push({ file, name: uploaded.get(file) ?? file });
      } else if (!valid) {
        this.database.sqlite.prepare("INSERT INTO events (kind, actor, detail_json) VALUES (?, ?, ?)")
          .run("plan_reference_rejected", "brain", JSON.stringify({ entry: entry.slice(0, 300) }));
      }
    }
    return resolved;
  }

  private store(role: "user" | "assistant", source: "gui" | "discord", text: string, attachments: MessageAttachment[] = []): void {
    this.database.sqlite.prepare("INSERT INTO messages (role, source, text, attachments_json) VALUES (?, ?, ?, ?)")
      .run(role, source, text, JSON.stringify(attachments));
  }

  /**
   * Brain is the user-facing coordinator but sees only its prompt and the chat
   * history. Approval is a button press, not a message, so without this block
   * Brain answers "has it started?" by guessing from conversation alone — and
   * gets it wrong. The backend owns this state, so the backend states it.
   */
  private currentStudioState(): string {
    // Every work item, not just one "active" pick: hiding a completed item
    // behind a blocked one is how Brain once reported stale progress.
    const items = this.database.sqlite.prepare(`
      SELECT wi.id, wi.title, wi.state, wi.cycle_count AS cycleCount,
             wi.developer_commit AS developerCommit, wi.tested_commit AS testedCommit,
             p.name AS projectName,
             pending.id AS pendingPlanId, pending.version AS pendingPlanVersion,
             approved.version AS approvedPlanVersion, approved.test_targets_json AS approvedTargetsJson
      FROM work_items wi
      JOIN projects p ON p.id = wi.project_id
      LEFT JOIN plan_versions pending ON wi.state = 'awaiting_plan_approval' AND pending.id = (
        SELECT id FROM plan_versions WHERE work_item_id = wi.id ORDER BY version DESC LIMIT 1
      )
      LEFT JOIN plan_versions approved ON approved.id = wi.approved_plan_id
      ORDER BY wi.id DESC LIMIT 30
    `).all() as Array<{
      id: number; title: string; state: string; cycleCount: number;
      developerCommit: string | null; testedCommit: string | null; projectName: string;
      pendingPlanId: number | null; pendingPlanVersion: number | null;
      approvedPlanVersion: number | null; approvedTargetsJson: string | null;
    }>;

    if (items.length === 0) return "# STUDIO STATE\nNo work item exists yet. Nothing is building or testing.";

    // role != 'brain': "Running now" means studio work; Brain's own
    // conversation turn is a run row too and must not describe itself.
    const running = this.database.sqlite.prepare(`
      SELECT work_item_id AS workItemId, role, model, started_at AS startedAt
      FROM agent_runs WHERE status = 'running' AND role != 'brain' ORDER BY id
    `).all() as Array<{ workItemId: number; role: string; model: string; startedAt: string }>;

    const describe = (item: (typeof items)[number]): string => {
      const base = `- Work item #${item.id} "${item.title}" [${item.projectName}]: ${item.state}`;
      if (item.state === "awaiting_plan_approval" && item.pendingPlanId) {
        return `${base} — plan #${item.pendingPlanId} (v${item.pendingPlanVersion}) awaits the user's approval.`;
      }
      if (item.state === "draft_plan") return `${base} — no plan has been submitted for approval.`;
      if (item.state === "complete") {
        return `${base} after ${item.cycleCount} cycle(s); tested commit ${item.testedCommit ?? "unknown"}.`;
      }
      if (item.state === "blocked") {
        return `${base} after ${item.cycleCount} cycle(s); needs a retry once the cause is addressed.`;
      }
      const targets = item.approvedTargetsJson ? (JSON.parse(item.approvedTargetsJson) as string[]).join(", ") : "none";
      return `${base} (cycle ${item.cycleCount}); approved plan v${item.approvedPlanVersion} targets: ${targets}.`;
    };

    return [
      "# STUDIO STATE",
      "Backend-owned and authoritative. Report it as written; never infer progress from the conversation.",
      ...items.map(describe),
      running.length
        ? `Running now: ${running.map((run) => `${run.role} (${run.model}) on work item #${run.workItemId} since ${run.startedAt}`).join("; ")}.`
        : "No agent is currently running.",
    ].join("\n");
  }

  private currentKnowledgeProject(): { id: number; name: string; slug: string; sourceCommit: string } | undefined {
    return this.database.sqlite.prepare(`
      SELECT p.id, p.name, p.slug, COALESCE(wi.developer_commit, p.accepted_commit, 'not-created') AS sourceCommit
      FROM projects p
      LEFT JOIN work_items wi ON wi.id = (
        SELECT candidate.id FROM work_items candidate
        WHERE candidate.project_id = p.id
        ORDER BY (candidate.state = 'complete') ASC, candidate.id DESC LIMIT 1
      )
      ORDER BY (wi.state IS NOT NULL AND wi.state != 'complete') DESC, COALESCE(wi.id, 0) DESC, p.id DESC
      LIMIT 1
    `).get() as { id: number; name: string; slug: string; sourceCommit: string } | undefined;
  }

  private currentKnowledgeContext(
    project: { id: number; name: string; slug: string; sourceCommit: string } | undefined,
  ): string {
    if (!this.secondBrain) return "";
    return project
      ? this.secondBrain.contextForBrain({ name: project.name, slug: project.slug }, project.sourceCommit)
      : this.secondBrain.contextForBrain();
  }

  private projectSourceCommit(projectId: number): string {
    const row = this.database.sqlite.prepare(`
      SELECT COALESCE(wi.developer_commit, p.accepted_commit, 'not-created') AS sourceCommit
      FROM projects p
      LEFT JOIN work_items wi ON wi.id = (
        SELECT candidate.id FROM work_items candidate
        WHERE candidate.project_id = p.id
        ORDER BY (candidate.state = 'complete') ASC, candidate.id DESC LIMIT 1
      )
      WHERE p.id = ?
    `).get(projectId) as { sourceCommit: string } | undefined;
    return row?.sourceCommit ?? "not-created";
  }
}
