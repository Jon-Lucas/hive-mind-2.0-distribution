import { effortsFor, renderDashboard, renderEffortOptions, renderModelOptions } from "./dashboard-renderer.js";
import { escapeHtml } from "./dashboard-view.js";
import { attachAgentProfile } from "./agent-profile.js";
import { attachKnowledgeBrowser } from "./knowledge-browser.js";
import { attachPlanReview } from "./plan-review.js";
import { classifyNotification, createOutputBuffer, documentTitleFor, renderOutput, renderPendingExchange, renderRunCard } from "./activity-monitor.js";

function element(root, selector) {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`Missing dashboard element: ${selector}`);
  return found;
}

export async function startDashboard({ root = document, api, WebSocketImpl = globalThis.WebSocket }) {
  let data = null;
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  const clock = element(root, "#clock");
  const notice = element(root, "#notice");
  const socketState = element(root, "#socket-state");

  const feed = root.getElementById("agent-feed");
  const output = createOutputBuffer();
  let activeFeedRole = null;

  const paintFeed = () => {
    if (feed) feed.innerHTML = renderOutput(activeFeedRole, output.linesFor(activeFeedRole));
  };

  const tickClock = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // Elapsed and quiet-for counters are time-derived, so repaint the run cards
    // every second rather than waiting for the next server event.
    const running = (data?.runs || []).filter((run) => run.status === "running");
    if (running.length > 0) {
      const grid = root.getElementById("runs");
      if (grid) grid.innerHTML = (data.runs || []).slice(0, 9).map((run) => renderRunCard(run)).join("");
    }
  };
  tickClock();
  const clockTimer = setInterval(tickClock, 1_000);

  // Failures stay until dismissed or replaced. A five-second toast is easy to
  // miss, and a missed error reads as the studio having silently frozen.
  let noticeTimer = null;
  const showNotice = (message, error = false, { sticky = false } = {}) => {
    const persist = error || sticky;
    notice.textContent = persist ? `${message} (click to dismiss)` : message;
    notice.style.borderColor = error ? "var(--danger)" : "var(--green)";
    notice.style.color = error ? "var(--danger)" : "var(--green)";
    notice.style.cursor = persist ? "pointer" : "";
    notice.removeAttribute("hidden");
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = persist ? null : setTimeout(() => notice.setAttribute("hidden", ""), 5_000);
  };
  notice.addEventListener("click", () => notice.setAttribute("hidden", ""));

  const refresh = async () => {
    const [snapshot, readiness] = await Promise.all([
      api.bootstrap(),
      api.platforms().catch(() => ({ platforms: [] })),
    ]);
    data = { ...snapshot, platforms: readiness.platforms || [] };
    const running = (data.runs || []).find((run) => run.status === "running");
    if (running) activeFeedRole = running.role;
    renderDashboard(root, data);
    planReview.sync();
    paintFeed();
    const title = documentTitleFor(data.activeWorkItem?.state);
    if (root.title !== undefined && root.title !== title) root.title = title;
    return data;
  };

  const runAction = async (button, action, success, busyLabel) => {
    const restLabel = busyLabel ? button.textContent : null;
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
    try {
      await action();
      await refresh();
      if (success) showNotice(success);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      button.disabled = false;
      if (restLabel !== null) button.textContent = restLabel;
    }
  };

  element(root, "#project-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = element(root, "#project-name").value.trim();
    const objective = element(root, "#project-objective").value.trim();
    const button = element(root, "#project-form button[type='submit']");
    if (!name || !objective) return;
    void runAction(button, () => api.sendBrain(`Project name: ${name}\n\nObjective: ${objective}`), "Brain received the project brief.", "BRAIN IS READING…");
  });

  // Reference images travel ahead of the message: each file uploads the moment
  // it is chosen (or pasted, or dropped), so send itself stays instant and the
  // strip only ever shows server-confirmed thumbnails.
  const ATTACHMENT_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const MAX_COMPOSER_ATTACHMENTS = 6;
  const composerAttachments = [];
  const attachmentsStrip = element(root, "#composer-attachments");
  const attachInput = element(root, "#attach-input");
  const attachButton = element(root, "#attach-button");

  const paintComposerAttachments = () => {
    attachmentsStrip.innerHTML = composerAttachments.map((attachment, index) =>
      `<span class="composer-attachment"><img src="${attachment.url}" alt="${escapeHtml(attachment.name)}"><button type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(attachment.name)}">✕</button></span>`).join("");
    if (composerAttachments.length > 0) attachmentsStrip.removeAttribute("hidden");
    else attachmentsStrip.setAttribute("hidden", "");
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

  const addAttachments = async (files) => {
    const images = [...(files || [])].filter((file) => ATTACHMENT_MIMES.has(file.type));
    if (images.length === 0) return;
    attachButton.disabled = true;
    try {
      for (const file of images) {
        if (composerAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
          showNotice(`Up to ${MAX_COMPOSER_ATTACHMENTS} images per message.`, true);
          break;
        }
        try {
          const data = await fileToBase64(file);
          composerAttachments.push(await api.uploadAttachment({ name: file.name || "pasted-image.png", mime: file.type, data }));
        } catch (error) {
          showNotice(error instanceof Error ? error.message : String(error), true);
        }
        paintComposerAttachments();
      }
    } finally {
      attachButton.disabled = false;
    }
  };

  attachButton.addEventListener("click", () => attachInput.click());
  attachInput.addEventListener("change", () => {
    void addAttachments(attachInput.files);
    attachInput.value = "";
  });
  attachmentsStrip.addEventListener("click", (event) => {
    const index = Number(event.target?.dataset?.remove ?? NaN);
    if (!Number.isInteger(index)) return;
    composerAttachments.splice(index, 1);
    paintComposerAttachments();
  });
  element(root, "#message-input").addEventListener("paste", (event) => {
    const files = event.clipboardData?.files;
    if (files?.length) {
      event.preventDefault();
      void addAttachments(files);
    }
  });
  const conversationPanel = root.querySelector(".conversation-panel");
  if (conversationPanel) {
    for (const type of ["dragover", "dragenter"]) {
      conversationPanel.addEventListener(type, (event) => {
        if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
        event.preventDefault();
        conversationPanel.classList.add("drag-over");
      });
    }
    conversationPanel.addEventListener("dragleave", (event) => {
      if (event.target === conversationPanel || !conversationPanel.contains(event.relatedTarget)) {
        conversationPanel.classList.remove("drag-over");
      }
    });
    conversationPanel.addEventListener("drop", (event) => {
      conversationPanel.classList.remove("drag-over");
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      void addAttachments(event.dataTransfer.files);
    });
  }

  element(root, "#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = element(root, "#message-input");
    const text = input.value.trim();
    const button = element(root, "#message-form button[type='submit']");
    if (!text && composerAttachments.length === 0) return;
    // Take the strip's contents for this message; a failed send reports via
    // the notice, matching how the typed text is handled.
    const attachments = composerAttachments.splice(0).map(({ file, name, mime }) => ({ file, name, mime }));
    paintComposerAttachments();
    const messages = root.getElementById("messages");
    const brainCard = root.querySelector('.agent-card[data-role="brain"]');
    void runAction(button, async () => {
      input.value = "";
      // Show the exchange immediately: a long Brain turn otherwise looks
      // like a frozen page. The post-turn refresh re-renders the real list.
      if (messages) {
        messages.insertAdjacentHTML("beforeend", renderPendingExchange(text, attachments));
        messages.scrollTop = messages.scrollHeight;
      }
      brainCard?.classList.add("working");
      await api.sendBrain(text, attachments);
    }, undefined, "THINKING…").finally(() => {
      brainCard?.classList.remove("working");
      // On success the refresh replaced the list wholesale; on failure the
      // throbber would otherwise sit there claiming Brain is still thinking.
      for (const pending of root.querySelectorAll("#messages .message.pending")) pending.remove();
    });
  });

  // A textarea swallows Enter as a newline, which reads as "the studio ignored
  // me". Enter sends; Shift+Enter still starts a new line.
  element(root, "#message-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const form = element(root, "#message-form");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  element(root, "#approve-plan").addEventListener("click", (event) => {
    const button = event.currentTarget;
    if (!data?.latestPlan?.id) return;
    void runAction(button, () => api.approvePlan(data.latestPlan.id), `Plan v${data.latestPlan.version} frozen. Developer started.`);
  });

  element(root, "#retry-workflow").addEventListener("click", (event) => {
    const button = event.currentTarget;
    if (!data?.activeWorkItem?.id) return;
    void runAction(button, () => api.retryWorkItem(data.activeWorkItem.id), "Blocked workflow queued from a clean build boundary.");
  });

  element(root, "#cancel-workflow").addEventListener("click", (event) => {
    const button = event.currentTarget;
    if (!data?.activeWorkItem?.id) return;
    // Cancellation SIGKILLs the running agent; make a stray click harmless.
    if (!globalThis.confirm?.("Stop this work item? The running agent will be killed; completed commits are preserved.")) return;
    void runAction(button, () => api.cancelWorkItem(data.activeWorkItem.id), "Cancellation requested — the work item will stop at its current step.", "CANCELLING…");
  });

  root.getElementById("discord-repair")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    // Restarting the always-on session wipes its conversation context, which is
    // not something to discover after the fact.
    if (!globalThis.confirm?.("Repair Discord? The bridge reconnects and the always-on Claude Code session restarts with an empty context.")) return;
    void runAction(button, async () => {
      const result = await api.repairDiscord();
      // Every step reports itself — a partial repair has to say which half worked.
      const summary = (result.steps || []).map((step) => `${step.id}: ${step.detail}`).join(" · ");
      showNotice(summary || "Discord repair finished.", !result.ok, { sticky: true });
    }, null, "REPAIRING…");
  });

  const knowledge = attachKnowledgeBrowser({
    root,
    api,
    showNotice,
    onResolved: () => refresh(),
  });
  root.getElementById("second-brain-open")?.addEventListener("click", () => knowledge.open());

  const planReview = attachPlanReview({
    root,
    api,
    getData: () => data,
    showNotice,
    onChanged: () => refresh(),
  });
  root.getElementById("plan-review-open")?.addEventListener("click", () => planReview.open());

  const agentProfile = attachAgentProfile({ root, api });
  for (const card of root.querySelectorAll(".agent-card[data-role]")) {
    card.addEventListener("click", () => agentProfile.open(card.dataset.role));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      agentProfile.open(card.dataset.role);
    });
  }

  element(root, "#model-settings").addEventListener("change", (event) => {
    const changed = event.target;
    const row = changed.closest(".role-setting");
    if (!row) return;
    if (changed.dataset.field === "provider") {
      const modelSelect = row.querySelector("[data-field='model']");
      const available = data?.catalog?.models?.[changed.value] || [];
      modelSelect.innerHTML = renderModelOptions(available, available[0]);
      // Effort ceilings differ by provider: switching to one that lacks the
      // current level must re-offer that provider's own list, or the save
      // would be rejected as an unsupported selection.
      const effortSelect = row.querySelector("[data-field='effort']");
      const levels = effortsFor(data?.catalog?.efforts ?? [], changed.value);
      if (effortSelect && levels.length > 0) {
        const current = effortSelect.value;
        effortSelect.innerHTML = renderEffortOptions(levels, current);
        // Pin the selection explicitly: a rewritten option list does not
        // reliably carry its selected attribute through to the element value.
        effortSelect.value = levels.includes(current) ? current : levels[levels.length - 1];
      }
    }
    const settings = {
      provider: row.querySelector("[data-field='provider']").value,
      model: row.querySelector("[data-field='model']").value,
      effort: row.querySelector("[data-field='effort']").value,
    };
    void runAction(changed, () => api.updateSettings(row.dataset.agent, settings), `${row.dataset.agent} settings saved for the next run.`);
  });

  const connect = () => {
    if (!WebSocketImpl || stopped) {
      socketState.textContent = " LIVE UPDATES OFF";
      socketState.className = "signal offline";
      return;
    }
    const scheme = globalThis.location?.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocketImpl(`${scheme}://${globalThis.location?.host || "127.0.0.1:4401"}/ws`);
    socket.addEventListener("open", () => {
      socketState.textContent = " LIVE";
      socketState.className = "signal online";
      const dot = root.createElement("i");
      socketState.prepend(dot);
    });
    socket.addEventListener("message", (event) => {
      try {
        const incoming = JSON.parse(event.data);
        if (incoming.type === "connected") return;
        // Output arrives several times a second. Paint it directly; a full
        // bootstrap refresh per chunk would hammer the API for no benefit.
        if (incoming.type === "agent.output") {
          output.append(incoming.payload || {});
          activeFeedRole = incoming.payload?.role || activeFeedRole;
          // Live output proves the agent is active: reset the run card's
          // "quiet" counter locally instead of letting it free-run upward
          // until the next full bootstrap refresh (or a page reload).
          const activeRun = (data?.runs || []).find((run) => run.status === "running"
            && (incoming.payload?.runId ? run.id === incoming.payload.runId : run.role === incoming.payload?.role));
          if (activeRun) activeRun.lastActivityAt = new Date().toISOString().replace("T", " ").slice(0, 19);
          paintFeed();
          return;
        }
        // Milestone text is the plainest statement of what just happened, and
        // the GUI previously used it only as a refresh trigger.
        if (incoming.type === "studio.notification") {
          const message = incoming.payload?.message;
          if (message) {
            const { tone, sticky } = classifyNotification(message);
            showNotice(message, tone === "error", { sticky });
          }
        }
        void refresh().catch((error) => showNotice(error.message, true));
      } catch { /* ignore malformed external frames */ }
    });
    socket.addEventListener("close", () => {
      socketState.textContent = " RECONNECTING";
      socketState.className = "signal offline";
      if (!stopped) reconnectTimer = setTimeout(connect, 2_000);
    });
  };

  await refresh();
  connect();
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(clockTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
