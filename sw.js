// Bump this version whenever a shell file changes. Each release is installed atomically.
const VERSION = "v56";
const BASE = new URL("./", self.location.href);
const PREFIX = "coaching-l-audio-offline:" + BASE.pathname + ":";
const CACHE = PREFIX + VERSION;
const FILES = [
  "./",
  "./index.html",
  "./style.css?v=58",
  "./app.js?v=58",
  "./player.js",
  "./audio-library.js",
  "./audio-import.js",
  "./speech-input.js",
  "./recorder.js",
  "./ui.js",
  "./practice.js",
  "./translation.js",
  "./translation-ui.js",
  "./translation-config.js",
  "./context-translation.js",
  "./text-entry.js",
  "./tts.js",
  "./tts-worker.js",
  "./voices.js",
  "./voice-previews.js",
  "./voice-previews/af_heart.mp3",
  "./voice-previews/af_bella.mp3",
  "./voice-previews/am_michael.mp3",
  "./voice-previews/bf_emma.mp3",
  "./voice-previews/bf_isabella.mp3",
  "./voice-previews/bm_george.mp3",
  "./voice-previews/zf_001.mp3",
  "./voice-previews/zf_002.mp3",
  "./voice-previews/zm_010.mp3",
  "./voice-previews/zm_011.mp3",
  "./english.js",
  "./stream-iterator.js",
  "./mandarin.js",
  "./mandarin-lexicon.js",
  "./audio-tools.js",
  "./model-files.js",
  "./export.js",
  "./mp3-worker.js",
  "./vendor/lamejs/lamejs.js",
  "./vendor/fflate/fflate.js",
  "./waveform.js",
  "./transcript.js",
  "./transcriber.js",
  "./transcribe-worker.js",
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
// Safari may request a small byte range before playing an MP3. Cache the whole file,
// then answer those range requests locally, including when the device is offline.
async function previewRange(request, response) {
  const range = request.headers.get("range");
  if (!range || request.headers.has("if-range")) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return response;
  const bytes = await response.arrayBuffer();
  const size = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end)
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}
// The speech-to-text model and its runtime are saved by transcriber.js in a cache of
// their own, only when first used; serve them from there so they work offline.
const MODEL_PATHS = ["vendor/", "models/"].map(
  (path) => new URL(path, BASE).pathname,
);
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
  if (MODEL_PATHS.some((path) => url.pathname.startsWith(path))) {
    event.respondWith(
      caches.match(request).then((saved) => saved || fetch(request)),
    );
    return;
  }
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
      if (response && url.pathname.startsWith(new URL("./voice-previews/", BASE).pathname))
        return previewRange(request, response);
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
