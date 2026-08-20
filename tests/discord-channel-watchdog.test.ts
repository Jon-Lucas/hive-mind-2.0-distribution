import { describe, expect, it, vi } from "vitest";
import {
  DiscordChannelWatchdog,
  quoteLostMessage,
  resendPrompt,
  shouldRepair,
  type WatchdogState,
} from "../src/discord/discord-channel-watchdog.js";

const policy = { staleMs: 90_000, cooldownMs: 600_000 };
const t0 = 1_000_000;

describe("shouldRepair (pure decision)", () => {
  it("does nothing before any human message has been seen", () => {
    expect(shouldRepair({ lastHumanMessageAt: null, lastBotReplyAt: null, lastRepairAt: null }, t0, policy)).toBe(false);
  });

  it("does not repair while the message is still within the grace period", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: null };
    expect(shouldRepair(state, t0 + policy.staleMs - 1, policy)).toBe(false);
  });

  it("repairs once a human message has gone unanswered past the threshold", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: null };
    expect(shouldRepair(state, t0 + policy.staleMs + 1, policy)).toBe(true);
  });

  it("does not repair once a later bot reply has answered it", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: t0 + 5_000, lastRepairAt: null };
    expect(shouldRepair(state, t0 + policy.staleMs + 1, policy)).toBe(false);
  });

  it("does not treat a reply to an earlier message as covering a newer one", () => {
    // A bot reply that predates the human message cannot be the answer to it —
    // this is exactly the case of a human message arriving after the bot's
    // last (unrelated) post.
    const state: WatchdogState = { lastHumanMessageAt: t0 + 10_000, lastBotReplyAt: t0, lastRepairAt: null };
    expect(shouldRepair(state, t0 + 10_000 + policy.staleMs + 1, policy)).toBe(true);
  });

  it("withholds a repeat repair inside the cooldown window", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: t0 + policy.staleMs + 1 };
    const later = t0 + policy.staleMs + policy.cooldownMs - 1;
    expect(shouldRepair(state, later, policy)).toBe(false);
  });

  it("allows another repair once the cooldown has elapsed", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: t0 + policy.staleMs + 1 };
    const later = t0 + policy.staleMs + policy.cooldownMs + 1;
    expect(shouldRepair(state, later, policy)).toBe(true);
  });

  it("ignores activityGraceMs entirely when the policy doesn't set it", () => {
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: null, lastActivityAt: t0 };
    expect(shouldRepair(state, t0 + policy.staleMs + 1, policy)).toBe(true);
  });

  it("withholds repair when the screen changed within the activity grace window", () => {
    const withActivity = { ...policy, activityGraceMs: 30_000 };
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: null, lastActivityAt: t0 + policy.staleMs };
    expect(shouldRepair(state, t0 + policy.staleMs + 1, withActivity)).toBe(false);
  });

  it("repairs once the activity grace window has also elapsed", () => {
    const withActivity = { ...policy, activityGraceMs: 30_000 };
    const state: WatchdogState = { lastHumanMessageAt: t0, lastBotReplyAt: null, lastRepairAt: null, lastActivityAt: t0 };
    expect(shouldRepair(state, t0 + policy.staleMs + 30_001, withActivity)).toBe(true);
  });
});

function makeClock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("DiscordChannelWatchdog", () => {
  const channelId = "channel-A";
  const otherChannelId = "channel-B";

  it("ignores traffic in other channels", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn();
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify: vi.fn() });
    watchdog.observe({ channelId: otherChannelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("repairs an unanswered message and notifies with the repair's own summary", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn().mockResolvedValue({
      ok: true,
      steps: [{ id: "bridge", status: "ok", detail: "reconnected" }],
    });
    const onNotify = vi.fn();
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify.mock.calls[0]?.[0]).toContain("bridge: reconnected");
  });

  it("does not repair twice for the same silence", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn().mockResolvedValue({ ok: true, steps: [] });
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify: vi.fn() });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();

    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("stays quiet once the session's own reply is observed", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn();
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify: vi.fn() });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(5_000);
    watchdog.observe({ channelId, isBot: true, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onRepair).not.toHaveBeenCalled();
  });

  it("notifies distinctly when the repair call itself throws", async () => {
    const clock = makeClock(t0);
    const onNotify = vi.fn();
    const watchdog = new DiscordChannelWatchdog({
      channelId, policy, now: clock.now,
      onRepair: vi.fn().mockRejectedValue(new Error("endpoint unreachable")),
      onNotify,
    });
    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify.mock.calls[0]?.[0]).toContain("endpoint unreachable");
  });

  it("withholds repair while recent activity is detected, even past stale+cooldown", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn();
    const activityPolicy = { ...policy, activityGraceMs: 30_000 };
    const checkActivity = vi.fn().mockResolvedValue(true);
    const watchdog = new DiscordChannelWatchdog({
      channelId, policy: activityPolicy, now: clock.now, onRepair, onNotify: vi.fn(), checkActivity,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(checkActivity).toHaveBeenCalledTimes(1);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("repairs once activity also stops, even though the channel stayed unanswered", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn().mockResolvedValue({ ok: true, steps: [] });
    const activityPolicy = { ...policy, activityGraceMs: 30_000 };
    const checkActivity = vi.fn().mockResolvedValue(false);
    const watchdog = new DiscordChannelWatchdog({
      channelId, policy: activityPolicy, now: clock.now, onRepair, onNotify: vi.fn(), checkActivity,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(checkActivity).toHaveBeenCalledTimes(1);
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("never spends a screen capture on a quiet channel", async () => {
    const clock = makeClock(t0);
    const checkActivity = vi.fn().mockResolvedValue(false);
    const watchdog = new DiscordChannelWatchdog({
      channelId, policy: { ...policy, activityGraceMs: 30_000 }, now: clock.now, onRepair: vi.fn(), onNotify: vi.fn(), checkActivity,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs - 1);
    await watchdog.tick();

    expect(checkActivity).not.toHaveBeenCalled();
  });

  it("does not overlap two repairs when tick is called again before the first resolves", async () => {
    const clock = makeClock(t0);
    let resolveRepair!: () => void;
    const onRepair = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveRepair = () => resolve({ ok: true, steps: [] });
    }));
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify: vi.fn() });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now() });
    clock.advance(policy.staleMs + 1);
    const first = watchdog.tick();
    await watchdog.tick(); // starts and returns immediately: a repair is already in flight
    resolveRepair();
    await first;

    expect(onRepair).toHaveBeenCalledTimes(1);
  });
});

describe("resend prompt after repair", () => {
  const channelId = "watched-channel";

  it("quotes the unanswered message and asks for a resend", () => {
    expect(resendPrompt({ content: "can we fix the calendar bug?", authorName: "Jon" }))
      .toContain("Jon: “can we fix the calendar bug?”");
  });

  it("trims a pasted wall of text down to something recognisable", () => {
    const long = "x".repeat(400);
    const quoted = quoteLostMessage(long);
    expect(quoted.length).toBeLessThanOrEqual(160);
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("collapses newlines so a multi-line message stays one quoted line", () => {
    expect(quoteLostMessage("first line\n\n  second line")).toBe("first line second line");
  });

  it("still asks for a resend when no content was captured", () => {
    expect(resendPrompt(null)).toContain("your last message");
  });

  it("posts into the watched channel, not only the studio channel", async () => {
    const clock = makeClock(t0);
    const onNotify = vi.fn();
    const onNotifyWatchedChannel = vi.fn();
    const watchdog = new DiscordChannelWatchdog({
      channelId,
      policy,
      now: clock.now,
      onRepair: vi.fn().mockResolvedValue({ ok: true, steps: [] }),
      onNotify,
      onNotifyWatchedChannel,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now(), content: "is it working now?", authorName: "Jon" });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotifyWatchedChannel).toHaveBeenCalledTimes(1);
    expect(onNotifyWatchedChannel.mock.calls[0]![0]).toContain("is it working now?");
  });

  it("does not ask for a resend when the repair itself failed", async () => {
    const clock = makeClock(t0);
    const onNotifyWatchedChannel = vi.fn();
    const watchdog = new DiscordChannelWatchdog({
      channelId,
      policy,
      now: clock.now,
      onRepair: vi.fn().mockResolvedValue({ ok: false, steps: [] }),
      onNotify: vi.fn(),
      onNotifyWatchedChannel,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now(), content: "hello", authorName: "Jon" });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onNotifyWatchedChannel).not.toHaveBeenCalled();
  });

  it("forgets the message once the session actually replies to it", async () => {
    const clock = makeClock(t0);
    const onNotifyWatchedChannel = vi.fn();
    const watchdog = new DiscordChannelWatchdog({
      channelId,
      policy,
      now: clock.now,
      onRepair: vi.fn().mockResolvedValue({ ok: true, steps: [] }),
      onNotify: vi.fn(),
      onNotifyWatchedChannel,
    });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now(), content: "answered question" });
    clock.advance(1_000);
    watchdog.observe({ channelId, isBot: true, createdAtMs: clock.now() });
    clock.advance(1_000);
    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now(), content: "the lost one" });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    const posted = onNotifyWatchedChannel.mock.calls[0]![0] as string;
    expect(posted).toContain("the lost one");
    expect(posted).not.toContain("answered question");
  });

  it("repairs exactly as before when no watched-channel notifier is wired", async () => {
    const clock = makeClock(t0);
    const onRepair = vi.fn().mockResolvedValue({ ok: true, steps: [] });
    const watchdog = new DiscordChannelWatchdog({ channelId, policy, now: clock.now, onRepair, onNotify: vi.fn() });

    watchdog.observe({ channelId, isBot: false, createdAtMs: clock.now(), content: "hi" });
    clock.advance(policy.staleMs + 1);
    await watchdog.tick();

    expect(onRepair).toHaveBeenCalledTimes(1);
  });
});
