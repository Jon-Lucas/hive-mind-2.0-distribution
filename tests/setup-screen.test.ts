/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { waitForSetup } from "../frontend/js/setup-screen.js";

describe("setup screen", () => {
  beforeEach(() => {
    const html = fs.readFileSync(path.join(process.cwd(), "frontend", "index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  });

  it("stays hidden and resolves immediately when already ready", async () => {
    const api = { setupStatus: async () => ({ ready: true, providers: [] }) };

    await waitForSetup({ root: document, api, pollMs: 0 });

    expect(document.getElementById("setup-screen")!.hasAttribute("hidden")).toBe(true);
  });

  it("blocks and renders a not-connected provider with both connect options", async () => {
    const api = {
      setupStatus: async () => ({
        ready: false,
        providers: [{ role: "brain", provider: "claude", model: "claude-opus-5", available: false, detail: "Not logged in · Please run /login" }],
      }),
    };

    // Deliberately not awaited: with nothing to ever make it ready, the
    // returned promise never resolves — only the initial render matters here.
    void waitForSetup({ root: document, api, pollMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const screen = document.getElementById("setup-screen")!;
    expect(screen.hasAttribute("hidden")).toBe(false);
    expect(screen.textContent).toContain("Claude");
    expect(screen.textContent).toContain("Not logged in");
    expect(screen.querySelector(".setup-command")!.textContent).toBe("claude login");
    expect(screen.querySelector('.setup-key-form[data-provider="claude"]')).not.toBeNull();
  });

  it("unblocks once the recheck button reports readiness", async () => {
    let ready = false;
    const api = {
      setupStatus: async () => ({
        ready,
        providers: ready ? [] : [{ role: "brain", provider: "openai", model: "gpt-5.5", available: false, detail: "not logged in" }],
      }),
    };

    const done = waitForSetup({ root: document, api, pollMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById("setup-screen")!.hasAttribute("hidden")).toBe(false);

    ready = true;
    document.getElementById("setup-recheck")!.dispatchEvent(new Event("click", { bubbles: true }));
    await done;

    expect(document.getElementById("setup-screen")!.hasAttribute("hidden")).toBe(true);
  });

  it("saves a pasted key through the API and re-renders from the response", async () => {
    const saved: Array<[string, string]> = [];
    const api = {
      setupStatus: async () => ({
        ready: false,
        providers: [{ role: "tester", provider: "openai", model: "gpt-5.5", available: false, detail: "not logged in" }],
      }),
      saveSetupApiKey: async (provider: string, apiKey: string) => {
        saved.push([provider, apiKey]);
        return { ready: true, providers: [{ role: "tester", provider: "openai", model: "gpt-5.5", available: true, detail: "logged in" }] };
      },
    };

    const done = waitForSetup({ root: document, api, pollMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = document.querySelector(".setup-key-input") as HTMLInputElement;
    input.value = "sk-oai-test";
    document.querySelector(".setup-key-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await done;

    expect(saved).toEqual([["openai", "sk-oai-test"]]);
    expect(document.getElementById("setup-screen")!.hasAttribute("hidden")).toBe(true);
  });
});
