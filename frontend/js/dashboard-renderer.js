import { deriveDashboard, escapeHtml, formatEventKind, platformDisplay, renderMessageAttachments } from "./dashboard-view.js";
import { renderRunCard } from "./activity-monitor.js";

function byId(root, id) {
  return root.getElementById(id);
}

/**
 * A pasted spec arrives as one enormous bubble that swallows the whole
 * conversation panel. Past this size the bubble opens with a preview and a
 * native details toggle for the rest.
 */
const MESSAGE_CLAMP_CHARS = 700;

export function renderMessageBody(text = "") {
  const body = String(text ?? "").trim();
  if (body.length <= MESSAGE_CLAMP_CHARS) return escapeHtml(body);
  return `<details class="message-more"><summary>${escapeHtml(body.slice(0, 400))}<span class="more-hint"> … SHOW ALL ${body.length.toLocaleString()} CHARS</span></summary>${escapeHtml(body.slice(400))}</details>`;
}

function setHidden(element, hidden) {
  if (!element) return;
  if (hidden) element.setAttribute("hidden", "");
  else element.removeAttribute("hidden");
}

const PROVIDER_LABELS = {
  openai: "ChatGPT",
  claude: "Claude",
};

// The provider dropdown already says Claude/ChatGPT, so model labels carry
// only the model and version — "Claude Claude Opus 5" read twice.
const MODEL_LABELS = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
};

function options(values, selected, labels = {}) {
  return values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(labels[value] || value)}</option>`).join("");
}

export function renderModelOptions(values, selected) {
  return options(values, selected, MODEL_LABELS);
}

const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  maximum: "Maximum (legacy)",
};

/**
 * Effort ceilings differ by provider, so the catalog is keyed by provider.
 * An older backend serves one flat list — accept both, since the frontend is
 * served from disk and can be newer than the running process.
 */
export function effortsFor(catalogEfforts, provider) {
  if (Array.isArray(catalogEfforts)) return catalogEfforts;
  return catalogEfforts?.[provider] || [];
}

/** Falls back to the provider's ceiling when the stored level is not offered. */
export function renderEffortOptions(values, selected) {
  if (values.length === 0) return "";
  const resolved = values.includes(selected) ? selected : values[values.length - 1];
  return options(values, resolved, EFFORT_LABELS);
}

function scrollToLatest(messagesElement) {
  const align = () => { messagesElement.scrollTop = messagesElement.scrollHeight; };
  align();
  globalThis.requestAnimationFrame?.(align);
  const fontsReady = globalThis.document?.fonts?.ready;
  if (fontsReady && typeof fontsReady.then === "function") void fontsReady.then(align);
}

export function renderDashboard(root, data) {
  const view = deriveDashboard(data);
  setHidden(byId(root, "onboarding"), view.showWorkspace);
  setHidden(byId(root, "workspace"), !view.showWorkspace);
  byId(root, "workflow-state").textContent = view.workflowLabel;
  // The workflow state says which phase the studio is in; the run table says
  // which agent is actually executing right now. During the shared building
  // phase that distinction is the difference between "BE working" and "FE
  // working", so a live run overrides the phase-derived chip with a throbber.
  const runningRoles = new Set((data.runs || [])
    .filter((run) => run.status === "running")
    .map((run) => run.role));
  for (const [role, elementId] of [
    ["brain", "brain-status"], ["developer", "developer-status"],
    ["frontend", "frontend-status"], ["tester", "tester-status"],
  ]) {
    const chip = byId(root, elementId);
    if (runningRoles.has(role)) {
      chip.innerHTML = '<span class="throb" aria-hidden="true"><i></i><i></i><i></i></span>WORKING';
    } else {
      chip.textContent = view.agentStates[role];
    }
    root.querySelector(`.agent-card[data-role="${role}"]`)?.classList.toggle("working", runningRoles.has(role));
  }
  byId(root, "delivery-commit").textContent = view.commitLabel;

  const health = byId(root, "backend-health");
  health.textContent = data.health?.status === "online" ? " BACKEND ONLINE" : " BACKEND OFFLINE";
  health.className = `signal ${data.health?.status === "online" ? "online" : "offline"}`;
  const dot = root.createElement("i");
  health.prepend(dot);

  // Live telemetry: numbers that move are what make the console worth
  // watching, and both of these are real — the work item's actual spend and
  // its actual cycle count.
  const spendChip = byId(root, "telemetry-spend");
  if (spendChip) {
    const spent = (data.runs || []).reduce((sum, run) => sum + (run.costUsd || 0), 0);
    spendChip.textContent = `ITEM SPEND $${spent.toFixed(2)}`;
    setHidden(spendChip, (data.runs || []).length === 0);
  }
  const cycleChip = byId(root, "telemetry-cycle");
  if (cycleChip) {
    cycleChip.textContent = `CYCLE ${data.activeWorkItem?.cycleCount ?? 0}`;
    setHidden(cycleChip, !data.activeWorkItem);
  }

  const plan = data.latestPlan;
  byId(root, "plan-title").textContent = plan ? "Approved scope" : "Plan pending";
  byId(root, "plan-version").textContent = plan ? `v${plan.version}` : "—";
  byId(root, "plan-goal").textContent = plan?.goal || "Brain is preparing the plan.";
  // The side panel is a glance; the full read lives in the plan review
  // overlay. A spec-driven plan carries a dozen-plus criteria, and listing
  // them all here made the column scroll forever.
  const assumptions = Array.isArray(plan?.assumptions) ? plan.assumptions : [];
  setHidden(byId(root, "assumptions-wrap"), assumptions.length === 0);
  byId(root, "plan-assumptions").innerHTML = assumptions.length
    ? `<li class="empty">${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"} — read them in the full plan review.</li>`
    : "";
  const criteria = Array.isArray(plan?.criteria) ? plan.criteria : [];
  const criteriaPreview = criteria.slice(0, 2);
  byId(root, "criteria").innerHTML = criteria.length
    ? [
        ...criteriaPreview.map((criterion) => `<li data-status="${escapeHtml(criterion.status)}">${escapeHtml(criterion.text)}</li>`),
        ...(criteria.length > criteriaPreview.length
          ? [`<li class="empty">…and ${criteria.length - criteriaPreview.length} more — open REVIEW FULL PLAN to read every criterion.</li>`]
          : []),
      ].join("")
    : '<li class="empty">No criteria yet.</li>';
  const targets = Array.isArray(plan?.testTargets) ? plan.testTargets : [];
  const platforms = new Map((data.platforms || []).map((platform) => [platform.target, platform]));
  setHidden(byId(root, "test-targets-wrap"), targets.length === 0);
  byId(root, "test-targets").innerHTML = targets.map((target) => {
    const display = platformDisplay(platforms.get(target));
    return `<span class="target" data-status="${escapeHtml(display.status)}">${escapeHtml(String(target).toUpperCase())} · ${escapeHtml(display.label)}</span>`;
  }).join("");
  setHidden(byId(root, "plan-review-open"), !plan);
  setHidden(byId(root, "approve-plan"), !view.canApprove);
  setHidden(byId(root, "retry-workflow"), data.activeWorkItem?.state !== "blocked");
  setHidden(byId(root, "cancel-workflow"), !["ready_to_build", "building", "ready_to_test", "testing", "needs_fix"].includes(data.activeWorkItem?.state));
  setHidden(byId(root, "plan-lock"), !plan?.frozenAt);

  const messages = Array.isArray(data.messages) ? data.messages : [];
  byId(root, "messages").innerHTML = messages.length
    ? messages.map((message) => `<article class="message ${message.role === "user" ? "user" : "brain"}"><div class="meta">${escapeHtml(message.role === "user" ? "You" : "Brain")} · ${escapeHtml(message.source)}</div>${renderMessageBody(message.text)}${renderMessageAttachments(message.attachments)}</article>`).join("")
    : '<p class="empty">Start by describing what you want to build.</p>';

  const runs = Array.isArray(data.runs) ? data.runs : [];
  byId(root, "runs").innerHTML = runs.length
    ? runs.slice(0, 9).map((run) => renderRunCard(run)).join("")
    : ["brain", "developer", "frontend", "tester"].map((role) => `<article class="run-card"><span class="role">${role}</span><div class="run-state">NOT STARTED</div></article>`).join("");

  // Open findings first, and a closed one says so: a finding that reads as live
  // work after the Tester answered it is the whole reason findings now resolve.
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const orderedFindings = [...findings].sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)));
  byId(root, "findings").innerHTML = orderedFindings.length
    ? orderedFindings.map((finding) => {
      const label = finding.resolvedAt
        ? `resolved${finding.resolvedCommit ? ` at ${escapeHtml(String(finding.resolvedCommit).slice(0, 8))}` : ""}`
        : (finding.kind === "harness" ? "open · platform run" : "open");
      return `<article class="finding${finding.resolvedAt ? " resolved" : ""}"><strong>${escapeHtml(finding.title)}</strong><p class="finding-state">${label}</p><p>Expected: ${escapeHtml(finding.expected)}</p><p>Actual: ${escapeHtml(finding.actual)}</p></article>`;
    }).join("")
    : '<p class="empty">No blocking findings.</p>';

  // Terminal-style log: chronological, newest at the bottom under the
  // cursor, the way a tail -f reads. The API serves newest-first.
  const events = Array.isArray(data.events) ? [...data.events].reverse() : [];
  const timelineElement = byId(root, "timeline");
  timelineElement.innerHTML = events.length
    ? events.map((event) => `<li><time>${escapeHtml(new Date(event.createdAt).toLocaleTimeString([], { hour12: false }))}</time><span class="event-type">${formatEventKind(event.kind)} · ${escapeHtml(event.actor)}</span></li>`).join("")
    : '<li><span class="event-type">STUDIO READY</span></li>';
  timelineElement.scrollTop = timelineElement.scrollHeight;

  const models = data.catalog?.models || {};
  const efforts = data.catalog?.efforts ?? [];
  byId(root, "model-settings").innerHTML = (data.agents || []).map((agent) => {
    const providers = Object.keys(models);
    return `<div class="role-setting" data-agent="${escapeHtml(agent.id)}">
      <strong>${escapeHtml(agent.name)}</strong>
      <select data-field="provider" aria-label="${escapeHtml(agent.name)} provider">${options(providers, agent.provider, PROVIDER_LABELS)}</select>
      <select data-field="model" aria-label="${escapeHtml(agent.name)} model">${renderModelOptions(models[agent.provider] || [], agent.model)}</select>
      <select data-field="effort" aria-label="${escapeHtml(agent.name)} effort">${renderEffortOptions(effortsFor(efforts, agent.provider), agent.effort)}</select>
    </div>`;
  }).join("");

  const discord = data.discord;
  const discordSignal = byId(root, "discord-state");
  if (discordSignal) {
    const status = !discord?.configured ? "off" : discord.online ? "online" : "offline";
    discordSignal.textContent = status === "off" ? " DISCORD NOT CONFIGURED"
      : status === "online" ? " DISCORD ALERTS ON"
      : ` DISCORD OFFLINE${discord.error ? ` · ${discord.error.slice(0, 60)}` : ""}`;
    discordSignal.className = `signal ${status === "online" ? "online" : "offline"}`;
    if (status !== "off") discordSignal.prepend(root.createElement("i"));
  }

  const secondBrain = data.secondBrain || {};
  const zones = secondBrain.zones || {};
  byId(root, "second-brain-status").innerHTML = [
    ["Atlas", zones.Atlas || 0],
    ["Projects", zones.Projects || 0],
    ["zcomplete", zones.zcomplete || 0],
  ].map(([label, count]) => `<span><strong>${escapeHtml(label)}</strong> ${escapeHtml(count)}</span>`).join("");
  byId(root, "second-brain-active").textContent = secondBrain.activeProject?.path
    ? `ACTIVE · ${secondBrain.activeProject.path}`
    : "No active project notebook.";
  const proposalCount = Number(secondBrain.pendingProposals || 0);
  byId(root, "second-brain-proposals").textContent = `${proposalCount} PENDING PROPOSAL${proposalCount === 1 ? "" : "S"}`;

  const messagesElement = byId(root, "messages");
  scrollToLatest(messagesElement);
  return view;
}
