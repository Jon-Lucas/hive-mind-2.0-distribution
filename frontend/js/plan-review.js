import { escapeHtml, platformDisplay, renderMessageAttachments } from "./dashboard-view.js";

/**
 * The side panel is a glance; this is the read. A plan drafted from a real
 * spec carries a dozen-plus criteria, and the approval that freezes it
 * deserves a full-width page rather than a 300px column.
 */
export function renderPlanReview(data) {
  const plan = data?.latestPlan;
  if (!plan) return '<p class="empty">No plan has been drafted yet. Describe the product to Brain first.</p>';

  const assumptions = Array.isArray(plan.assumptions) ? plan.assumptions : [];
  const criteria = Array.isArray(plan.criteria) ? plan.criteria : [];
  const targets = Array.isArray(plan.testTargets) ? plan.testTargets : [];
  const platforms = new Map((data.platforms || []).map((platform) => [platform.target, platform]));

  const sections = [
    `<section><h3>Goal</h3><p class="plan-goal">${escapeHtml(plan.goal || "")}</p></section>`,
  ];
  const referenceImages = Array.isArray(plan.referenceImages) ? plan.referenceImages : [];
  if (referenceImages.length) {
    sections.push(`<section><h3>Reference images (${referenceImages.length})</h3><p class="muted">Frozen with the plan — the build and test agents open these exact images.</p>${renderMessageAttachments(referenceImages)}</section>`);
  }
  if (assumptions.length) {
    sections.push(`<section><h3>Assumptions (${assumptions.length})</h3><ul id="plan-review-assumptions" class="criteria">${assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`);
  }
  sections.push(`<section><h3>Acceptance criteria (${criteria.length})</h3><ol class="criteria plan-review-criteria">${criteria.map((criterion) => `<li data-status="${escapeHtml(criterion.status || "pending")}">${escapeHtml(criterion.text || "")}</li>`).join("")}</ol></section>`);
  sections.push(`<section><h3>Required platforms</h3><div class="target-list">${targets.map((target) => {
    const display = platformDisplay(platforms.get(target));
    return `<span class="target" data-status="${escapeHtml(display.status)}">${escapeHtml(String(target).toUpperCase())} · ${escapeHtml(display.label)}</span>`;
  }).join("")}</div></section>`);
  if (plan.frozenAt) {
    sections.push(`<p class="lock-note">🔒 Frozen ${escapeHtml(plan.frozenAt)} — this version is immutable and the build runs against it.</p>`);
  } else {
    sections.push('<p class="muted">Approving freezes this exact version. Want changes first? Close this and tell Brain in chat — it will draft the next version.</p>');
  }
  return sections.join("");
}

export function planReviewMeta(data) {
  const plan = data?.latestPlan;
  const item = data?.activeWorkItem;
  return {
    project: item?.projectName || "No project",
    title: item?.title || "No work item",
    meta: plan
      ? `plan v${plan.version} · ${(plan.criteria || []).length} criteria · ${String(item?.state || "").replaceAll("_", " ").toUpperCase()}`
      : "",
    canApprove: Boolean(plan && !plan.frozenAt && item?.state === "awaiting_plan_approval"),
  };
}

export function attachPlanReview({ root, api, getData, showNotice, onChanged }) {
  const overlay = root.getElementById("plan-review");
  const body = root.getElementById("plan-review-body");
  const approve = root.getElementById("plan-review-approve");
  if (!overlay || !body) return { open: () => {}, sync: () => {} };

  let isOpen = false;

  const render = () => {
    const data = getData();
    const head = planReviewMeta(data);
    root.getElementById("plan-review-project").textContent = head.project.toUpperCase();
    root.getElementById("plan-review-title").textContent = head.title;
    root.getElementById("plan-review-meta").textContent = head.meta;
    body.innerHTML = renderPlanReview(data);
    if (approve) {
      if (head.canApprove) approve.removeAttribute("hidden");
      else approve.setAttribute("hidden", "");
      approve.textContent = `APPROVE & BUILD — FREEZE v${data?.latestPlan?.version ?? ""}`;
    }
  };

  approve?.addEventListener("click", () => {
    const data = getData();
    if (!data?.latestPlan?.id) return;
    approve.disabled = true;
    void api.approvePlan(data.latestPlan.id)
      .then(async () => {
        await onChanged?.();
        showNotice?.(`Plan v${data.latestPlan.version} frozen. Backend Developer started.`);
        render();
      })
      .catch((error) => showNotice?.(error instanceof Error ? error.message : String(error), true))
      .finally(() => { approve.disabled = false; });
  });

  root.getElementById("plan-review-close")?.addEventListener("click", () => {
    isOpen = false;
    overlay.setAttribute("hidden", "");
  });

  return {
    open() {
      isOpen = true;
      overlay.removeAttribute("hidden");
      render();
    },
    /** Keeps an open review current when the dashboard refreshes underneath it. */
    sync() {
      if (isOpen) render();
    },
  };
}
