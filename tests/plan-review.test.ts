import { describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { planReviewMeta, renderPlanReview } from "../frontend/js/plan-review.js";
// @ts-expect-error browser-native JavaScript module
import { renderMessageBody } from "../frontend/js/dashboard-renderer.js";

const data = {
  activeWorkItem: {
    id: 5,
    title: "M1 core loop — Ebb",
    state: "awaiting_plan_approval",
    projectName: "Ebb — Offline Period Tracker",
  },
  latestPlan: {
    id: 9,
    version: 2,
    goal: "Ship Milestone 1 with the cycle-day ring.",
    frozenAt: null,
    assumptions: ["React Native", "<script>alert(1)</script>"],
    testTargets: ["android-emulator"],
    criteria: [
      { ordinal: 1, text: "Home shows the cycle-day ring", status: "pending" },
      { ordinal: 2, text: "Calendar marks logged days", status: "pending" },
    ],
  },
  platforms: [{ target: "android-emulator", status: "available" }],
};

describe("plan review page", () => {
  it("lays out goal, assumptions, criteria, and platform readiness", () => {
    const html = renderPlanReview(data);
    expect(html).toContain("Ship Milestone 1 with the cycle-day ring.");
    expect(html).toContain("Assumptions (2)");
    expect(html).toContain("Acceptance criteria (2)");
    expect(html).toContain("Home shows the cycle-day ring");
    expect(html).toContain("ANDROID-EMULATOR · AVAILABLE");
    expect(html).toContain("Approving freezes this exact version");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the freeze note instead of the approval hint once frozen", () => {
    const frozen = { ...data, latestPlan: { ...data.latestPlan, frozenAt: "2026-07-31 17:00:00" } };
    const html = renderPlanReview(frozen);
    expect(html).toContain("Frozen 2026-07-31 17:00:00");
    expect(html).not.toContain("Approving freezes this exact version");
  });

  it("permits approval only for an unfrozen plan awaiting approval", () => {
    expect(planReviewMeta(data)).toMatchObject({
      project: "Ebb — Offline Period Tracker",
      title: "M1 core loop — Ebb",
      canApprove: true,
    });
    expect(planReviewMeta(data).meta).toContain("plan v2 · 2 criteria");
    expect(planReviewMeta({
      ...data,
      latestPlan: { ...data.latestPlan, frozenAt: "2026-07-31" },
    }).canApprove).toBe(false);
    expect(planReviewMeta({
      ...data,
      activeWorkItem: { ...data.activeWorkItem, state: "building" },
    }).canApprove).toBe(false);
    expect(planReviewMeta({}).canApprove).toBe(false);
  });

  it("explains itself when no plan exists yet", () => {
    expect(renderPlanReview({})).toContain("No plan has been drafted yet");
  });
});

describe("platform chips", () => {
  it("labels the normal pre-build state calmly instead of UNAVAILABLE", () => {
    const preBuild = {
      ...data,
      platforms: [{
        target: "android-emulator",
        status: "unavailable",
        checks: [{ id: "exact-checkout", status: "missing", detail: "pending exact Tester checkout for the current Developer commit" }],
      }],
    };
    const html = renderPlanReview(preBuild);
    expect(html).toContain("ANDROID-EMULATOR · READY AFTER FIRST BUILD");
    expect(html).toContain('data-status="pending"');
    expect(html).not.toContain("UNAVAILABLE");
  });

  it("keeps genuine unavailability loud", () => {
    const broken = {
      ...data,
      platforms: [{
        target: "android-emulator",
        status: "unavailable",
        checks: [{ id: "emulator-binary", status: "missing", detail: "emulator not found on PATH" }],
      }],
    };
    expect(renderPlanReview(broken)).toContain("ANDROID-EMULATOR · UNAVAILABLE");
  });
});

describe("long chat messages", () => {
  it("collapses a pasted spec behind a preview with a show-all toggle", () => {
    const spec = `# SPEC\n${"All work and no play. ".repeat(200)}<script>x</script>`;
    const html = renderMessageBody(spec);
    expect(html).toContain("<details");
    expect(html).toContain("SHOW ALL");
    expect(html).toContain(spec.length.toLocaleString());
    expect(html).not.toContain("<script>");
  });

  it("leaves ordinary messages untouched", () => {
    expect(renderMessageBody("short reply")).toBe("short reply");
    expect(renderMessageBody("a & b")).toBe("a &amp; b");
  });
});
