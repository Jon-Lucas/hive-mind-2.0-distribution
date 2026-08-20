import { describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { deriveDashboard } from "../frontend/js/dashboard-view.js";

describe("dashboard view state", () => {
  it("makes only an unfrozen pending plan approvable", () => {
    const view = deriveDashboard({
      agents: [
        { id: "brain", name: "Brain", status: "idle" },
        { id: "developer", name: "Developer", status: "idle" },
        { id: "tester", name: "Tester", status: "idle" },
      ],
      projects: [{ id: 1, name: "Orbit" }],
      activeWorkItem: { id: 2, state: "awaiting_plan_approval", developerCommit: null, testedCommit: null },
      latestPlan: { id: 3, version: 1, frozenAt: null, criteria: [] },
      messages: [], findings: [], runs: [], events: [],
    });

    expect(view.showWorkspace).toBe(true);
    expect(view.canApprove).toBe(true);
    expect(view.workflowLabel).toBe("AWAITING PLAN APPROVAL");
    expect(view.agentStates).toEqual({ brain: "ACTIVE", developer: "WAITING", frontend: "WAITING", tester: "WAITING" });
    expect(view.commitLabel).toBe("NO COMMIT");
  });

  it("shows Tester validating the immutable delivery commit", () => {
    const view = deriveDashboard({
      agents: [], projects: [{ id: 1 }],
      activeWorkItem: { state: "testing", developerCommit: "abc123", testedCommit: "abc123" },
      latestPlan: { id: 3, frozenAt: "2026-07-29T00:00:00Z" },
      messages: [], findings: [], runs: [], events: [],
    });

    expect(view.canApprove).toBe(false);
    expect(view.agentStates).toEqual({ brain: "SCOPE FROZEN", developer: "COMMITTED", frontend: "COMMITTED", tester: "ACTIVE" });
    expect(view.commitLabel).toBe("TESTING abc123");
  });
});

describe("message attachments", () => {
  it("renders escaped thumbnails that open the full image", async () => {
    // @ts-expect-error browser-native JavaScript module
    const { renderMessageAttachments } = await import("../frontend/js/dashboard-view.js");
    const html = renderMessageAttachments([{ file: "abc.png", name: 'ring "final".png', mime: "image/png" }]);
    expect(html).toContain('src="/api/brain/attachments/abc.png"');
    expect(html).toContain('href="/api/brain/attachments/abc.png"');
    expect(html).toContain("ring &quot;final&quot;.png");
    expect(renderMessageAttachments([])).toBe("");
    expect(renderMessageAttachments(undefined)).toBe("");
  });

  it("shows attachments in the optimistic pending exchange", async () => {
    // @ts-expect-error browser-native JavaScript module
    const { renderPendingExchange } = await import("../frontend/js/activity-monitor.js");
    const html = renderPendingExchange("match this", [{ file: "abc.png", name: "arc.png", mime: "image/png" }]);
    expect(html).toContain("match this");
    expect(html).toContain('/api/brain/attachments/abc.png');
  });
});
