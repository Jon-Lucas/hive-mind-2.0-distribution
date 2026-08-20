import { escapeHtml, renderMessageAttachments } from "./dashboard-view.js";

// The runner kills an agent after five minutes of silence, so surface the
// approach to that boundary rather than only its arrival.
const STALL_WARNING_MS = 45_000;
const STALL_DANGER_MS = 4 * 60_000;
const TAIL_LINES = 40;

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** SQLite CURRENT_TIMESTAMP is UTC without a zone marker; treat it as such. */
export function parseTimestamp(value) {
  if (!value) return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function runActivity(run, now = Date.now()) {
  const started = parseTimestamp(run.startedAt);
  const active = parseTimestamp(run.lastActivityAt) ?? started;
  const running = run.status === "running";
  const silentFor = running && active !== null ? now - active : null;
  return {
    running,
    elapsed: started === null ? null : formatDuration((running ? now : parseTimestamp(run.finishedAt) ?? now) - started),
    silentFor,
    health: !running ? "idle"
      : silentFor === null ? "unknown"
      : silentFor >= STALL_DANGER_MS ? "danger"
      : silentFor >= STALL_WARNING_MS ? "warn"
      : "live",
  };
}

export function renderRunCard(run, now = Date.now()) {
  const activity = runActivity(run, now);
  const beat = activity.running
    ? `<span class="beat" data-health="${escapeHtml(activity.health)}"></span>`
    : "";
  const timing = activity.running
    ? `${escapeHtml(activity.elapsed ?? "—")} elapsed${activity.silentFor !== null ? ` · quiet ${escapeHtml(formatDuration(activity.silentFor))}` : ""}`
    : activity.elapsed
      ? `ran ${escapeHtml(activity.elapsed)}`
      : "";
  const restarts = Number(run.restartCount || 0);
  return `<article class="run-card" data-health="${escapeHtml(activity.health)}">
    <span class="role">${escapeHtml(run.role)}</span>
    <div class="run-state">${beat}${escapeHtml(String(run.status).toUpperCase())}</div>
    <code>${escapeHtml(run.model || "")}${run.effort ? ` · ${escapeHtml(run.effort)}` : ""}</code>
    ${timing ? `<code class="run-timing">${timing}</code>` : ""}
    ${restarts > 0 ? `<code class="run-restarts">${restarts} RESTART${restarts === 1 ? "" : "S"}</code>` : ""}
    ${run.error ? `<code class="run-error">${escapeHtml(String(run.error).slice(0, 160))}</code>` : ""}
  </article>`;
}

export function createOutputBuffer(limit = TAIL_LINES) {
  const byRole = new Map();
  return {
    append({ role, lines }) {
      if (!role || !Array.isArray(lines) || lines.length === 0) return;
      const existing = byRole.get(role) ?? [];
      existing.push(...lines);
      byRole.set(role, existing.slice(-limit));
    },
    linesFor(role) {
      return byRole.get(role) ?? [];
    },
    roles() {
      return [...byRole.keys()];
    },
    clear(role) {
      byRole.delete(role);
    },
  };
}

const TITLE = "Hive Mind 2.0";
const TITLE_MARKS = {
  building: "▶", ready_to_test: "▶", testing: "▶", ready_to_build: "▶",
  needs_fix: "↻", awaiting_plan_approval: "◆", draft_plan: "◆",
  complete: "✅", blocked: "⚠",
};

/** A background tab only shows its title, so put the state there. */
/**
 * Optimistic chat: the user's message and a thinking throbber appear the
 * moment they hit send, instead of the panel freezing for the whole Brain
 * turn. The next full render sweeps these away along with the rest of the
 * message list.
 */
export function renderPendingExchange(text, attachments = []) {
  return `<article class="message user pending"><div class="meta">You</div>${escapeHtml(text)}${renderMessageAttachments(attachments)}</article>
<article class="message brain pending"><div class="meta">Brain · thinking</div><span class="throb" aria-label="Brain is thinking"><i></i><i></i><i></i></span></article>`;
}

export function documentTitleFor(state) {
  if (!state || state === "no_project") return TITLE;
  const label = String(state).replaceAll("_", " ").toUpperCase();
  const mark = TITLE_MARKS[state];
  return `${mark ? `${mark} ` : ""}${label} · ${TITLE}`;
}

/** Terminal outcomes should stay put; progress can fade. */
export function classifyNotification(message = "") {
  if (/^workflow complete/i.test(message)) return { tone: "success", sticky: true };
  if (/^workflow blocked/i.test(message)) return { tone: "error", sticky: true };
  if (/reproducible defect/i.test(message)) return { tone: "error", sticky: false };
  return { tone: "info", sticky: false };
}

export function renderOutput(role, lines) {
  if (!role) return '<p class="empty">No agent is running.</p>';
  if (lines.length === 0) {
    return `<p class="empty">${escapeHtml(role.toUpperCase())} is running. Waiting for output…</p>`;
  }
  return `<header class="feed-head">${escapeHtml(role.toUpperCase())} · LIVE OUTPUT</header>
<pre>${lines.map((line) => escapeHtml(line)).join("\n")}</pre>`;
}
