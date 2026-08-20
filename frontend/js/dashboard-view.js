// Backend and frontend developers share the workflow's single "building"
// phase, so their chips track together at this granularity.
const WORKFLOW_AGENT_STATES = {
  draft_plan: { brain: "ACTIVE", developer: "WAITING", frontend: "WAITING", tester: "WAITING" },
  awaiting_plan_approval: { brain: "ACTIVE", developer: "WAITING", frontend: "WAITING", tester: "WAITING" },
  ready_to_build: { brain: "SCOPE FROZEN", developer: "QUEUED", frontend: "QUEUED", tester: "WAITING" },
  building: { brain: "SCOPE FROZEN", developer: "ACTIVE", frontend: "ACTIVE", tester: "WAITING" },
  ready_to_test: { brain: "SCOPE FROZEN", developer: "COMMITTED", frontend: "COMMITTED", tester: "QUEUED" },
  testing: { brain: "SCOPE FROZEN", developer: "COMMITTED", frontend: "COMMITTED", tester: "ACTIVE" },
  needs_fix: { brain: "SCOPE FROZEN", developer: "ACTIVE", frontend: "ACTIVE", tester: "DEFECT FOUND" },
  blocked: { brain: "BLOCKED", developer: "BLOCKED", frontend: "BLOCKED", tester: "BLOCKED" },
  passed: { brain: "SCOPE FROZEN", developer: "COMMITTED", frontend: "COMMITTED", tester: "PASSED" },
  complete: { brain: "COMPLETE", developer: "COMPLETE", frontend: "COMPLETE", tester: "PASSED" },
};

export function deriveDashboard(data) {
  const state = data.activeWorkItem?.state || "no_project";
  const tested = data.activeWorkItem?.testedCommit;
  const delivery = data.activeWorkItem?.developerCommit;
  return {
    showWorkspace: Boolean(data.activeWorkItem || data.projects?.length || data.messages?.length),
    canApprove: Boolean(data.latestPlan && !data.latestPlan.frozenAt && state === "awaiting_plan_approval"),
    workflowLabel: state.replaceAll("_", " ").toUpperCase(),
    agentStates: WORKFLOW_AGENT_STATES[state] || { brain: "IDLE", developer: "IDLE", frontend: "IDLE", tester: "IDLE" },
    commitLabel: tested ? `TESTING ${tested}` : delivery ? `DELIVERY ${delivery}` : "NO COMMIT",
  };
}

/**
 * "Unavailable" from the probe covers two very different truths: the
 * toolchain is genuinely broken, or simply nothing has been built yet so
 * there is no checkout to probe. The second is the normal pre-build state
 * and must not wear the red label.
 */
export function platformDisplay(platform) {
  if (!platform) return { status: "unchecked", label: "UNCHECKED" };
  const checks = Array.isArray(platform.checks) ? platform.checks : [];
  const pendingBuildOnly = platform.status === "unavailable"
    && checks.length > 0
    && checks.every((check) => check.id === "exact-checkout");
  if (pendingBuildOnly) return { status: "pending", label: "READY AFTER FIRST BUILD" };
  return { status: platform.status || "unchecked", label: String(platform.status || "unchecked").toUpperCase() };
}

export function formatEventKind(kind = "event") {
  return String(kind).replaceAll("_", " ").replaceAll(".", " · ").toUpperCase();
}

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

/** Inline thumbnails for a message's reference images; click opens full size. */
export function renderMessageAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  return `<div class="message-attachments">${attachments.map((attachment) => {
    const url = `/api/brain/attachments/${encodeURIComponent(String(attachment.file || ""))}`;
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(attachment.name || "attachment")}" loading="lazy"></a>`;
  }).join("")}</div>`;
}
