/* Blink offline shell — cache-first app, network-cached data never leaves the device.
 * v1: precaches "/" so the installed PWA opens without network; static assets
 * cached on first use. Bump V to force clients onto a new shell. */
const V = "blink-v3";
const CORE = ["/"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(V)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(V).then((cache) => cache.put("/", copy));
          }
          return r;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }
  if (
    u.pathname.startsWith("/_next/static") ||
    u.pathname.startsWith("/icon") ||
    u.pathname === "/manifest.webmanifest" ||
    u.pathname === "/favicon.ico" ||
    u.pathname === "/apple-icon"
  ) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((r) => {
            const copy = r.clone();
            caches.open(V).then((cache) => cache.put(req, copy));
            return r;
          })
      )
    );
  }
});
