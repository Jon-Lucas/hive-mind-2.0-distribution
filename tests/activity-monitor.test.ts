/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { classifyNotification, createOutputBuffer, documentTitleFor, formatDuration, parseTimestamp, renderOutput, renderPendingExchange, renderRunCard, runActivity } from "../frontend/js/activity-monitor.js";
import { RunOutputRecorder } from "../src/runs/run-output-recorder.js";
import type { AgentOutputChunk } from "../src/agents/agent-gateway.js";

const NOW = Date.parse("2026-07-30T19:00:00Z");
const running = (lastActivityAt: string) => ({
  id: 1, role: "developer", status: "running", model: "claude-opus-5", effort: "high",
  startedAt: "2026-07-30 18:27:00", lastActivityAt, finishedAt: null, restartCount: 0, error: null,
});

describe("run activity", () => {
  it("reads SQLite timestamps as UTC rather than local time", () => {
    expect(parseTimestamp("2026-07-30 18:27:00")).toBe(Date.parse("2026-07-30T18:27:00Z"));
    expect(parseTimestamp("2026-07-30T18:27:00Z")).toBe(Date.parse("2026-07-30T18:27:00Z"));
    expect(parseTimestamp(null)).toBeNull();
  });

  it("formats durations at a glance", () => {
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(93_000)).toBe("1m 33s");
    expect(formatDuration(3_960_000)).toBe("1h 06m");
  });

  it("escalates health as an agent approaches the inactivity timeout", () => {
    expect(runActivity(running("2026-07-30 18:59:58"), NOW).health).toBe("live");
    expect(runActivity(running("2026-07-30 18:59:00"), NOW).health).toBe("warn");
    expect(runActivity(running("2026-07-30 18:55:30"), NOW).health).toBe("danger");
    expect(runActivity({ ...running("2026-07-30 18:59:58"), status: "done" }, NOW).health).toBe("idle");
  });

  it("shows elapsed and quiet time on a running card", () => {
    const html = renderRunCard(running("2026-07-30 18:59:30"), NOW);
    expect(html).toContain("33m 00s elapsed");
    expect(html).toContain("quiet 30s");
    expect(html).toContain('data-health="live"');
    expect(renderRunCard(running("2026-07-30 18:58:00"), NOW)).toContain('data-health="warn"');
    expect(html).toContain("class=\"beat\"");
  });

  it("surfaces restarts and errors instead of hiding them", () => {
    const html = renderRunCard({ ...running("2026-07-30 18:59:59"), status: "failed", restartCount: 2, error: "claude developer run stalled" }, NOW);
    expect(html).toContain("2 RESTARTS");
    expect(html).toContain("claude developer run stalled");
  });

  it("escapes agent output rather than letting it inject markup", () => {
    const buffer = createOutputBuffer();
    buffer.append({ role: "developer", lines: ["<img src=x onerror=alert(1)>"] });
    const html = renderOutput("developer", buffer.linesFor("developer"));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("keeps only the most recent lines per role", () => {
    const buffer = createOutputBuffer(3);
    buffer.append({ role: "developer", lines: ["a", "b", "c", "d"] });
    buffer.append({ role: "tester", lines: ["t1"] });
    expect(buffer.linesFor("developer")).toEqual(["b", "c", "d"]);
    expect(buffer.linesFor("tester")).toEqual(["t1"]);
  });
});

describe("pending exchange rendering", () => {
  it("shows the sent message and a throbber, escaped and sweepable", () => {
    const html = renderPendingExchange('<b>plan "it"</b>');
    expect(html).toContain("message user pending");
    expect(html).toContain("Brain · thinking");
    expect(html).toContain('<span class="throb"');
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("completion signalling", () => {
  it("puts the workflow state in the tab title for a backgrounded tab", () => {
    expect(documentTitleFor("building")).toBe("▶ BUILDING · Hive Mind 2.0");
    expect(documentTitleFor("complete")).toBe("✅ COMPLETE · Hive Mind 2.0");
    expect(documentTitleFor("blocked")).toBe("⚠ BLOCKED · Hive Mind 2.0");
    expect(documentTitleFor(undefined)).toBe("Hive Mind 2.0");
  });

  it("keeps terminal outcomes on screen and lets progress fade", () => {
    expect(classifyNotification("Workflow complete. Exact passing commit abc12345 was promoted to local main."))
      .toEqual({ tone: "success", sticky: true });
    expect(classifyNotification("Workflow blocked: platform ios-simulator failed"))
      .toEqual({ tone: "error", sticky: true });
    expect(classifyNotification("Tester found 2 reproducible defects; returning work to Developer."))
      .toEqual({ tone: "error", sticky: false });
    expect(classifyNotification("Developer started cycle 1 for Local Period Tracker."))
      .toEqual({ tone: "info", sticky: false });
  });
});

describe("run output recorder", () => {
  function collect() {
    const persisted: AgentOutputChunk[] = [];
    const published: Array<{ role: string; lines: string[] }> = [];
    const touched: number[] = [];
    const recorder = new RunOutputRecorder({
      persist: (chunk) => persisted.push(chunk),
      publish: (payload) => published.push({ role: payload.role, lines: payload.lines }),
      touch: (runId) => touched.push(runId),
    });
    return { recorder, persisted, published, touched };
  }

  it("persists every chunk but publishes only complete lines", () => {
    const { recorder, persisted, published } = collect();

    recorder.record({ role: "developer", runId: 7, stream: "stdout", text: "Installing " });
    recorder.record({ role: "developer", runId: 7, stream: "stdout", text: "pods\nRunning tests\npartial" });
    recorder.flush();

    expect(persisted).toHaveLength(2);
    expect(published).toEqual([{ role: "developer", lines: ["Installing pods", "Running tests"] }]);
  });

  it("completes a split line once its remainder arrives", () => {
    const { recorder, published } = collect();

    recorder.record({ role: "tester", runId: 8, stream: "stdout", text: "half" });
    recorder.flush();
    recorder.record({ role: "tester", runId: 8, stream: "stdout", text: "-and-half\n" });
    recorder.flush();

    expect(published).toEqual([{ role: "tester", lines: ["half-and-half"] }]);
  });

  it("marks the run alive on every chunk so stalls are visible", () => {
    const { recorder, touched } = collect();

    recorder.record({ role: "developer", runId: 7, stream: "stdout", text: "a\n" });
    recorder.record({ role: "developer", runId: 7, stream: "stderr", text: "b\n" });
    recorder.record({ role: "brain", stream: "stdout", text: "c\n" });

    expect(touched).toEqual([7, 7]);
  });
});
