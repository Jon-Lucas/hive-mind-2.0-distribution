import { describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { HiveApi } from "../frontend/js/api.js";

describe("browser API client", () => {
  it("uses only Hive Mind 2.0 workflow endpoints", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetcher = async (url: string, options: RequestInit = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const api = new HiveApi(fetcher);

    await api.bootstrap();
    await api.platforms();
    await api.sendBrain("Build it");
    await api.approvePlan(7);
    await api.retryWorkItem(9);
    await api.updateSettings("tester", { provider: "claude", model: "claude-sonnet-5", effort: "high" });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/bootstrap",
      "/api/tester/platforms",
      "/api/brain/messages",
      "/api/plans/7/approve",
      "/api/work-items/9/retry",
      "/api/agents/tester/settings",
    ]);
    expect(calls[2]!.options).toMatchObject({ method: "POST", body: JSON.stringify({ text: "Build it" }) });
    expect(calls[3]!.options.method).toBe("POST");
    expect(calls[4]!.options.method).toBe("POST");
    expect(calls[5]!.options.method).toBe("PATCH");
  });

  it("surfaces useful API errors", async () => {
    const api = new HiveApi(async () => new Response(JSON.stringify({ error: "plan is not approved" }), { status: 409 }));
    await expect(api.approvePlan(3)).rejects.toThrow("plan is not approved");
  });
});
