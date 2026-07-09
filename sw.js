const CACHE_NAME = "fenua-check-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/app.js",
  "/js/image-compress.js",
  "/js/ticket-api.js",
  "/js/ticket-history.js",
  "/manifest.json",
  "/img/icon-192.png",
  "/img/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls: prices must always come from a live Qwen request.
  if (url.pathname.startsWith("/api/")) return;

  if (event.request.method !== "GET") return;

  // Network-first: always try to fetch the latest version first, so a new
  // deploy is visible immediately. The cache is only an offline fallback,
  // never served ahead of a working network response (that was the bug:
  // a cache-first strategy kept showing an old build indefinitely).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
