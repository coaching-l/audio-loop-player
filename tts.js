// Text to speech for "テキストから始める", on this device. Ported from COACHING-L Shadowing
// (src/engine.ts and the full-text generation in src/App.tsx), without React, and with
// these changes from its review:
// - the 3-minute limit starts again whenever the model download reports progress,
//   so a slow first download does not fail (it is a limit on silence, not on size);
// - the models are pinned to a revision (voices.js), and the clip key names it;
// - the 512-token limit is checked by the worker itself, not inside kokoro-js;
// - a bounded recent-sentence cache avoids regenerating text after switching voices
//   or materials; old entries are evicted automatically;
// - the 20-minute limit is checked once, on all sentences (audio-tools.js).
import { MODELS, MAX_SENTENCE_CHARS, SAMPLE_RATE, voiceInfo } from "./voices.js";
import { MODEL_FILES } from "./transcriber.js";
import {
  CACHE_PREFIX,
  filesSaved,
  deleteFiles,
  saveFiles,
} from "./model-files.js";
import { checkLength } from "./audio-tools.js";

// The worker's runtime: files of this site, saved once so it works offline later.
const FAMILY = CACHE_PREFIX + "tts-runtime-";
export const RUNTIME_CACHE = FAMILY + "1";
const shared = [
  "vendor/transformers/transformers.min.js",
  "vendor/onnxruntime/ort-wasm-simd-threaded.mjs",
  "vendor/onnxruntime/ort-wasm-simd-threaded.wasm",
];
export const RUNTIME_FILES = [
  ...MODEL_FILES.filter((file) => shared.includes(file.path)),
  {
    path: "vendor/phonemizer/phonemizer.js",
    size: 1322380,
    sha256: "193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec",
  },
  {
    path: "vendor/pinyin-pro/pinyin-pro.js",
    size: 325971,
    sha256: "111650dc5aa9349e44fd2d3219f6113b962712c7ad37403ce731f53029fb5376",
  },
];
export const RUNTIME_BYTES = RUNTIME_FILES.reduce((sum, f) => sum + f.size, 0);
// Where the models and voices are kept once downloaded.
const MODEL_CACHES = ["transformers-cache", "coaching-l-tts-voices"];
const TIMEOUT = 3 * 60 * 1000;

export function ttsSupported() {
  return (
    typeof WebAssembly === "object" &&
    typeof Worker === "function" &&
    "caches" in window &&
    "indexedDB" in window &&
    Boolean(window.crypto?.subtle)
  );
}

export function prepareRuntime(onProgress, signal) {
  return saveFiles({
    cacheName: RUNTIME_CACHE,
    family: FAMILY,
    files: RUNTIME_FILES,
    onProgress,
    signal,
    messages: {
      storage:
        "端末の空き容量が足りないため、音声づくりの準備ができません。空き容量を増やしてから、もう一度お試しください。",
      download:
        "音声づくりの準備のデータを受け取れませんでした。インターネットにつながっているか確かめて、もう一度お試しください。",
      broken:
        "音声づくりの準備のデータが途中で途切れました。もう一度お試しください。",
    },
  });
}

export async function ttsDataSaved() {
  if (!(await filesSaved(RUNTIME_CACHE, RUNTIME_FILES))) return false;
  try {
    return await caches.has("transformers-cache");
  } catch {
    return false;
  }
}

export async function deleteTtsData() {
  await deleteFiles(FAMILY);
  for (const name of MODEL_CACHES) await caches.delete(name);
  await clearClips();
}

// Refuses what the model would read wrongly or cut; nothing is removed silently.
export function checkSentence(text, voiceId) {
  const voice = voiceInfo(voiceId);
  if (
    voice.lang === "en" &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
  )
    throw new Error(
      "英語の声では、中国語や日本語を読めません。読み上げない部分をテキストから消してください。",
    );
  if (text.length > MAX_SENTENCE_CHARS)
    throw new Error(
      `この文は${MAX_SENTENCE_CHARS}文字を超えています。意味のまとまりで文を分けてください。`,
    );
}

// How a sentence is read before the model (mandarin.js, english.js). Raise it whenever
// those rules change, so sentences made under the old rules are made again.
// 5: lexical neutral tones, contextual 得 and word-grouped third tones.
// 4 was previously shipped and reverted; never reuse it for different readings.
export const READING_VERSION = 5;
// English-only number and contextual pronunciation fixes. Mandarin cache keys stay
// at 5: this release does not change its readings or invalidate its saved clips.
export const ENGLISH_READING_VERSION = 6;
// The same sentence in the same voice, model and reading rules makes the same audio.
export function clipKey(text, voiceId) {
  const { model, lang } = voiceInfo(voiceId);
  return JSON.stringify([
    text,
    voiceId,
    model.repo,
    model.revision,
    model.dtype,
    lang === "en" ? ENGLISH_READING_VERSION : READING_VERSION,
  ]);
}

// A note in this tab's session storage while a sentence is being made, so a page that
// was reloaded by the browser (often for lack of memory) can say so next time. It holds
// the language and the time only, never the text.
const ATTEMPT_KEY = "coaching-l-tts-attempt-v1";
const ATTEMPT_AGE = 30 * 60 * 1000;
function markAttempt(lang) {
  try {
    sessionStorage.setItem(
      ATTEMPT_KEY,
      JSON.stringify({ lang, startedAt: Date.now() }),
    );
  } catch {
    /* The note is only a hint. */
  }
}
function clearAttempt() {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* Nothing to clear. */
  }
}
// Returns { lang } when the last attempt in this tab did not finish, and forgets it.
export function takeInterruptedAttempt() {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY));
    sessionStorage.removeItem(ATTEMPT_KEY);
    if (
      value &&
      ["en", "zh"].includes(value.lang) &&
      Number.isFinite(value.startedAt) &&
      Date.now() - value.startedAt < ATTEMPT_AGE
    )
      return { lang: value.lang };
  } catch {
    /* No note. */
  }
  return null;
}

// One sentence at a time in a worker; a failed or stopped worker is thrown away whole,
// which also gives back the memory of its model.
export class SpeechEngine {
  constructor(
    createWorker = () =>
      new Worker(new URL("./tts-worker.js", import.meta.url), {
        type: "module",
      }),
  ) {
    this.createWorker = createWorker;
    this.worker = null;
    this.lang = null;
    this.pending = null;
    this.timer = null;
  }
  generate(text, voiceId, onProgress = () => {}) {
    if (this.pending) throw new Error("音声づくりの途中です。");
    checkSentence(text, voiceId);
    const { lang } = voiceInfo(voiceId);
    if (this.worker && this.lang !== lang) this.cancel();
    this.lang = lang;
    markAttempt(lang);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        this.worker ??= this.createWorker();
      } catch (error) {
        this.cancel("音声づくりを始められませんでした。");
        return;
      }
      const restart = () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () =>
            this.cancel(
              "音声づくりが3分以上進みませんでした。インターネットの接続や端末の空きメモリーを確かめて、もう一度お試しください。",
            ),
          TIMEOUT,
        );
      };
      restart();
      this.worker.onerror = (event) =>
        this.cancel(
          "音声モデルの実行中に問題が起きました。" + (event.message || ""),
        );
      this.worker.onmessage = ({ data }) => {
        if (data.type === "progress") {
          restart();
          const p = data.progress || {};
          if (p.status === "progress" && p.total)
            onProgress({
              file: p.file,
              loaded: p.loaded,
              total: p.total,
            });
        } else if (data.type === "stage") {
          restart();
        } else if (data.type === "audio") {
          const { samples, rate } = data;
          if (
            !(samples instanceof Float32Array) ||
            !samples.length ||
            !samples.every(Number.isFinite) ||
            rate !== SAMPLE_RATE
          ) {
            this.cancel("正しい音声を作れませんでした。");
            return;
          }
          this.settle();
          resolve({ samples, rate });
        } else if (data.type === "error") {
          this.cancel(
            "音声モデルの読み込みか音声づくりに失敗しました。" + data.error,
          );
        }
      };
      this.worker.postMessage({ type: "generate", text, voice: voiceId });
    });
  }
  settle() {
    clearTimeout(this.timer);
    clearAttempt();
    this.pending = null;
  }
  cancel(message) {
    const pending = this.pending;
    this.settle();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.lang = null;
    if (pending) {
      const error = new Error(message || "音声づくりを中止しました。");
      if (!message) error.name = "AbortError";
      pending.reject(error);
    }
  }
}

// Keep recent sentences across texts and voices without unbounded storage growth.
// Metadata lives separately so eviction never reads every stored audio buffer.
export const CLIP_CACHE_BYTES = 48 * 1024 * 1024;
export const CLIP_CACHE_COUNT = 256;
let connection;
function openClips() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("coaching-l-tts-clips", 2);
    let blocked = false;
    request.onblocked = () => {
      // An older tab may still hold version 1 open. Generation must keep working
      // without the optional sentence cache until that tab is closed.
      blocked = true;
      reject(new Error("文の音声キャッシュは別のタブで使用中です。"));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      const clips = db.objectStoreNames.contains("clips")
        ? request.transaction.objectStore("clips")
        : db.createObjectStore("clips", { keyPath: "key" });
      const usage = db.createObjectStore("usage", { keyPath: "key" });
      const migrated = [];
      let migratedBytes = 0;
      // Preserve sentences made by the previous version, including interrupted work.
      clips.openCursor().onsuccess = ({ target }) => {
        const cursor = target.result;
        if (!cursor) return;
        const entry = { key: cursor.key, bytes: cursor.value.samples.byteLength, used: 0 };
        usage.put(entry);
        migrated.push(entry);
        migratedBytes += entry.bytes;
        while (migratedBytes > CLIP_CACHE_BYTES || migrated.length > CLIP_CACHE_COUNT) {
          const oldest = migrated.shift();
          clips.delete(oldest.key);
          usage.delete(oldest.key);
          migratedBytes -= oldest.bytes;
        }
        cursor.continue();
      };
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); connection = null; return; }
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
    request.onerror = () => { connection = null; reject(request.error); };
  });
  return connection;
}
function transaction(mode, work) {
  return openClips().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(["clips", "usage"], mode);
    const request = work(tx.objectStore("clips"), tx.objectStore("usage"));
    tx.oncomplete = () => resolve(request instanceof IDBRequest ? request.result : undefined);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  }));
}
async function getClip(key) {
  try {
    const saved = await transaction("readwrite", (store, usage) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) usage.put({ key, bytes: request.result.samples.byteLength, used: Date.now() });
      };
      return request;
    });
    if (!saved) return null;
    const samples = new Float32Array(saved.samples.length);
    for (let i = 0; i < samples.length; i++) samples[i] = saved.samples[i] / 32767;
    return { samples, rate: saved.rate };
  } catch { return null; }
}
async function putClip(key, { samples, rate }) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  if (pcm.byteLength > CLIP_CACHE_BYTES) return;
  try {
    await transaction("readwrite", (store, usage) => {
      const request = usage.getAll();
      request.onsuccess = () => {
        const entries = request.result.filter((e) => e.key !== key).sort((a, b) => a.used - b.used);
        let bytes = entries.reduce((sum, e) => sum + e.bytes, pcm.byteLength);
        let count = entries.length + 1;
        for (const entry of entries) {
          if (bytes <= CLIP_CACHE_BYTES && count <= CLIP_CACHE_COUNT) break;
          store.delete(entry.key);
          usage.delete(entry.key);
          bytes -= entry.bytes;
          count--;
        }
        store.put({ key, samples: pcm, rate });
        usage.put({ key, bytes: pcm.byteLength, used: Date.now() });
      };
    });
  } catch { /* A full storage must not prevent speech generation. */ }
}
async function clearClips() {
  try {
    await transaction("readwrite", (store, usage) => { store.clear(); usage.clear(); });
  } catch { /* Nothing saved. */ }
}

/**
 * Makes the audio of each sentence, reusing the ones already made.
 * Stops at the first sentence that cannot be made and says which one, so the learner
 * can fix it and make the rest; the sentences before it stay saved.
 * Returns { clips } or { clips, failed: { index, message } }.
 */
export async function synthesize(sentences, voiceId, { engine, onProgress, onClip, signal }) {
  const clips = [];
  let seconds = 0;
  const keys = sentences.map((text) => clipKey(text, voiceId));
  for (let i = 0; i < sentences.length; i++) {
    if (signal?.aborted) throw new DOMException("中止しました。", "AbortError");
    onProgress?.({ index: i, total: sentences.length });
    let clip = await getClip(keys[i]);
    if (!clip) {
      try {
        clip = await engine.generate(sentences[i], voiceId, (download) =>
          onProgress?.({ index: i, total: sentences.length, download }),
        );
      } catch (error) {
        if (error.name === "AbortError") throw error;
        return { clips, failed: { index: i, message: error.message } };
      }
      await putClip(keys[i], clip);
    }
    seconds += clip.samples.length / clip.rate;
    try {
      checkLength(seconds);
    } catch (error) {
      return { clips, failed: { index: i, message: error.message } };
    }
    if (signal?.aborted) throw new DOMException("中止しました。", "AbortError");
    clips.push({ text: sentences[i], ...clip });
    await onClip?.(clip, i);
  }
  return { clips };
}

export function modelBytes(voiceId) {
  return MODELS[voiceInfo(voiceId).lang].bytes;
}
