/* Housetory app-shell service worker.
 *
 * Without an offline copy: only same-origin shell assets are cached. Inventory
 * and API responses are never cached, so no private data is kept by the worker.
 *
 * With an offline copy (Settings, Offline copy; off until the person turns it
 * on): the page itself saves the app's code and one small photo per item in two
 * more caches. This worker only reads them, when the server cannot be reached.
 * It still never writes an API response to a cache.
 */
const CACHE_NAME = "housetory-shell-v3";
// Written by the page (src/lib/offline/device-cache.ts). The app cache exists
// only on a device that keeps an offline copy.
const OFFLINE_APP_CACHE = "housetory-offline-app-v1";
const OFFLINE_PHOTO_CACHE = "housetory-offline-photos-v1";
const KEPT_CACHES = [CACHE_NAME, OFFLINE_APP_CACHE, OFFLINE_PHOTO_CACHE];
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/theme-init.js",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
// How long the server gets to answer before the saved file is used instead.
const PAGE_WAIT_MS = 3000;
const FILE_WAIT_MS = 1500;
const PHOTO_WAIT_MS = 4000;

// What is known about the offline copy and the server. `enabled` is read from
// the caches when the page has not said it yet. `online` follows what the page
// says, and what loading the page itself showed.
const offline = { enabled: undefined, online: true };

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "housetory-offline") {
    offline.enabled = Boolean(data.enabled);
    offline.online = data.online !== false;
  } else if (data.type === "housetory-claim") {
    // A page that this worker does not control yet asks to be taken.
    event.waitUntil(self.clients.claim());
  } else if (data.type === "housetory-offline-ask") {
    // A page that just opened asks if the server answered when it was loaded.
    event.source?.postMessage({ type: "housetory-offline-state", online: offline.online });
  }
});

async function offlineEnabled() {
  if (offline.enabled === undefined) offline.enabled = await caches.has(OFFLINE_APP_CACHE);
  return offline.enabled;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

self.addEventListener("install", (event) => {
  // API requests never need this worker. Where the browser can be told so, it
  // sends them straight to the network without waking the worker. This matters
  // for a save that is sent while the page is being left: passing through the
  // worker at that moment can lose it. Pictures are the exception: a saved
  // photo can stand in for one the server cannot send.
  if (typeof event.addRoutes === "function") {
    try {
      event.addRoutes([
        {
          condition: { urlPattern: "/api/*", requestDestination: "image" },
          source: "fetch-event",
        },
        { condition: { urlPattern: "/api/*" }, source: "network" },
      ]);
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
        Promise.all(keys.filter((key) => !KEPT_CACHES.includes(key)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_TEXT = new Response("Housetory is offline. Reconnect to open your home.", {
  status: 503,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
});

async function page(request) {
  const shell = () => caches.match("/", { cacheName: CACHE_NAME });
  const enabled = await offlineEnabled();
  // The page said the server is gone: do not make the person wait for it again.
  if (enabled && !offline.online) {
    const cached = await shell();
    if (cached) return cached;
  }
  try {
    const response = await (enabled ? withTimeout(fetch(request), PAGE_WAIT_MS) : fetch(request));
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
    }
    offline.online = true;
    return response;
  } catch {
    // Remembered, so the files of the page are not asked from the server one by
    // one, and the page can be told at once that it starts without the server.
    if (enabled) offline.online = false;
    return (await shell()) ?? OFFLINE_TEXT.clone();
  }
}

/** A file of the shell (theme script, icons, manifest): the server first, the saved one if it fails. */
async function shellFile(request) {
  const enabled = await offlineEnabled();
  try {
    if (enabled && !offline.online) throw new Error("offline");
    return await (enabled ? withTimeout(fetch(request), FILE_WAIT_MS) : fetch(request));
  } catch (error) {
    const cached = await caches.match(request, { cacheName: CACHE_NAME });
    if (cached) return cached;
    throw error;
  }
}

async function asset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

// Shown where a picture is not part of the offline copy.
const NO_PHOTO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#8a8a80" fill-opacity="0.14"/></svg>';

/** A picture from the API. On a device with an offline copy, the saved small photo stands in when the server does not answer. */
async function photo(request, url) {
  if (!(await offlineEnabled())) return fetch(request);
  const saved = async () => {
    // The full-size file of an item photo is answered with its small saved copy.
    const key = url.pathname.replace(/^(\/api\/v1\/photos\/[^/]+)\/file$/, "$1/thumbnail");
    const cache = await caches.open(OFFLINE_PHOTO_CACHE);
    return (
      (await cache.match(key)) ??
      new Response(NO_PHOTO, { headers: { "Content-Type": "image/svg+xml" } })
    );
  };
  if (!offline.online) return saved();
  try {
    const response = await withTimeout(fetch(request), PHOTO_WAIT_MS);
    // 502 to 504: the proxy in front of the API answered for an API that is not there.
    return response.status >= 502 && response.status <= 504 ? saved() : response;
  } catch {
    return saved();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/healthz") return;

  if (url.pathname.startsWith("/api/")) {
    // Only pictures, and only where an offline copy may exist. Everything else
    // of the API goes to the network untouched.
    if (request.destination === "image" && offline.enabled !== false) {
      event.respondWith(photo(request, url));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(page(request));
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    // The page saving the app's code for the offline copy files it itself.
    if (request.headers.has("X-Housetory-Offline-Save")) return;
    event.respondWith(asset(request));
    return;
  }

  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(shellFile(request));
  }
});
