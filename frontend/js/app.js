import { HiveApi } from "./api.js";
import { startDashboard } from "./app-controller.js";
import { waitForSetup } from "./setup-screen.js";

// An old PWA-era service worker can keep serving a stale UI long after the
// self-destructing sw.js replaced it, and it only heals if the browser
// happens to re-check the script. Evict any registration and its caches
// outright on every load; on a controlled page, reload once so the fresh
// network copy takes over immediately.
void (async () => {
  try {
    const wasControlled = Boolean(navigator.serviceWorker?.controller);
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const cacheKeys = await globalThis.caches?.keys?.() ?? [];
    await Promise.all(cacheKeys.map((key) => globalThis.caches.delete(key)));
    if (wasControlled && registrations.length > 0 && !sessionStorage.getItem("sw-evicted")) {
      sessionStorage.setItem("sw-evicted", "1");
      location.reload();
    }
  } catch { /* cache hygiene must never block the dashboard */ }
})();

const api = new HiveApi();
await waitForSetup({ api });
const dashboard = await startDashboard({ api });
window.addEventListener("beforeunload", () => dashboard.stop(), { once: true });
