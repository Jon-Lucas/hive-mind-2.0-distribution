import { escapeHtml } from "./dashboard-view.js";

export const KNOWLEDGE_TABS = ["Atlas", "Projects", "zcomplete", "_inbox"];

function provenance(item) {
  const commit = item.sourceCommit && item.sourceCommit !== "unavailable"
    ? String(item.sourceCommit).slice(0, 8)
    : "no commit";
  const status = item.status ? String(item.status).toUpperCase() : "DRAFT";
  return `<code>${escapeHtml(status)} · ${escapeHtml(commit)}</code>`;
}

export function renderEntries(entries) {
  if (!entries.length) return '<li class="empty">No entries in this zone.</li>';
  return entries.map((entry) => `<li><button class="knowledge-row" data-entry="${escapeHtml(entry.slug)}" data-zone="${escapeHtml(entry.zone)}">
    <strong>${escapeHtml(entry.title)}</strong>
    <code>${escapeHtml(entry.noteCount)} PAGE${entry.noteCount === 1 ? "" : "S"}</code>
  </button></li>`).join("");
}

export function renderNotes(notes) {
  if (!notes.length) return '<li class="empty">No pages in this notebook.</li>';
  return notes.map((note) => `<li><button class="knowledge-row" data-note="${escapeHtml(note.path)}">
    <strong>${escapeHtml(note.title)}</strong>
    ${provenance(note)}
  </button></li>`).join("");
}

export function renderProposals(proposals) {
  if (!proposals.length) return '<li class="empty">No pending proposals.</li>';
  return proposals.map((proposal) => `<li class="knowledge-proposal">
    <button class="knowledge-row" data-note="${escapeHtml(proposal.id)}">
      <strong>${escapeHtml(proposal.title)}</strong>
      <code>${escapeHtml(proposal.role.toUpperCase())} · ${escapeHtml(proposal.projectSlug)} · WORK ${escapeHtml(proposal.workItemId)} CYCLE ${escapeHtml(proposal.cycle)}</code>
      ${provenance(proposal)}
    </button>
    <div class="knowledge-actions">
      <button class="approve" data-resolve="accept" data-id="${escapeHtml(proposal.id)}">ACCEPT</button>
      <button class="secondary" data-resolve="discard" data-id="${escapeHtml(proposal.id)}">DISCARD</button>
    </div>
  </li>`).join("");
}

export function renderNote(note) {
  if (!note) return '<p class="empty">Select a page to read it.</p>';
  return `<header class="knowledge-note-head">
    <strong>${escapeHtml(note.title)}</strong>
    <code>${escapeHtml(note.path)}</code>
    ${provenance(note)}
  </header>
  <pre>${escapeHtml(note.content)}</pre>`;
}

export function attachKnowledgeBrowser({ root, api, showNotice, onResolved }) {
  const browser = root.getElementById("knowledge-browser");
  const list = root.getElementById("knowledge-list");
  const viewer = root.getElementById("knowledge-note");
  const back = root.getElementById("knowledge-back");
  const status = root.getElementById("knowledge-status");
  if (!browser || !list || !viewer) return { open: () => {} };

  let tab = "Atlas";
  let entry = null;

  const setBack = (visible) => {
    if (!back) return;
    if (visible) back.removeAttribute("hidden");
    else back.setAttribute("hidden", "");
  };

  // The browser is a full-viewport overlay, so the page-level notice renders
  // beneath it. Every outcome must also be reported inside the panel.
  const setStatus = (message, error = false) => {
    if (status) {
      status.textContent = message || "";
      status.dataset.error = error ? "true" : "false";
    }
    if (message) showNotice?.(message, error);
  };

  const fail = (error, { replaceList = true } = {}) => {
    const message = error instanceof Error ? error.message : String(error);
    if (replaceList) list.innerHTML = `<li class="empty">${escapeHtml(message)}</li>`;
    setStatus(message, true);
  };

  const load = async () => {
    try {
      if (tab === "_inbox") {
        const { proposals } = await api.knowledgeInbox();
        list.innerHTML = renderProposals(proposals || []);
      } else if (entry) {
        const { notes } = await api.knowledgeNotes(tab, entry);
        list.innerHTML = renderNotes(notes || []);
      } else {
        const { entries } = await api.knowledgeZone(tab);
        list.innerHTML = renderEntries(entries || []);
      }
      setBack(Boolean(entry));
    } catch (error) {
      fail(error);
    }
  };

  root.getElementById("knowledge-tabs")?.addEventListener("click", (event) => {
    const selected = event.target.closest("[data-tab]");
    if (!selected) return;
    tab = selected.dataset.tab;
    entry = null;
    setStatus("");
    viewer.innerHTML = renderNote(null);
    for (const button of root.querySelectorAll("#knowledge-tabs [data-tab]")) {
      button.classList.toggle("active", button.dataset.tab === tab);
    }
    void load();
  });

  back?.addEventListener("click", () => {
    entry = null;
    viewer.innerHTML = renderNote(null);
    void load();
  });

  list.addEventListener("click", (event) => {
    const resolve = event.target.closest("[data-resolve]");
    if (resolve) {
      const { id, resolve: resolution } = resolve.dataset;
      resolve.disabled = true;
      setStatus(resolution === "accept" ? "Filing proposal…" : "Discarding proposal…");
      void api.resolveProposal(id, resolution)
        .then(async (result) => {
          viewer.innerHTML = renderNote(null);
          await load();
          setStatus(resolution === "accept"
            ? `Proposal filed at ${result.path}.`
            : "Proposal discarded.");
          await onResolved?.();
        })
        .catch((error) => {
          resolve.disabled = false;
          fail(error, { replaceList: false });
        });
      return;
    }

    const noteButton = event.target.closest("[data-note]");
    if (noteButton) {
      void api.knowledgeNote(noteButton.dataset.note)
        .then((note) => { viewer.innerHTML = renderNote(note); })
        .catch(fail);
      return;
    }

    const entryButton = event.target.closest("[data-entry]");
    if (entryButton) {
      entry = entryButton.dataset.entry;
      void load();
    }
  });

  root.getElementById("knowledge-close")?.addEventListener("click", () => {
    browser.setAttribute("hidden", "");
  });

  return {
    open() {
      browser.removeAttribute("hidden");
      setStatus("");
      viewer.innerHTML = renderNote(null);
      void load();
    },
  };
}
