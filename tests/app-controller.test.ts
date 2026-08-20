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
};

describe("dashboard controller", () => {
  beforeEach(() => {
    const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  });

  it("starts a project by sending its name and objective to the shared Brain", async () => {
    const sent: string[] = [];
    let platformCalls = 0;
    const api = {
      bootstrap: async () => emptyBootstrap,
      platforms: async () => { platformCalls += 1; return { platforms: [{ target: "web", status: "available", checks: [] }] }; },
      sendBrain: async (text: string) => { sent.push(text); return { message: "Got it" }; },
      approvePlan: async () => ({}),
      updateSettings: async () => ({}),
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    (document.querySelector("#project-name") as HTMLInputElement).value = "Orbit Notes";
    (document.querySelector("#project-objective") as HTMLTextAreaElement).value = "Create a fast local notes app";

    document.querySelector("#project-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual(["Project name: Orbit Notes\n\nObjective: Create a fast local notes app"]);
    expect(platformCalls).toBeGreaterThan(0);
    dashboard.stop();
  });

  it("retries the exact blocked active work item", async () => {
    const retried: number[] = [];
    const api = {
      bootstrap: async () => ({ ...emptyBootstrap, projects: [{ id: 1, name: "Orbit" }], activeWorkItem: { id: 23, state: "blocked" } }),
      platforms: async () => ({ platforms: [] }),
      sendBrain: async () => ({}), approvePlan: async () => ({}), updateSettings: async () => ({}),
      retryWorkItem: async (id: number) => { retried.push(id); return { state: "ready_to_build" }; },
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });

    document.querySelector("#retry-workflow")!.dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retried).toEqual([23]);
    dashboard.stop();
  });

  it("paints streamed agent output without re-fetching the whole dashboard", async () => {
    let bootstrapCalls = 0;
    const listeners: Record<string, (event: unknown) => void> = {};
    class FakeSocket {
      addEventListener(type: string, handler: (event: unknown) => void) { listeners[type] = handler; }
      close() {}
    }
    const api = {
      bootstrap: async () => { bootstrapCalls += 1; return emptyBootstrap; },
      platforms: async () => ({ platforms: [] }),
      sendBrain: async () => ({}), approvePlan: async () => ({}),
      retryWorkItem: async () => ({}), updateSettings: async () => ({}),
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: FakeSocket });
    const afterLoad = bootstrapCalls;

    listeners.message?.({ data: JSON.stringify({
      type: "agent.output",
      payload: { role: "developer", runId: 1, lines: ["Installing pods", "Added test:ios script"] },
    }) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const feed = document.querySelector("#agent-feed")!;
    expect(feed.textContent).toContain("Installing pods");
    expect(feed.textContent).toContain("DEVELOPER · LIVE OUTPUT");
    expect(bootstrapCalls, "output must not trigger a bootstrap refresh").toBe(afterLoad);

    // Other event types still refresh normally.
    listeners.message?.({ data: JSON.stringify({ type: "workflow.changed", payload: {} }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bootstrapCalls).toBeGreaterThan(afterLoad);

    dashboard.stop();
  });

  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    const sent: string[] = [];
    const api = {
      bootstrap: async () => emptyBootstrap,
      platforms: async () => ({ platforms: [] }),
      sendBrain: async (text: string) => { sent.push(text); return { message: "ok" }; },
      approvePlan: async () => ({}), retryWorkItem: async () => ({}), updateSettings: async () => ({}),
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    const input = document.querySelector("#message-input") as HTMLTextAreaElement;

    input.value = "still typing";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent, "Shift+Enter must not send").toEqual([]);

    input.value = "send this";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(["send this"]);

    dashboard.stop();
  });

  it("shows the exchange with a thinking throbber the moment it is sent, then sweeps it", async () => {
    let release: (value: unknown) => void = () => {};
    const api = {
      bootstrap: async () => emptyBootstrap,
      platforms: async () => ({ platforms: [] }),
      sendBrain: () => new Promise((resolve) => { release = resolve; }),
      approvePlan: async () => ({}), retryWorkItem: async () => ({}), updateSettings: async () => ({}),
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    (document.querySelector("#message-input") as HTMLTextAreaElement).value = "plan the tracker";
    document.querySelector("#message-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mid-turn: both bubbles visible, brain card pulsing, button relabeled.
    const pending = document.querySelectorAll("#messages .message.pending");
    expect(pending).toHaveLength(2);
    expect(pending[0]?.textContent).toContain("plan the tracker");
    expect(document.querySelector("#messages .message.pending .throb")).not.toBeNull();
    expect(document.querySelector(".agent-card[data-role='brain']")!.classList.contains("working")).toBe(true);
    expect((document.querySelector("#message-form button[type='submit']") as HTMLButtonElement).textContent).toBe("THINKING…");

    release({ message: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelectorAll("#messages .message.pending")).toHaveLength(0);
    expect(document.querySelector(".agent-card[data-role='brain']")!.classList.contains("working")).toBe(false);
    expect((document.querySelector("#message-form button[type='submit']") as HTMLButtonElement).textContent).toBe("SEND");
    dashboard.stop();
  });

  it("keeps a failure on screen until dismissed, so it cannot be mistaken for a freeze", async () => {
    const api = {
      bootstrap: async () => emptyBootstrap,
      platforms: async () => ({ platforms: [] }),
      sendBrain: async () => { throw new Error("unsupported test target: ios"); },
      approvePlan: async () => ({}), retryWorkItem: async () => ({}), updateSettings: async () => ({}),
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    (document.querySelector("#message-input") as HTMLTextAreaElement).value = "build a period tracker";

    document.querySelector("#message-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const notice = document.querySelector("#notice") as HTMLElement;
    expect(notice.textContent).toContain("unsupported test target: ios");
    expect(notice.hasAttribute("hidden")).toBe(false);

    // Still visible well past the five-second auto-hide used for successes.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(notice.hasAttribute("hidden")).toBe(false);

    notice.dispatchEvent(new Event("click", { bubbles: true }));
    expect(notice.hasAttribute("hidden")).toBe(true);
    dashboard.stop();
  });

  it("switches a role to Claude Opus 5 and persists the exact selection", async () => {
    const updates: Array<{ role: string; settings: { provider: string; model: string; effort: string } }> = [];
    const bootstrap = {
      ...emptyBootstrap,
      agents: [{ id: "developer", name: "Developer", provider: "openai", model: "gpt-5.6-sol", effort: "high" }],
      catalog: {
        models: {
          openai: ["gpt-5.5", "gpt-5.6-sol"],
          claude: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
        },
        efforts: ["low", "medium", "high", "maximum"],
      },
    };
    const api = {
      bootstrap: async () => bootstrap,
      platforms: async () => ({ platforms: [] }),
      sendBrain: async () => ({}), approvePlan: async () => ({}), retryWorkItem: async () => ({}),
      updateSettings: async (role: string, settings: { provider: string; model: string; effort: string }) => {
        updates.push({ role, settings });
        return {};
      },
    };
    const dashboard = await startDashboard({ root: document, api, WebSocketImpl: null });
    const provider = document.querySelector("[aria-label='Developer provider']") as HTMLSelectElement;
    const effort = document.querySelector("[aria-label='Developer effort']") as HTMLSelectElement;
    provider.value = "claude";
    effort.value = "high";

    provider.dispatchEvent(new Event("change", { bubbles: true }));

    const model = document.querySelector("[aria-label='Developer model']") as HTMLSelectElement;
    expect(model.value).toBe("claude-opus-5");
    expect(model.options[0]?.textContent).toBe("Opus 5");
    expect(updates).toEqual([{
      role: "developer",
      settings: { provider: "claude", model: "claude-opus-5", effort: "high" },
    }]);
    dashboard.stop();
  });
});
