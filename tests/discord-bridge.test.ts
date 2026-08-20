import { describe, expect, it } from "vitest";
import { approvalComponents, approvePlanFromDiscord, chunkDiscordMessage, DiscordBridge, handlePlanApprovalInteraction, isAuthorizedDiscordInput, routeButtonInteraction } from "../src/discord/discord-bridge.js";
import { createDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

describe("focused Discord bridge policy", () => {
  const config = { channelId: "channel-1", ownerId: "owner-1" };

  it("accepts only the configured channel and optional owner", () => {
    expect(isAuthorizedDiscordInput(config, { channelId: "channel-1", userId: "owner-1", isBot: false })).toBe(true);
    expect(isAuthorizedDiscordInput(config, { channelId: "other", userId: "owner-1", isBot: false })).toBe(false);
    expect(isAuthorizedDiscordInput(config, { channelId: "channel-1", userId: "stranger", isBot: false })).toBe(false);
    expect(isAuthorizedDiscordInput({ channelId: "channel-1" }, { channelId: "channel-1", userId: "anyone", isBot: false })).toBe(true);
    expect(isAuthorizedDiscordInput(config, { channelId: "channel-1", userId: "owner-1", isBot: true })).toBe(false);
  });

  it("stays silent on buttons belonging to another app sharing this bot token", () => {
    // The Claude Code Discord plugin relays its permission buttons through the
    // same bot account, in a DM this bridge is not configured for. Rejecting
    // those acknowledges the interaction and swallows the user's Allow, so an
    // unrecognised customId must produce no reply at all.
    const foreign = { customId: "perm:allow:qwert", channelId: "dm-9", userId: "owner-1", isBot: false };
    expect(routeButtonInteraction(config, foreign)).toEqual({ action: "ignore" });
    expect(routeButtonInteraction(config, { ...foreign, channelId: "channel-1" })).toEqual({ action: "ignore" });
  });

  it("routes its own plan buttons, and rejects them only from the wrong place", () => {
    const here = { channelId: "channel-1", userId: "owner-1", isBot: false };
    expect(routeButtonInteraction(config, { ...here, customId: "approve_plan:12" }))
      .toEqual({ action: "approve", planId: 12 });
    expect(routeButtonInteraction(config, { ...here, customId: "revise_plan:7" }))
      .toEqual({ action: "revise", planId: 7 });
    expect(routeButtonInteraction(config, { ...here, channelId: "other", customId: "approve_plan:12" }))
      .toEqual({ action: "reject" });
    expect(routeButtonInteraction(config, { ...here, userId: "stranger", customId: "approve_plan:12" }))
      .toEqual({ action: "reject" });
  });

  it("splits on line boundaries and never orphans half of a surrogate pair", () => {
    const fenced = `${"a".repeat(1_800)}\n${"b".repeat(300)}\n\`\`\`js\nconst x = 1;\n\`\`\``;
    const chunks = chunkDiscordMessage(fenced);
    expect(chunks[0]).toBe("a".repeat(1_800));
    expect(chunks[1]).toContain("```js");
    expect(chunks[1]?.startsWith("b")).toBe(true);

    const emoji = `${"b".repeat(1_899)}🚀tail`;
    for (const chunk of chunkDiscordMessage(emoji)) {
      expect(chunk).toBe(chunk.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ""));
    }
    expect(chunkDiscordMessage(emoji).join("")).toContain("🚀");
  });

  it("chunks long messages within Discord limits without losing text", () => {
    const text = "x".repeat(4_500);
    const chunks = chunkDiscordMessage(text);
    expect(chunks.every((chunk) => chunk.length <= 1_900)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("runs the shared provider gate before freezing a Discord-approved plan", async () => {
    const database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Discord Guard");
    const item = workflow.createWorkItem(project.id, "Build safely");
    const plan = workflow.createPlan(item.id, {
      goal: "Guard approval", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });

    await expect(approvePlanFromDiscord(workflow, plan.id, async () => {
      throw new Error("provider unavailable");
    }, () => undefined)).rejects.toThrow("provider unavailable");

    expect(workflow.getWorkItem(item.id).state).toBe("awaiting_plan_approval");
    database.close();
  });

  it("acknowledges before preflight and does not undo approval when the success edit fails", async () => {
    const database = createDatabase(":memory:");
    const workflow = new WorkflowService(database);
    const project = workflow.createProject("Discord Ack");
    const item = workflow.createWorkItem(project.id, "Build once");
    const plan = workflow.createPlan(item.id, {
      goal: "Acknowledge safely", assumptions: [], acceptanceCriteria: ["It works"], testTargets: ["web"],
    });
    const order: string[] = [];
    const deliveryErrors: string[] = [];

    const approved = await handlePlanApprovalInteraction({
      async deferUpdate() { order.push("acknowledge"); },
      async editReply() { order.push("edit-success"); throw new Error("Discord edit failed"); },
    }, workflow, plan.id, async () => { order.push("preflight"); }, () => { order.push("schedule"); }, (error: unknown) => {
      deliveryErrors.push(error instanceof Error ? error.message : String(error));
    });

    expect(approved).toBe(true);
    expect(order).toEqual(["acknowledge", "preflight", "schedule", "edit-success"]);
    expect(deliveryErrors).toEqual(["Discord edit failed"]);
    expect(workflow.getWorkItem(item.id).state).toBe("ready_to_build");
    database.close();
  });

  it("builds watchdog approval buttons the existing interaction handler can parse", () => {
    const rows = approvalComponents([
      { planId: 12, version: 2 },
      { planId: 15, version: 1 },
    ]);
    expect(rows).toHaveLength(1);
    const buttons = rows[0]!.components.map((button) => button.toJSON());
    expect(buttons.map((button) => "custom_id" in button && button.custom_id)).toEqual(["approve_plan:12", "approve_plan:15"]);
    for (const button of buttons) {
      const id = "custom_id" in button ? String(button.custom_id) : "";
      expect(id).toMatch(/^(approve|revise)_plan:(\d+)$/);
    }
    expect(approvalComponents([])).toEqual([]);
    // Discord rejects a row of more than five buttons; the sixth approval is dropped.
    const overflow = approvalComponents(Array.from({ length: 6 }, (_, index) => ({ planId: index + 1, version: 1 })));
    expect(overflow[0]!.components).toHaveLength(5);
  });
});

describe("Discord image ingestion", () => {
  it("stores allowed images locally and skips everything else", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { ingestDiscordImages } = await import("../src/discord/discord-bridge.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-discord-ingest-"));
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    const fetcher = (async (url: unknown) => new Response(
      String(url).includes("good") ? pngBytes : Buffer.alloc(0),
      { status: String(url).includes("missing") ? 404 : 200 },
    )) as typeof fetch;

    const stored = await ingestDiscordImages([
      { url: "https://cdn.discord/good-1", name: "ring-light.png", contentType: "image/png", size: pngBytes.length },
      { url: "https://cdn.discord/good-2", name: null, contentType: "image/jpeg; charset=binary", size: pngBytes.length },
      { url: "https://cdn.discord/pdf", name: "notes.pdf", contentType: "application/pdf", size: 10 },
      { url: "https://cdn.discord/huge", name: "huge.png", contentType: "image/png", size: 20 * 1024 * 1024 },
      { url: "https://cdn.discord/missing", name: "gone.png", contentType: "image/png", size: 10 },
    ], root, fetcher);

    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ name: "ring-light.png", mime: "image/png" });
    expect(stored[0]!.file).toMatch(/^[0-9a-f-]{36}\.png$/);
    // A nameless upload still gets a display name; the semicolon mime is normalized.
    expect(stored[1]!.mime).toBe("image/jpeg");
    expect(stored[1]!.name).toBe(stored[1]!.file);
    for (const attachment of stored) {
      expect(fs.existsSync(path.join(root, attachment.file))).toBe(true);
    }
    expect(await ingestDiscordImages([{ url: "https://cdn.discord/good-1", name: "x.png", contentType: "image/png", size: 8 }], undefined, fetcher)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("posting into a channel this bridge is not bound to", () => {
  // The watchdog repairs #claude-code but notify() only reaches the studio
  // channel, so the person waiting saw the same silence either way.
  function bridgeWith(channels: { fetch: (id: string) => Promise<unknown> }): DiscordBridge {
    const bridge = Object.create(DiscordBridge.prototype) as DiscordBridge;
    Object.assign(bridge, { client: { channels } });
    return bridge;
  }

  it("sends to the fetched channel", async () => {
    const sent: string[] = [];
    const bridge = bridgeWith({
      fetch: async () => ({ isTextBased: () => true, send: async (text: string) => { sent.push(text); } }),
    });

    expect(await bridge.notifyChannel("watched", "please resend it")).toBe(true);
    expect(sent).toEqual(["please resend it"]);
  });

  it("reports failure instead of throwing when the channel cannot be reached", async () => {
    const bridge = bridgeWith({ fetch: async () => { throw new Error("Unknown Channel"); } });
    expect(await bridge.notifyChannel("gone", "hi")).toBe(false);
  });

  it("declines a channel that cannot hold messages", async () => {
    const bridge = bridgeWith({ fetch: async () => ({ isTextBased: () => false }) });
    expect(await bridge.notifyChannel("voice", "hi")).toBe(false);
  });

  it("splits a long notice the same way notify does", async () => {
    const sent: string[] = [];
    const bridge = bridgeWith({
      fetch: async () => ({ isTextBased: () => true, send: async (text: string) => { sent.push(text); } }),
    });

    await bridge.notifyChannel("watched", "line\n".repeat(1_000));
    expect(sent.length).toBeGreaterThan(1);
  });
});
