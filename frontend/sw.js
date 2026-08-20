// Self-destructing worker: kills any previously-installed SW + its caches.
// Kept as a file (not deleted) so already-registered clients still fetch it
// and self-unregister rather than keep serving stale cached assets forever.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
  )
);
