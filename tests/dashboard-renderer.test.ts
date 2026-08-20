/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { renderDashboard } from "../frontend/js/dashboard-renderer.js";

describe("dashboard renderer", () => {
  beforeEach(() => {
    const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
    const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
  });

  it("renders the authoritative plan, conversation, execution, and settings", () => {
    renderDashboard(document, {
      agents: [
        { id: "brain", name: "Brain", provider: "openai", model: "gpt-5.6-sol", effort: "high" },
        { id: "developer", name: "Developer", provider: "claude", model: "claude-opus-5", effort: "medium" },
        { id: "tester", name: "Tester", provider: "openai", model: "gpt-5.5", effort: "xhigh" },
      ],
      projects: [{ id: 1, name: "Orbit" }],
      activeWorkItem: { id: 2, state: "awaiting_plan_approval", developerCommit: null, testedCommit: null },
      latestPlan: {
        id: 3, version: 2, goal: "Ship Orbit", assumptions: ["Local first"], testTargets: ["web", "electron"], frozenAt: null,
        criteria: [{ id: 4, ordinal: 1, text: "Creates a note", status: "pending" }],
      },
      messages: [{ id: 1, role: "assistant", source: "discord", text: "Plan ready", createdAt: "2026-07-29T00:00:00Z" }],
      findings: [
        { id: 7, title: "Old crash", actual: "Crashed", expected: "Runs", resolvedAt: "2026-07-28T00:00:00Z", resolvedCommit: "d792ce745c87" },
        { id: 8, title: "Save fails", actual: "Nothing happens", expected: "Note persists" },
      ],
      runs: [{ id: 9, role: "tester", status: "failed", model: "gpt-5.5", startedAt: "2026-07-29T00:00:00Z" }],
      events: [{ id: 10, kind: "plan_ready", actor: "brain", createdAt: "2026-07-29T00:00:00Z" }],
      catalog: { models: { openai: ["gpt-5.5", "gpt-5.6-sol"], claude: ["claude-opus-5", "claude-sonnet-5"] }, efforts: { openai: ["low", "medium", "high", "xhigh"], claude: ["low", "medium", "high", "xhigh", "max"] } },
      platforms: [{ target: "web", status: "available", checks: [] }, { target: "electron", status: "unavailable", checks: [] }],
      secondBrain: {
        zones: { Atlas: 2, Projects: 1, zcomplete: 3 },
        pendingProposals: 4,
        activeProject: { slug: "orbit", zone: "Projects", path: "Projects/orbit" },
      },
      health: { status: "online" },
    });

    expect(document.querySelector("#workspace")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#onboarding")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#workflow-state")?.textContent).toBe("AWAITING PLAN APPROVAL");
    expect(document.querySelector("#developer-status")?.textContent).toBe("WAITING");
    expect(document.querySelector("#plan-goal")?.textContent).toBe("Ship Orbit");
    expect(document.querySelector("#criteria")?.textContent).toContain("Creates a note");
    // The side panel previews at most three criteria; the rest live in the
    // full plan review overlay.
    expect(document.querySelectorAll("#criteria li[data-status]").length).toBeLessThanOrEqual(3);
    expect(document.querySelector("#test-targets")?.textContent).toContain("WEB · AVAILABLE");
    expect(document.querySelector("#test-targets")?.textContent).toContain("ELECTRON · UNAVAILABLE");
    expect(document.querySelector("#messages")?.textContent).toContain("Plan ready");
    expect(document.querySelector("#findings")?.textContent).toContain("Save fails");
    // Open work sorts above answered work, and an answered finding is labelled
    // rather than reading as another live defect.
    const renderedFindings = Array.from(document.querySelectorAll("#findings .finding"));
    expect(renderedFindings.map((finding) => finding.querySelector("strong")?.textContent)).toEqual(["Save fails", "Old crash"]);
    expect(renderedFindings[1]?.classList.contains("resolved")).toBe(true);
    expect(renderedFindings[1]?.textContent).toContain("resolved at d792ce74");
    expect(document.querySelector("#runs")?.textContent).toContain("gpt-5.5");
    expect(document.querySelector("#telemetry-spend")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#telemetry-spend")?.textContent).toContain("ITEM SPEND $");
    expect(document.querySelector("#telemetry-cycle")?.textContent).toContain("CYCLE");
    expect(document.querySelector("#timeline")?.textContent).toContain("PLAN READY");
    expect(document.querySelectorAll(".role-setting")).toHaveLength(3);
    expect(document.querySelector("[aria-label='Brain provider'] option[value='openai']")?.textContent).toBe("ChatGPT");
    expect(document.querySelector("[aria-label='Developer provider'] option[value='claude']")?.textContent).toBe("Claude");
    expect(document.querySelector("[aria-label='Developer model'] option[value='claude-opus-5']")?.textContent).toBe("Opus 5");
    expect(document.querySelector("[aria-label='Developer model'] option[value='claude-sonnet-5']")?.textContent).toBe("Sonnet 5");
    expect(document.querySelector("#second-brain-status")?.textContent).toContain("Atlas 2");
    expect(document.querySelector("#second-brain-status")?.textContent).toContain("Projects 1");
    expect(document.querySelector("#second-brain-active")?.textContent).toContain("Projects/orbit");
    expect(document.querySelector("#second-brain-proposals")?.textContent).toContain("4 PENDING PROPOSALS");
    expect(document.querySelector("#approve-plan")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows retry only for a blocked active workflow", () => {
    renderDashboard(document, {
      agents: [], projects: [{ id: 1, name: "Orbit" }], activeWorkItem: { id: 2, state: "blocked" }, latestPlan: null,
      messages: [], findings: [], runs: [], events: [], platforms: [],
      catalog: { models: {}, efforts: [] }, health: { status: "online" },
    });

    expect(document.querySelector("#retry-workflow")?.hasAttribute("hidden")).toBe(false);
  });

  it("realigns the conversation after post-render layout changes", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      scheduledFrame = callback;
      return 1;
    });
    const messages = document.querySelector("#messages") as HTMLElement;
    let scrollHeight = 500;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });

    renderDashboard(document, {
      agents: [], projects: [], activeWorkItem: null, latestPlan: null,
      messages: [{ id: 1, role: "assistant", source: "gui", text: "Latest", createdAt: "2026-07-29T00:00:00Z" }],
      findings: [], runs: [], events: [], platforms: [],
      catalog: { models: {}, efforts: [] }, health: { status: "online" },
    });
    expect(messages.scrollTop).toBe(500);

    scrollHeight = 650;
    expect(scheduledFrame).toBeTypeOf("function");
    scheduledFrame?.(0);
    expect(messages.scrollTop).toBe(650);
    vi.unstubAllGlobals();
  });
});
