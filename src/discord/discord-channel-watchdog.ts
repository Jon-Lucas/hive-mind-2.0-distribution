/**
 * Auto-repair for the always-on Claude Code session behind `#claude-code`.
 *
 * That session's own failures are invisible to this backend by construction —
 * it is a separate process, and its worst failure mode (composing a reply and
 * never calling the Discord `reply` tool) leaves no error, no crash, nothing to
 * catch. The only observable signature is from *outside*: a human message in
 * the channel with no bot reply after it.
 *
 * This backend already holds a live gateway connection for its own channel
 * (`DiscordBridge`), on the same bot token the session uses. Discord delivers
 * `messageCreate` for every channel the bot can see, not just the one that
 * bridge posts to — so watching `#claude-code` costs no second login and
 * reintroduces none of the token-collision instability a second client would.
 */

export interface WatchdogState {
  lastHumanMessageAt: number | null;
  lastBotReplyAt: number | null;
  lastRepairAt: number | null;
  /** Last time the session's own terminal was observed to change. Optional so
   *  existing state literals without an activity signal keep working. */
  lastActivityAt?: number | null;
}

export interface WatchdogPolicy {
  /** How long a human message may sit unanswered before repair is allowed. */
  staleMs: number;
  /** Minimum spacing between repairs, so a stuck session can't retrigger every tick. */
  cooldownMs: number;
  /** If set, withhold repair while the session's terminal changed within this
   *  window — "unanswered" alone can't tell a still-working session apart from
   *  a genuinely wedged one, so recent screen activity overrides staleness. */
  activityGraceMs?: number;
}

/**
 * Pure decision: does the current state, judged at `now`, call for a repair?
 * Kept separate from any timer or Discord client so it can be tested against
 * contrived timestamps without a live connection.
 */
export function shouldRepair(state: WatchdogState, now: number, policy: WatchdogPolicy): boolean {
  if (state.lastHumanMessageAt === null) return false;
  const answered = state.lastBotReplyAt !== null && state.lastBotReplyAt >= state.lastHumanMessageAt;
  if (answered) return false;
  if (now - state.lastHumanMessageAt < policy.staleMs) return false;
  if (state.lastRepairAt !== null && now - state.lastRepairAt < policy.cooldownMs) return false;
  const lastActivityAt = state.lastActivityAt ?? null;
  if (policy.activityGraceMs !== undefined && lastActivityAt !== null && now - lastActivityAt < policy.activityGraceMs) {
    return false;
  }
  return true;
}

export interface WatchedMessage {
  channelId: string;
  /** True for every message the bot account itself posts — including the
   *  always-on session's replies, since it posts through the same account. */
  isBot: boolean;
  createdAtMs: number;
  /** What the human actually asked. Optional so existing observe() callers and
   *  test literals keep working, but without it a repair cannot tell the sender
   *  which message was lost. */
  content?: string;
  authorName?: string;
}

/** How much of the lost message to quote back. Long enough to recognise, short
 *  enough that a pasted stack trace does not become the whole notice. */
const QUOTE_LIMIT = 160;

export function quoteLostMessage(content: string, limit = QUOTE_LIMIT): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * What to post *into the watched channel* after a repair.
 *
 * Deliberately a resend prompt rather than an auto-replay: the Claude Code
 * plugin only delivers messages from allowlisted human senders, so re-posting
 * the text as the bot would not wake the fresh session. The honest ceiling is
 * turning a silent loss into a visible "please resend".
 */
export function resendPrompt(message: { content?: string; authorName?: string } | null): string {
  const quote = message?.content ? quoteLostMessage(message.content) : "";
  const who = message?.authorName ? `${message.authorName}: ` : "";
  const lost = quote ? ` your message (${who}“${quote}”)` : " your last message";
  return `🔄 I restarted — I never answered${lost}, and the restart cleared my context. Please resend it.`;
}

export interface ChannelWatchdogDeps {
  channelId: string;
  policy: WatchdogPolicy;
  now?: () => number;
  onRepair: () => Promise<{ ok: boolean; steps: { id: string; status: string; detail: string }[] }>;
  /** Surfaces what happened in the studio's own channel — an auto-repair that
   *  fails silently is worse than the outage. */
  onNotify: (message: string) => void;
  /** Posts into the *watched* channel. Without this the person waiting in
   *  `#claude-code` sees identical silence before and after a successful
   *  repair, because onNotify only reaches the studio channel. */
  onNotifyWatchedChannel?: (message: string) => void;
  /** Reports whether the session's own terminal changed since the last call.
   *  Only invoked once a repair is otherwise about to fire, so it costs
   *  nothing while the channel is quiet. Omit to fall back to stale+cooldown only. */
  checkActivity?: () => Promise<boolean>;
}

export class DiscordChannelWatchdog {
  private readonly state: WatchdogState = {
    lastHumanMessageAt: null,
    lastBotReplyAt: null,
    lastRepairAt: null,
    lastActivityAt: null,
  };
  private readonly now: () => number;
  private repairing = false;
  /** The human message that has gone unanswered, kept so a repair can name it.
   *  Cleared the moment the bot replies — a message that was answered is not
   *  the one to ask for again. */
  private unanswered: { content?: string; authorName?: string } | null = null;

  constructor(private readonly deps: ChannelWatchdogDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  observe(message: WatchedMessage): void {
    if (message.channelId !== this.deps.channelId) return;
    if (message.isBot) {
      this.state.lastBotReplyAt = message.createdAtMs;
      this.unanswered = null;
    } else {
      this.state.lastHumanMessageAt = message.createdAtMs;
      this.unanswered = { content: message.content, authorName: message.authorName };
    }
  }

  async tick(): Promise<void> {
    if (this.repairing) return;
    const now = this.now();
    // Cheap pass first: stale + cooldown only, so a quiet channel never pays
    // for a screen capture. Activity is checked only once repair is otherwise due.
    if (!shouldRepair(this.state, now, { staleMs: this.deps.policy.staleMs, cooldownMs: this.deps.policy.cooldownMs })) return;
    if (this.deps.checkActivity) {
      const active = await this.deps.checkActivity();
      if (active) this.state.lastActivityAt = now;
    }
    if (!shouldRepair(this.state, now, this.deps.policy)) return;
    this.repairing = true;
    this.state.lastRepairAt = now;
    const lost = this.unanswered;
    try {
      const result = await this.deps.onRepair();
      const summary = result.steps.map((step) => `${step.id}: ${step.detail}`).join(" · ");
      this.deps.onNotify(
        `⚠️ Auto-repair: #claude-code had a message unanswered for over ${Math.round(this.deps.policy.staleMs / 1000)}s. `
        + `Ran the repair (${result.ok ? "succeeded" : "partially failed"}): ${summary}`,
      );
      // Only worth asking for a resend if the session can now answer it.
      if (result.ok) this.deps.onNotifyWatchedChannel?.(resendPrompt(lost));
    } catch (error) {
      this.deps.onNotify(`⚠️ Auto-repair for #claude-code failed to run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.repairing = false;
    }
  }
}
