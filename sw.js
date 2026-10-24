// Bump this version whenever a shell file changes. Each release is installed atomically.
const VERSION = "v6";
const BASE = new URL("./", self.location.href);
const PREFIX = "coaching-l-audio-offline:" + BASE.pathname + ":";
const CACHE = PREFIX + VERSION;
const FILES = [
  "./",
  "./index.html",
  "./style.css?v=8",
  "./app.js?v=8",
  "./player.js",
  "./audio-library.js",
  "./audio-import.js",
  "./offline.js",
  "./manifest.webmanifest",
  "./icons/logo-144.png",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];
const URLS = FILES.map((path) => new URL(path, BASE).href);
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(
        URLS.map((url) => new Request(url, { cache: "reload" })),
      );
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== BASE.origin) return;
  const navigation =
    request.mode === "navigate" &&
    [BASE.pathname, BASE.pathname + "index.html"].includes(url.pathname);
  if (!navigation && !URLS.includes(url.href)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await cache.match(
        navigation ? new URL("./index.html", BASE).href : request,
      );
      return response || fetch(request);
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
  if (
    ["OFFLINE_STATUS", "PREPARE_OFFLINE"].includes(event.data?.type) &&
    event.ports[0]
  ) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        if (event.data.type === "PREPARE_OFFLINE") {
          try {
            await cache.addAll(
              URLS.map((url) => new Request(url, { cache: "reload" })),
            );
          } catch {
            event.ports[0].postMessage({ ready: false, version: VERSION });
            return;
          }
        }
        const ready = (
          await Promise.all(URLS.map((url) => cache.match(url)))
        ).every(Boolean);
        event.ports[0].postMessage({ ready, version: VERSION });
      })(),
    );
  }
});
