// Speech to text on this device with Whisper (base size, multilingual), run by
// Transformers.js and ONNX Runtime in a worker so playback stays smooth. The model and the
// runtime are files of this site: the first use saves them in the browser after checking
// each file's SHA-256, and later uses work offline. The audio never leaves the device.

import {
  CACHE_PREFIX,
  failure,
  filesSaved,
  deleteFiles,
  saveFiles,
} from "./model-files.js";
import { speechMono } from "./speech-input.js";

const BASE = new URL("./", import.meta.url);
// All versions of the speech-to-text files share this start of their cache name.
const FAMILY = CACHE_PREFIX + "whisper-";
// Change the name whenever a file below changes, so browsers fetch the changed files
// (unchanged ones are copied from the older cache).
export const MODEL_CACHE = FAMILY + "base-q8-2";
export const MODEL_FILES = [
  {
    path: "vendor/transformers/transformers.min.js",
    size: 587917,
    sha256: "8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb",
  },
  {
    path: "vendor/onnxruntime/ort-wasm-simd-threaded.mjs",
    size: 24381,
    sha256: "c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f",
  },
  {
    path: "vendor/onnxruntime/ort-wasm-simd-threaded.wasm",
    size: 14264838,
    sha256: "06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3",
  },
  {
    path: "vendor/opencc/t2cn.js",
    size: 109060,
    sha256: "b78e83f940e73a022d8d996333e924edf07aa5b6133b8cddd46fbbff1ac339b6",
  },
  {
    path: "models/whisper-base/config.json",
    size: 2248,
    sha256: "d1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b",
  },
  {
    path: "models/whisper-base/generation_config.json",
    size: 3776,
    sha256: "3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05",
  },
  {
    path: "models/whisper-base/preprocessor_config.json",
    size: 339,
    sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
  },
  {
    path: "models/whisper-base/tokenizer.json",
    size: 2480466,
    sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
  },
  {
    path: "models/whisper-base/tokenizer_config.json",
    size: 282683,
    sha256: "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce",
  },
  {
    path: "models/whisper-base/onnx/encoder_model_quantized.onnx",
    size: 23200490,
    sha256: "c3ad6777f650b3b2a873518070ac366e9865589d74d3e164c86f02b16da3028e",
  },
  {
    path: "models/whisper-base/onnx/decoder_model_merged_quantized.onnx",
    size: 53707539,
    sha256: "a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861",
  },
];
export const MODEL_BYTES = MODEL_FILES.reduce((sum, f) => sum + f.size, 0);
const RATE = 16000; // Whisper listens at 16 kHz
const WINDOW = 28; // seconds per pass; Whisper hears at most 30 seconds at a time
export const MAX_SECONDS = 20 * 60;
export function transcriptionSupported() {
  return (
    typeof WebAssembly === "object" &&
    typeof Worker === "function" &&
    "caches" in window &&
    Boolean(window.crypto?.subtle) &&
    Boolean(window.OfflineAudioContext || window.webkitOfflineAudioContext)
  );
}

export async function modelSaved() {
  return filesSaved(MODEL_CACHE, MODEL_FILES);
}

export async function deleteModel() {
  await deleteFiles(FAMILY);
}

function saveModel(onProgress, signal) {
  return saveFiles({
    cacheName: MODEL_CACHE,
    family: FAMILY,
    files: MODEL_FILES,
    onProgress,
    signal,
    messages: {
      storage:
        "端末の空き容量が足りないため、文字起こし用のデータを保存できません。空き容量を増やしてから、もう一度お試しください。",
      download:
        "文字起こし用のデータを受け取れませんでした。インターネットにつながっているか確かめて、もう一度お試しください。",
      broken:
        "文字起こし用のデータが途中で途切れました。もう一度お試しください。",
    },
  });
}

// Mono samples at 16 kHz. Engines that refuse that rate decode at a common one, and the
// samples are averaged down.
async function decodeSpeech(file) {
  const Offline =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const bytes = await file.arrayBuffer();
  for (const rate of [RATE, 48000, 44100]) {
    let buffer;
    try {
      buffer = await new Offline(1, 1, rate).decodeAudioData(bytes.slice(0));
    } catch {
      continue;
    }
    const mono = speechMono(buffer);
    if (buffer.sampleRate === RATE) return mono;
    const ratio = buffer.sampleRate / RATE;
    const out = new Float32Array(Math.floor(mono.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let k = from; k < to; k++) sum += mono[k];
      out[i] = sum / (to - from);
    }
    return out;
  }
  throw failure(
    "AudioDecodeError",
    "この音声は文字起こしのために読み取れませんでした。",
  );
}

// Splits the audio into passes of up to WINDOW seconds, cut at the quietest moment of
// each pass's last 8 seconds (a pause), and leaves out passes without sound, where
// Whisper would invent text. Returns sample ranges.
export function planWindows(samples, rate = RATE) {
  const frame = Math.round(rate * 0.02);
  const energy = new Float32Array(Math.ceil(samples.length / frame));
  for (let i = 0; i < samples.length; i++)
    energy[(i / frame) | 0] += samples[i] * samples[i];
  let peak = 0;
  for (const value of energy) if (value > peak) peak = value;
  if (!peak) return [];
  const quiet = peak * 0.001;
  const limit = Math.round(WINDOW / 0.02);
  const search = Math.round(8 / 0.02);
  const windows = [];
  let start = 0;
  while (start < energy.length) {
    let end = Math.min(energy.length, start + limit);
    if (end < energy.length) {
      let lowest = Infinity;
      let cutAt = end;
      for (let i = end - 1; i >= end - search; i--) {
        let level = 0;
        for (let k = i - 2; k <= i + 2; k++) level += energy[k] || 0;
        if (level < lowest) {
          lowest = level;
          cutAt = i;
        }
      }
      end = cutAt;
    }
    let sound = false;
    for (let i = start; i < end && !sound; i++) sound = energy[i] > quiet;
    if (sound)
      windows.push({
        start: start * frame,
        end: Math.min(samples.length, end * frame),
      });
    start = end;
  }
  return windows;
}

// Returns the recognized segments with times in seconds: [{text, start, end}].
// onProgress gets {phase: "download", ratio}, {phase: "prepare"} or
// {phase: "listen", done, total}.
export async function transcribe(
  file,
  { language, onProgress = () => {}, signal } = {},
) {
  if (!(await modelSaved()))
    await saveModel(
      (ratio) => onProgress({ phase: "download", ratio }),
      signal,
    );
  signal?.throwIfAborted();
  onProgress({ phase: "prepare" });
  const samples = await decodeSpeech(file);
  signal?.throwIfAborted();
  const windows = planWindows(samples);
  // The model's working memory grows to about 700 MB in the first pass and stays; on a
  // phone the second pass can then go over the browser's limit and the page reloads.
  // Without plenty of memory, each pass gets a fresh worker so memory is freed between.
  const perWorker = navigator.deviceMemory >= 8 ? windows.length : 1;
  const segments = [];
  for (let first = 0; first < windows.length; first += perWorker) {
    const group = windows.slice(first, first + perWorker);
    segments.push(
      ...(await recognize(samples, group, language, signal, (done) =>
        onProgress({
          phase: "listen",
          done: first + done,
          total: windows.length,
        }),
      )),
    );
  }
  return segments;
}

// Runs one worker over some passes. It gets only their part of the audio, with `base`
// (the first sample) so that the times it returns are times in the whole audio.
function recognize(samples, windows, language, signal, onDone) {
  signal?.throwIfAborted();
  const base = windows[0].start;
  const audio = samples.slice(base, windows[windows.length - 1].end);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./transcribe-worker.js", BASE), {
      type: "module",
    });
    const stop = (settle, value) => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
      settle(value);
    };
    const abort = () => stop(reject, signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onDone(data.done);
      else if (data.type === "done") stop(resolve, data.segments);
      else if (data.type === "error")
        stop(reject, failure("TranscribeError", data.message));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      stop(reject, failure("TranscribeError", event.message || "worker"));
    };
    worker.postMessage(
      {
        audio,
        windows: windows.map((w) => ({
          start: w.start - base,
          end: w.end - base,
        })),
        base,
        language,
        rate: RATE,
      },
      [audio.buffer],
    );
  });
}
