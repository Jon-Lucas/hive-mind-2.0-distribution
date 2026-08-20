const PROVIDER_LABEL = { claude: "Claude", openai: "OpenAI / Codex" };
const PROVIDER_LOGIN_COMMAND = { claude: "claude login", openai: "codex login" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function providerCardHtml(provider) {
  const label = PROVIDER_LABEL[provider.provider] ?? provider.provider;
  const loginCommand = PROVIDER_LOGIN_COMMAND[provider.provider] ?? `${provider.provider} login`;
  const stateClass = provider.available ? "online" : "offline";
  const stateLabel = provider.available ? "CONNECTED" : "NOT CONNECTED";
  return `
    <article class="setup-provider" data-provider="${escapeHtml(provider.provider)}">
      <div class="setup-provider-head">
        <h2>${escapeHtml(label)}</h2>
        <span class="signal ${stateClass}"><i></i> ${stateLabel}</span>
      </div>
      <p class="setup-detail">${escapeHtml(provider.detail)}</p>
      ${provider.available ? "" : `
      <div class="setup-method">
        <p class="eyebrow">OPTION 1 — LOG IN FROM A TERMINAL</p>
        <code class="setup-command">${escapeHtml(loginCommand)}</code>
        <p class="muted">Run this on this machine, then click Check again.</p>
      </div>
      <div class="setup-method">
        <p class="eyebrow">OPTION 2 — PASTE AN API KEY</p>
        <form class="setup-key-form" data-provider="${escapeHtml(provider.provider)}">
          <input type="password" class="setup-key-input" placeholder="API key" aria-label="${escapeHtml(label)} API key" autocomplete="off" required>
          <button class="primary" type="submit">SAVE KEY</button>
        </form>
      </div>`}
    </article>
  `;
}

/**
 * Gate that blocks the dashboard until every model account an agent role is
 * actually configured to use is connected. A fresh install has no account
 * attached, and without this the first sign of that was a raw 409 the first
 * time someone approved a plan.
 */
export async function waitForSetup({ root = document, api, pollMs = 5_000 }) {
  const screen = root.getElementById("setup-screen");
  const providersEl = root.getElementById("setup-providers");
  const note = root.getElementById("setup-status-note");
  const recheckButton = root.getElementById("setup-recheck");
  if (!screen || !providersEl || !note || !recheckButton) return;

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let pollTimer = null;
  let checking = false;

  const render = (status) => {
    providersEl.innerHTML = status.providers.map(providerCardHtml).join("");
    providersEl.querySelectorAll(".setup-key-form").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = form.querySelector(".setup-key-input");
        const button = form.querySelector("button");
        const provider = form.getAttribute("data-provider");
        button.disabled = true;
        note.textContent = "";
        try {
          const next = await api.saveSetupApiKey(provider, input.value);
          settle(next);
        } catch (error) {
          note.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          button.disabled = false;
        }
      });
    });
  };

  const settle = (status) => {
    render(status);
    if (status.ready) {
      note.textContent = "";
      if (pollTimer) clearInterval(pollTimer);
      screen.setAttribute("hidden", "");
      resolveReady();
    } else {
      screen.removeAttribute("hidden");
    }
    return status;
  };

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      settle(await api.setupStatus());
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      checking = false;
    }
  };

  recheckButton.addEventListener("click", () => void check());
  await check();
  if (pollMs > 0) pollTimer = setInterval(() => void check(), pollMs);

  return ready;
}
