// Turns one sentence into speech with Kokoro, on this device. Ported from COACHING-L
// Shadowing (src/engine.worker.ts). The runtime is this site's own files; only the Kokoro
// model and voice files are downloaded, from Hugging Face at a pinned revision, and kept
// in the browser. The text never leaves the device.
import {
  StyleTextToSpeech2Model,
  AutoTokenizer,
  Tensor,
  env,
} from "./vendor/transformers/transformers.min.js";
import { MODELS, MAX_TOKENS, SAMPLE_RATE, voiceInfo, voiceURL } from "./voices.js";

const here = (path) => new URL(path, import.meta.url).href;
env.allowLocalModels = false;
env.allowRemoteModels = true;
Object.assign(env.backends.onnx.wasm, {
  wasmPaths: {
    mjs: here("./vendor/onnxruntime/ort-wasm-simd-threaded.mjs"),
    wasm: here("./vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
  },
  // One thread, including in Safari without shared memory.
  numThreads: 1,
  proxy: false,
});

let loaded = null; // { lang, model, tokenizer }
const styles = new Map();
const progress_callback = (progress) =>
  self.postMessage({ type: "progress", progress });

async function load(lang) {
  if (loaded?.lang === lang) return loaded;
  // Only one model at a time: the other one's memory is given back first.
  if (loaded) await loaded.model.dispose();
  loaded = null;
  const { repo, revision, dtype } = MODELS[lang];
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(repo, {
      revision,
      dtype,
      device: "wasm",
      progress_callback,
    }),
    AutoTokenizer.from_pretrained(repo, { revision, progress_callback }),
  ]);
  loaded = { lang, model, tokenizer };
  return loaded;
}

// A voice is a table of 510 style vectors, one per input length.
async function voiceStyles(id) {
  if (styles.has(id)) return styles.get(id);
  const url = voiceURL(id);
  let cache;
  try {
    cache = await caches.open("coaching-l-tts-voices");
  } catch {
    /* Without storage the voice is kept in memory only. */
  }
  let response = await cache?.match(url);
  if (!response) {
    response = await fetch(url);
    if (!response.ok)
      throw new Error(`声のデータを受け取れませんでした（${response.status}）。`);
    try {
      await cache?.put(url, response.clone());
    } catch {
      /* A full storage does not prevent this sentence. */
    }
  }
  const table = new Float32Array(await response.arrayBuffer());
  if (table.length < 510 * 256) throw new Error("声のデータが不完全です。");
  styles.set(id, table);
  return table;
}

async function phonemes(text, voice) {
  if (voice.lang === "zh") {
    const { mandarinPhonemes } = await import("./mandarin.js");
    return mandarinPhonemes(text);
  }
  const { englishPhonemes } = await import("./english.js");
  return englishPhonemes(text, voice.id[0]);
}

self.onmessage = async ({ data }) => {
  try {
    const voice = voiceInfo(data.voice);
    const { model, tokenizer } = await load(voice.lang);
    const { input_ids } = tokenizer(await phonemes(data.text, voice), {
      truncation: false,
    });
    const tokens = input_ids.dims.at(-1);
    if (tokens > MAX_TOKENS)
      throw new Error(
        "この文は長すぎて読み上げられません（音声モデルの上限）。意味のまとまりで文を分けてください。",
      );
    const index = 256 * Math.min(Math.max(tokens - 2, 0), 509);
    const style = (await voiceStyles(voice.id)).slice(index, index + 256);
    self.postMessage({ type: "stage", stage: "synthesizing" });
    const { waveform } = await model({
      input_ids,
      style: new Tensor("float32", style, [1, 256]),
      speed: new Tensor("float32", [1], [1]),
    });
    self.postMessage({ type: "audio", samples: waveform.data, rate: SAMPLE_RATE });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || String(error) });
  }
};
