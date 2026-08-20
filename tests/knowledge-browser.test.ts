/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { startDashboard } from "../frontend/js/app-controller.js";

const emptyBootstrap = {
  agents: [], projects: [], activeWorkItem: null, latestPlan: null,
  messages: [], findings: [], runs: [], events: [],
  catalog: { models: {}, efforts: [] }, health: { status: "online" },
  secondBrain: { zones: { Atlas: 1, Projects: 1, zcomplete: 0 }, pendingProposals: 1, activeProject: null },
};

const proposal = {
  id: "_inbox/developer/orbit/work-4-cycle-1.md",
  role: "developer", projectSlug: "orbit", workItemId: 4, cycle: 1,
  sourceCommit: "def56789abc", title: "developer proposals for work 4", updated: "2026-07-30T10:00:00.000Z",
};

function createApi(overrides: Record<string, unknown> = {}) {
  return {
    bootstrap: async () => emptyBootstrap,
    platforms: async () => ({ platforms: [] }),
    sendBrain: async () => ({}), approvePlan: async () => ({}),
    retryWorkItem: async () => ({}), updateSettings: async () => ({}),
    knowledgeZone: async () => ({ entries: [{ slug: "orbit", zone: "Projects", title: "Orbit", path: "Projects/orbit", noteCount: 8 }] }),
    knowledgeNotes: async () => ({ notes: [{ path: "Projects/orbit/STATUS.md", title: "Orbit", sourceCommit: "abc12345def", status: "verified", owner: "brain" }] }),
    knowledgeNote: async () => ({ path: "Projects/orbit/STATUS.md", title: "Orbit", content: "# Status\n\nBuilt.", sourceCommit: "abc12345def", status: "verified" }),
    knowledgeInbox: async () => ({ proposals: [proposal] }),
    resolveProposal: async () => ({ resolution: "accept", path: "Projects/orbit/decisions/filed.md", pendingProposals: 0 }),
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("second brain browser", () => {
  beforeEach(() => {
    const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  });

  it("stays closed until the operator opens it, then lists the zone", async () => {
    const dashboard = await startDashboard({ root: document, api: createApi(), WebSocketImpl: null });
    const browser = document.querySelector("#knowledge-browser")!;
    expect(browser.hasAttribute("hidden")).toBe(true);

    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    expect(browser.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#knowledge-list")!.textContent).toContain("Orbit");
    expect(document.querySelector("#knowledge-list")!.textContent).toContain("8 PAGES");
    dashboard.stop();
  });

  it("drills from an entry into a page and renders its content and provenance", async () => {
    const dashboard = await startDashboard({ root: document, api: createApi(), WebSocketImpl: null });
    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    document.querySelector("[data-entry='orbit']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    expect(document.querySelector("#knowledge-back")!.hasAttribute("hidden")).toBe(false);

    document.querySelector("[data-note]")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    const viewer = document.querySelector("#knowledge-note")!;
    expect(viewer.textContent).toContain("Built.");
    expect(viewer.textContent).toContain("VERIFIED · abc12345");
    dashboard.stop();
  });

  it("shows pending proposals as uncurated role output on the inbox tab", async () => {
    const dashboard = await startDashboard({ root: document, api: createApi(), WebSocketImpl: null });
    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    document.querySelector("[data-tab='_inbox']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    const list = document.querySelector("#knowledge-list")!;
    expect(list.textContent).toContain("DEVELOPER · orbit · WORK 4 CYCLE 1");
    expect(list.querySelector("[data-resolve='accept']")).not.toBeNull();
    expect(list.querySelector("[data-resolve='discard']")).not.toBeNull();
    dashboard.stop();
  });

  it("resolves a proposal by its exact id and refreshes the pending count", async () => {
    const resolved: Array<{ id: string; resolution: string }> = [];
    let bootstrapCalls = 0;
    const api = createApi({
      bootstrap: async () => { bootstrapCalls += 1; return emptyBootstrap; },
      resolveProposal: async (id: string, resolution: string) => {
        resolved.push({ id, resolution });
        return { resolution, path: "Projects/orbit/decisions/filed.md", pendingProposals: 0 };
      },
      knowledgeInbox: async () => ({ proposals: resolved.length ? [] : [proposal] }),
    });
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    document.querySelector("[data-tab='_inbox']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    const before = bootstrapCalls;

    document.querySelector("[data-resolve='accept']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    await settle();

    expect(resolved).toEqual([{ id: proposal.id, resolution: "accept" }]);
    expect(document.querySelector("#knowledge-list")!.textContent).toContain("No pending proposals.");
    expect(bootstrapCalls).toBeGreaterThan(before);
    dashboard.stop();
  });

  it("reports the outcome inside the panel, because the page notice renders beneath the overlay", async () => {
    const dashboard = await startDashboard({ root: document, api: createApi(), WebSocketImpl: null });
    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    document.querySelector("[data-tab='_inbox']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    const status = document.querySelector("#knowledge-status")!;
    expect(status.textContent).toBe("");

    document.querySelector("[data-resolve='accept']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    await settle();

    expect(status.textContent).toContain("Projects/orbit/decisions/filed.md");
    expect(status.getAttribute("data-error")).toBe("false");
    dashboard.stop();
  });

  it("keeps the proposal list and reports the reason when resolving fails", async () => {
    const api = createApi({
      resolveProposal: async () => { throw new Error("knowledge project not found: orbit"); },
    });
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    document.querySelector("[data-tab='_inbox']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    document.querySelector("[data-resolve='accept']")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    await settle();

    const status = document.querySelector("#knowledge-status")!;
    expect(status.textContent).toContain("knowledge project not found: orbit");
    expect(status.getAttribute("data-error")).toBe("true");
    expect(document.querySelectorAll(".knowledge-proposal")).toHaveLength(1);
    expect((document.querySelector("[data-resolve='accept']") as HTMLButtonElement).disabled).toBe(false);
    dashboard.stop();
  });

  it("surfaces a knowledge read failure instead of rendering a blank list", async () => {
    const api = createApi({ knowledgeZone: async () => { throw new Error("knowledge page not found"); } });
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });

    document.querySelector("#second-brain-open")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    expect(document.querySelector("#knowledge-list")!.textContent).toContain("knowledge page not found");
    dashboard.stop();
  });
});
