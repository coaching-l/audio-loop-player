// Files of this site that are saved in the browser only when a feature first needs them:
// the speech-to-text model and its runtime (transcriber.js), and the runtime the
// text-to-speech worker loads (tts.js). Each file's size and SHA-256 are checked before
// it is kept, and service worker sw.js serves vendor/ and models/ from these caches.

const BASE = new URL("./", import.meta.url);
export const CACHE_PREFIX = "coaching-l-audio-model:" + BASE.pathname + ":";
const TYPES = {
  js: "text/javascript",
  mjs: "text/javascript",
  wasm: "application/wasm",
  json: "application/json",
  onnx: "application/octet-stream",
};

export function failure(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function verified(blob, file) {
  return (
    blob.size === file.size &&
    (await sha256(await blob.arrayBuffer())) === file.sha256
  );
}

export async function filesSaved(cacheName, files) {
  try {
    // caches.open would create an empty cache; only look when there is one.
    if (!(await caches.has(cacheName))) return false;
    const cache = await caches.open(cacheName);
    const found = await Promise.all(
      files.map((file) => cache.match(new URL(file.path, BASE))),
    );
    return found.every(Boolean);
  } catch {
    return false;
  }
}

// Deletes every version of one group of files (`family` is the start of their cache names).
export async function deleteFiles(family) {
  for (const key of await caches.keys())
    if (key.startsWith(family)) await caches.delete(key);
}

/**
 * Fetches the files not saved yet, checks each one and keeps it in `cacheName`.
 * A file already saved by another version or feature (the same path, size and SHA-256)
 * is copied instead of fetched. Older versions of the same family are removed at the end.
 * `messages` gives the error texts: { storage, download, broken }.
 */
export async function saveFiles({
  cacheName,
  family,
  files,
  onProgress = () => {},
  signal,
  messages,
}) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const keys = (await caches.keys()).filter(
    (key) => key.startsWith(CACHE_PREFIX) && key !== cacheName,
  );
  const cache = await caches.open(cacheName);
  let done = 0;
  for (const file of files) {
    const url = new URL(file.path, BASE);
    if (!(await cache.match(url))) {
      let blob = null;
      for (const key of keys) {
        const saved = await (await caches.open(key)).match(url);
        const copy = saved && (await saved.blob());
        if (copy && (await verified(copy, file))) {
          blob = copy;
          break;
        }
      }
      if (!blob)
        blob = await download(url, file, signal, messages, (loaded) =>
          onProgress((done + Math.min(loaded, file.size)) / total),
        );
      try {
        await cache.put(
          url,
          new Response(blob, {
            headers: {
              "Content-Type": TYPES[file.path.split(".").pop()],
              "Content-Length": String(file.size),
            },
          }),
        );
      } catch {
        throw failure("ModelStorageError", messages.storage);
      }
    }
    done += file.size;
    onProgress(done / total);
  }
  for (const key of keys) if (key.startsWith(family)) await caches.delete(key);
}

async function download(url, file, signal, messages, onLoaded) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error(String(response.status));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw failure("ModelDownloadError", messages.download);
  }
  const chunks = [];
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onLoaded(loaded);
  }
  const blob = new Blob(chunks);
  if (!(await verified(blob, file)))
    throw failure("ModelDownloadError", messages.broken);
  return blob;
}
