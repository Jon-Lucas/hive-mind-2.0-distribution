import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ATTACHMENT_MIME_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type BrainService,
  type MessageAttachment,
} from "../conversation/brain-service.js";
import type { WorkflowService } from "../workflow/workflow-service.js";

export interface DiscordBridgeConfig {
  token?: string;
  channelId?: string;
  ownerId?: string;
}

interface DiscordInput {
  channelId: string;
  userId: string;
  isBot: boolean;
}

export function isAuthorizedDiscordInput(
  config: Pick<DiscordBridgeConfig, "channelId" | "ownerId">,
  input: DiscordInput,
): boolean {
  if (input.isBot || !config.channelId || input.channelId !== config.channelId) return false;
  return !config.ownerId || input.userId === config.ownerId;
}

const PLAN_BUTTON = /^(approve|revise)_plan:(\d+)$/;

export type ButtonRouting =
  | { action: "ignore" }
  | { action: "reject" }
  | { action: "approve"; planId: number }
  | { action: "revise"; planId: number };

/**
 * Decide what a button click means to this bridge.
 *
 * Identify the button *before* checking authorization, because this bot token
 * is not exclusively ours: the Claude Code Discord plugin logs in with the same
 * token, so both processes receive every interaction on the account. A Discord
 * interaction can be acknowledged exactly once, so answering a button we do not
 * own steals the other application's click — its Allow silently never
 * registers, and the user gets our "not authorized" rejection on a control that
 * was never ours to judge. Anything unrecognised is therefore ignored in
 * silence, not rejected.
 */
export function routeButtonInteraction(
  config: Pick<DiscordBridgeConfig, "channelId" | "ownerId">,
  input: DiscordInput & { customId: string },
): ButtonRouting {
  const match = PLAN_BUTTON.exec(input.customId);
  if (!match) return { action: "ignore" };
  if (!isAuthorizedDiscordInput(config, input)) return { action: "reject" };
  return { action: match[1] === "approve" ? "approve" : "revise", planId: Number(match[2]) };
}

// Prefer line boundaries so code fences and formatting survive the split, and
// never cut between the halves of a surrogate pair.
export function chunkDiscordMessage(text: string, limit = 1_900): string[] {
  if (!text) return ["(empty response)"];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    // A high surrogate at the boundary would otherwise be orphaned.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["(empty response)"];
}

type ApprovalHandler = (workItemId: number) => void;
type ApprovalGate = () => Promise<void>;

export interface PendingApprovalButton { planId: number; version: number }

/**
 * Buttons reuse the approve_plan:<id> customId, so a click on a watchdog
 * reminder goes through the exact same interaction handler as the buttons on
 * the original plan message. Discord caps a row at five buttons.
 */
export function approvalComponents(approvals: PendingApprovalButton[]): Array<ActionRowBuilder<ButtonBuilder>> {
  if (approvals.length === 0) return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const approval of approvals.slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_plan:${approval.planId}`)
        .setLabel(`Approve plan #${approval.planId} (v${approval.version})`)
        .setStyle(ButtonStyle.Success),
    );
  }
  return [row];
}

export async function approvePlanFromDiscord(
  workflow: WorkflowService,
  planId: number,
  beforePlanApproved: ApprovalGate,
  onPlanApproved: ApprovalHandler,
): Promise<void> {
  await beforePlanApproved();
  const approved = workflow.approvePlan(planId);
  onPlanApproved(approved.workItemId);
}

interface DiscordApprovalInteraction {
  deferUpdate(): Promise<unknown>;
  editReply(payload: { content: string; components: [] }): Promise<unknown>;
}

export async function handlePlanApprovalInteraction(
  interaction: DiscordApprovalInteraction,
  workflow: WorkflowService,
  planId: number,
  beforePlanApproved: ApprovalGate,
  onPlanApproved: ApprovalHandler,
  onDeliveryError: (error: unknown) => void = () => undefined,
): Promise<boolean> {
  await interaction.deferUpdate();
  try {
    await approvePlanFromDiscord(workflow, planId, beforePlanApproved, onPlanApproved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Could not approve plan #${planId}: ${message}`, components: [] })
      .catch(onDeliveryError);
    return false;
  }
  await interaction.editReply({ content: `✅ Plan #${planId} approved. Developer is starting.`, components: [] })
    .catch(onDeliveryError);
  return true;
}

export interface DiscordImageSource {
  url: string;
  name: string | null;
  contentType: string | null;
  size: number;
}

/**
 * Discord hosts message attachments on its CDN; Brain can only Read local
 * files. Download each image into the shared attachments store so a picture
 * posted in Discord behaves exactly like one dropped into the GUI composer —
 * same allowlist, same caps, same stored-name pattern. Failures skip the one
 * file rather than the message.
 */
export async function ingestDiscordImages(
  sources: Iterable<DiscordImageSource>,
  attachmentsRoot: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<MessageAttachment[]> {
  if (!attachmentsRoot) return [];
  const stored: MessageAttachment[] = [];
  for (const source of sources) {
    if (stored.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const mime = source.contentType?.split(";")[0]?.trim() ?? "";
    const extension = ATTACHMENT_MIME_EXTENSIONS[mime];
    if (!extension || source.size <= 0 || source.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      const response = await fetcher(source.url);
      if (!response.ok) throw new Error(`attachment download returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
      fs.mkdirSync(attachmentsRoot, { recursive: true });
      const file = `${crypto.randomUUID()}${extension}`;
      fs.writeFileSync(path.join(attachmentsRoot, file), bytes);
      stored.push({ file, name: source.name || file, mime });
    } catch (error) {
      console.warn("[discord] attachment ingest failed:", error instanceof Error ? error.message : error);
    }
  }
  return stored;
}

export class DiscordBridge {
  private client: Client;
  private channel: TextBasedChannel | null = null;
  readonly state = { configured: false, online: false, error: null as string | null };
  // Re-attached on every start()/reconnect(), since rebuilding the client for a
  // reconnect drops whatever listeners were bound to the old one.
  private readonly rawMessageHandlers: Array<(message: Message) => void> = [];

  constructor(
    private readonly config: DiscordBridgeConfig,
    private readonly brain: BrainService,
    private readonly workflow: WorkflowService,
    private readonly onPlanApproved: ApprovalHandler,
    private readonly beforePlanApproved: ApprovalGate = async () => undefined,
    private readonly attachmentsRoot?: string,
  ) {
    this.client = DiscordBridge.createClient();
  }

  private static createClient(): Client {
    return new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });
  }

  /**
   * Drop the gateway connection and dial in again on a fresh client.
   *
   * A dropped gateway leaves the bridge permanently silent — discord.js keeps
   * the object alive, so nothing crashes and `KeepAlive` never notices. The
   * client is rebuilt rather than re-logged-in because `destroy()` leaves the
   * old one unusable, and its handlers would otherwise fire twice.
   */
  reconnect(): void {
    this.stop();
    this.channel = null;
    this.client = DiscordBridge.createClient();
    this.start();
  }

  start(): void {
    if (!this.config.token || !this.config.channelId) return;
    this.state.configured = true;

    this.client.once(Events.ClientReady, async () => {
      try {
        const channel = await this.client.channels.fetch(this.config.channelId!);
        if (!channel?.isTextBased()) throw new Error("configured Discord channel is not text based");
        this.channel = channel as TextBasedChannel;
        this.state.online = true;
        this.state.error = null;
        console.log(`[discord] Hive Mind 2.0 online as ${this.client.user?.tag ?? "bot"}`);
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : String(error);
        console.error("[discord] channel setup failed:", this.state.error);
      }
    });

    this.client.on("messageCreate", (message) => void this.handleMessage(message));
    for (const handler of this.rawMessageHandlers) this.client.on("messageCreate", handler);
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isButton()) return;
      const routing = routeButtonInteraction(this.config, {
        customId: interaction.customId,
        channelId: interaction.channelId ?? "",
        userId: interaction.user.id,
        isBot: interaction.user.bot,
      });
      if (routing.action === "ignore") return;
      if (routing.action === "reject") {
        void interaction.reply({ content: "This Hive Mind control is not authorized here.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return;
      }
      const planId = routing.planId;
      if (routing.action === "revise") {
        void interaction.reply({ content: `Reply with the changes you want for plan #${planId}. The approved version will remain frozen.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await handlePlanApprovalInteraction({
        deferUpdate: () => interaction.deferUpdate(),
        editReply: (payload) => interaction.editReply(payload),
      }, this.workflow, planId, this.beforePlanApproved, this.onPlanApproved, (error) => {
        console.error(`[discord] plan #${planId} interaction delivery failed:`, error);
      }).catch((error: unknown) => {
        console.error(`[discord] plan #${planId} could not be acknowledged:`, error);
      });
    });

    void this.client.login(this.config.token).catch((error: unknown) => {
      this.state.online = false;
      this.state.error = error instanceof Error ? error.message : String(error);
      console.error("[discord] login failed:", this.state.error);
    });
  }

  /**
   * Observe every message this bot account can see, regardless of channel —
   * for watchdogs that need to know about traffic in a channel this bridge
   * does not itself post to (e.g. the always-on session's `#claude-code`).
   * Call before start(): attachment happens there (and again on reconnect(),
   * against the rebuilt client), so registering the same handler twice by
   * also attaching it here would double-fire it on the very first start.
   */
  onRawMessage(handler: (message: Message) => void): void {
    this.rawMessageHandlers.push(handler);
  }

  /** Resolves false when the message reached nobody — no channel, or the send threw. */
  async notify(message: string): Promise<boolean> {
    if (!this.channel || !("send" in this.channel)) return false;
    let delivered = true;
    for (const chunk of chunkDiscordMessage(message)) {
      const sent = await this.channel.send(chunk).catch(() => undefined);
      if (!sent) delivered = false;
    }
    return delivered;
  }

  /**
   * Post into any channel this bot can see, not just the bridge-bound one.
   *
   * `notify` targets `config.channelId` — the studio's channel — so a watchdog
   * that repairs `#claude-code` and reports through it tells everyone except
   * the person actually waiting. The channel is fetched per call rather than
   * cached: these posts are rare, and a stale handle across a reconnect would
   * fail exactly when the notice matters most.
   */
  async notifyChannel(channelId: string, message: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("send" in channel)) return false;
      for (const chunk of chunkDiscordMessage(message)) await channel.send(chunk);
      return true;
    } catch (error) {
      console.error(`[discord] could not post to channel ${channelId}:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  /**
   * One editable status message. Unlike notify, callers keep the returned
   * handle and rewrite the same message via editStatus — edits do not trigger
   * push notifications, which is exactly what a rolling status line wants.
   */
  async postStatus(text: string): Promise<unknown | undefined> {
    if (!this.channel || !("send" in this.channel)) return undefined;
    const [first] = chunkDiscordMessage(text);
    return await this.channel.send(first!).catch(() => undefined) ?? undefined;
  }

  async editStatus(handle: unknown, text: string): Promise<boolean> {
    const message = handle as { edit?: (content: string) => Promise<unknown> } | undefined;
    if (typeof message?.edit !== "function") return false;
    const [first] = chunkDiscordMessage(text);
    try {
      await message.edit(first!);
      return true;
    } catch {
      return false;
    }
  }

  /** Like notify, but the final chunk carries clickable approval buttons. */
  async notifyWithApprovals(message: string, approvals: PendingApprovalButton[]): Promise<boolean> {
    if (!this.channel || !("send" in this.channel)) return false;
    const chunks = chunkDiscordMessage(message);
    let delivered = true;
    for (const [index, chunk] of chunks.entries()) {
      const payload = index === chunks.length - 1
        ? { content: chunk, components: approvalComponents(approvals) }
        : { content: chunk };
      const sent = await this.channel.send(payload).catch(() => undefined);
      if (!sent) delivered = false;
    }
    return delivered;
  }

  stop(): void {
    this.state.online = false;
    this.client.destroy();
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!isAuthorizedDiscordInput(this.config, {
      channelId: message.channelId,
      userId: message.author.id,
      isBot: message.author.bot,
    })) return;
    const text = message.content.trim();
    const attachments = await ingestDiscordImages(
      [...message.attachments.values()].map((attachment) => ({
        url: attachment.url,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
      })),
      this.attachmentsRoot,
    );
    if (!text && attachments.length === 0) return;

    await message.react("👀").catch(() => undefined);
    if ("sendTyping" in message.channel) await message.channel.sendTyping().catch(() => undefined);
    await message.react("💭").catch(() => undefined);
    try {
      const result = await this.brain.send("discord", text, attachments);
      const chunks = chunkDiscordMessage(result.message);
      const components = result.plan
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve_plan:${result.plan.id}`).setLabel(`Approve plan v${result.plan.version}`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`revise_plan:${result.plan.id}`).setLabel("Revise").setStyle(ButtonStyle.Secondary),
          )]
        : [];
      await message.reply({ content: chunks[0], components }).catch(() => undefined);
      for (const chunk of chunks.slice(1)) {
        if ("send" in message.channel) await message.channel.send(chunk).catch(() => undefined);
      }
      await message.react("✅").catch(() => undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[discord] brain turn failed:", error);
      await message.reply(`⚠️ Brain could not answer: ${detail.slice(0, 1_700)}`).catch(() => undefined);
      await message.react("⚠️").catch(() => undefined);
    }
  }
}
