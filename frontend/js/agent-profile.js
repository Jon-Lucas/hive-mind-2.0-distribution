import { escapeHtml } from "./dashboard-view.js";
import { renderNote, renderNotes } from "./knowledge-browser.js";

const SOUL_STATUS_HINTS = {
  loaded: "ACTIVE — replaces the built-in identity on every run",
  refused: "REFUSED — running on the built-in identity instead",
  absent: "MISSING — running on the built-in identity",
  empty: "EMPTY — running on the built-in identity",
  unreadable: "UNREADABLE — running on the built-in identity",
};

export function renderPersonaList(soul) {
  if (!soul) return '<li class="empty">This agent has no persona file.</li>';
  const hint = SOUL_STATUS_HINTS[soul.status] || soul.status.toUpperCase();
  return `<li><button class="knowledge-row" data-view="persona">
    <strong>${escapeHtml(soul.path.split("/").slice(-1)[0])}</strong>
    <code>${escapeHtml(hint)}</code>
  </button></li>
  <li class="empty">Edit the file on disk; the next run picks it up without a restart.</li>`;
}

export function renderPersonaNote(soul) {
  if (!soul) return '<p class="empty">This agent has no persona file.</p>';
  if (soul.raw === null) {
    return `<p class="empty">${escapeHtml(SOUL_STATUS_HINTS[soul.status] || soul.status)}${soul.reason ? ` — ${escapeHtml(soul.reason)}` : ""}</p>
    <button class="secondary" data-action="edit-persona">CREATE PERSONA</button>`;
  }
  const refused = soul.status === "refused"
    ? `<code data-error="true">REFUSED: ${escapeHtml(soul.reason || "pattern matched")}</code>`
    : "";
  return `<header class="knowledge-note-head persona-head">
    <strong>Persona</strong>
    <button class="secondary" data-action="edit-persona">EDIT</button>
    <code>${escapeHtml(soul.path)}</code>
    ${refused}
  </header>
  <pre>${escapeHtml(soul.raw)}</pre>`;
}

export function renderPersonaEditor(soul) {
  return `<div class="persona-editor">
    <header class="knowledge-note-head">
      <strong>Editing persona</strong>
      <code>${escapeHtml(soul?.path || "")}</code>
    </header>
    <textarea data-editor="persona" spellcheck="false">${escapeHtml(soul?.raw ?? "")}</textarea>
    <div class="persona-editor-actions">
      <button class="approve" data-action="save-persona">SAVE — NEXT RUN USES IT</button>
      <button class="secondary" data-action="cancel-persona">CANCEL</button>
    </div>
  </div>`;
}

export function renderRunList(recentRuns) {
  if (!recentRuns.length) return '<li class="empty">No recorded runs yet. Brain chat turns are not billed as runs.</li>';
  return recentRuns.map((run) => {
    const cost = typeof run.costUsd === "number" ? `$${run.costUsd.toFixed(2)}` : "—";
    const minutes = typeof run.durationMs === "number" ? `${Math.round(run.durationMs / 60000)}m` : "—";
    return `<li><button class="knowledge-row" data-run="${escapeHtml(run.id)}">
      <strong>Run #${escapeHtml(run.id)} · work item #${escapeHtml(run.workItemId)}</strong>
      <code>${escapeHtml(String(run.status).toUpperCase())} · ${escapeHtml(cost)} · ${escapeHtml(minutes)}</code>
    </button></li>`;
  }).join("");
}

export function renderRunSummary(profile) {
  const { stats } = profile;
  const total = typeof stats.totalCostUsd === "number" ? stats.totalCostUsd.toFixed(2) : "0.00";
  const lines = [
    `Recorded runs: ${stats.runs}`,
    `Total recorded spend: $${total}`,
    `Last run: ${stats.lastRunAt ? `${stats.lastRunAt} UTC` : "never"}`,
  ];
  return `<header class="knowledge-note-head"><strong>Run history</strong><code>${escapeHtml(profile.agent.id)}</code></header>
  <pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

export function renderRunDetail(run) {
  if (!run) return '<p class="empty">Select a run.</p>';
  const lines = [
    `Status: ${run.status}`,
    `Work item: #${run.workItemId}`,
    `Started: ${run.startedAt} UTC`,
    `Finished: ${run.finishedAt ? `${run.finishedAt} UTC` : "—"}`,
    `Cost: ${typeof run.costUsd === "number" ? `$${run.costUsd.toFixed(4)}` : "not recorded"}`,
    `Duration: ${typeof run.durationMs === "number" ? `${Math.round(run.durationMs / 1000)}s` : "not recorded"}`,
    run.error ? `Error: ${run.error}` : "",
  ].filter(Boolean);
  return `<header class="knowledge-note-head"><strong>Run #${escapeHtml(run.id)}</strong></header>
  <pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

export function attachAgentProfile({ root, api }) {
  const dialog = root.getElementById("agent-profile");
  const list = root.getElementById("agent-profile-list");
  const viewer = root.getElementById("agent-profile-note");
  const status = root.getElementById("agent-profile-status");
  if (!dialog || !list || !viewer) return { open: () => {} };

  let profile = null;
  let tab = "persona";
  let editing = false;

  const setStatus = (message, error = false) => {
    if (!status) return;
    status.textContent = message || "";
    status.dataset.error = error ? "true" : "false";
  };

  const show = () => {
    if (!profile) return;
    const { agent, soul, memory, recentRuns } = profile;
    root.getElementById("agent-profile-eyebrow").textContent = agent.role.toUpperCase();
    root.getElementById("agent-profile-name").textContent = agent.name;
    root.getElementById("agent-profile-meta").textContent =
      `${agent.provider} · ${agent.model} · ${agent.effort} effort · ${agent.status.toUpperCase()}`;
    for (const button of root.querySelectorAll("#agent-profile-tabs [data-tab]")) {
      button.classList.toggle("active", button.dataset.tab === tab);
    }
    if (tab === "persona") {
      list.innerHTML = renderPersonaList(soul);
      viewer.innerHTML = editing ? renderPersonaEditor(soul) : renderPersonaNote(soul);
    } else if (tab === "memory") {
      list.innerHTML = memory.length
        ? renderNotes(memory)
        : '<li class="empty">No knowledge notes owned by this agent yet.</li>';
      viewer.innerHTML = renderNote(null);
    } else {
      list.innerHTML = renderRunList(recentRuns);
      viewer.innerHTML = renderRunSummary(profile);
    }
  };

  root.getElementById("agent-profile-tabs")?.addEventListener("click", (event) => {
    const selected = event.target.closest("[data-tab]");
    if (!selected) return;
    tab = selected.dataset.tab;
    editing = false;
    setStatus("");
    show();
  });

  viewer.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || !profile) return;
    if (action === "edit-persona") {
      editing = true;
      show();
      viewer.querySelector("[data-editor='persona']")?.focus();
      return;
    }
    if (action === "cancel-persona") {
      editing = false;
      setStatus("");
      show();
      return;
    }
    if (action === "save-persona") {
      const editor = viewer.querySelector("[data-editor='persona']");
      if (!editor) return;
      const button = event.target.closest("button");
      button.disabled = true;
      void api.saveAgentSoul(profile.agent.id, editor.value)
        .then(({ soul }) => {
          profile.soul = soul;
          editing = false;
          show();
          setStatus(soul.status === "loaded"
            ? "Persona saved. The next run uses it — no restart needed."
            : `Persona saved, but it was ${soul.status}${soul.reason ? ` (${soul.reason})` : ""} — the agent will run on the built-in identity until that changes.`,
            soul.status !== "loaded");
        })
        .catch((error) => {
          button.disabled = false;
          setStatus(error instanceof Error ? error.message : String(error), true);
        });
    }
  });

  list.addEventListener("click", (event) => {
    const noteButton = event.target.closest("[data-note]");
    if (noteButton) {
      void api.knowledgeNote(noteButton.dataset.note)
        .then((note) => { viewer.innerHTML = renderNote(note); })
        .catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
      return;
    }
    const runButton = event.target.closest("[data-run]");
    if (runButton && profile) {
      const run = profile.recentRuns.find((entry) => String(entry.id) === runButton.dataset.run);
      viewer.innerHTML = renderRunDetail(run);
    }
  });

  root.getElementById("agent-profile-close")?.addEventListener("click", () => {
    dialog.setAttribute("hidden", "");
  });

  return {
    open(agentId) {
      dialog.removeAttribute("hidden");
      tab = "persona";
      profile = null;
      editing = false;
      setStatus("");
      list.innerHTML = '<li class="empty">Loading…</li>';
      viewer.innerHTML = '<p class="empty">Loading…</p>';
      void api.agentProfile(agentId)
        .then((data) => { profile = data; show(); })
        .catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
    },
  };
}
