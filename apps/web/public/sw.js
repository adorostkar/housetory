/* Housetory app-shell service worker.
 * Only same-origin shell assets are cached. Inventory and API responses are
 * deliberately never cached so private data is not persisted by the worker.
 */
const CACHE_NAME = "housetory-shell-v2";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/theme-init.js",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // API requests never need this worker. Where the browser can be told so, it
  // sends them straight to the network without waking the worker. This matters
  // for a save that is sent while the page is being left: passing through the
  // worker at that moment can lose it.
  if (typeof event.addRoutes === "function") {
    try {
      event.addRoutes([{ condition: { urlPattern: "/api/*" }, source: "network" }]);
    } catch {
      // An older form of this browser feature: the fetch handler below still lets API requests pass.
    }
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/healthz"
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match("/");
          return (
            cached ??
            new Response("Housetory is offline. Reconnect to open your home.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
