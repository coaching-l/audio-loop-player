// Runs Whisper on the passes of audio sent by transcriber.js and sends back the words
// with their times. Everything is loaded from this site; nothing is sent anywhere.
import { pipeline, env } from "./vendor/transformers/transformers.min.js";

const here = (path) => new URL(path, import.meta.url).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = here("./models/");
// transcriber.js keeps the files in its own cache; avoid a second copy.
env.useBrowserCache = false;
env.useWasmCache = false;
env.fetch = async (url, options) =>
  (await caches.match(url)) || fetch(url, options);
Object.assign(env.backends.onnx.wasm, {
  wasmPaths: {
    mjs: here("./vendor/onnxruntime/ort-wasm-simd-threaded.mjs"),
    wasm: here("./vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
  },
  // Threads need cross-origin isolation, which static hosting does not offer.
  numThreads: 1,
  proxy: false,
});

async function simplifier() {
  const { Converter } = await import("./vendor/opencc/t2cn.js");
  return Converter({ from: "t", to: "cn" });
}

// Whisper often writes Mandarin in Traditional characters; convert the whole pass at
// once for context, and word by word if the length changed.
function simplify(convert, texts) {
  const joined = texts.join("");
  const converted = [...convert(joined)];
  if (converted.length !== [...joined].length) return texts.map(convert);
  let index = 0;
  return texts.map((text) => {
    const length = [...text].length;
    index += length;
    return converted.slice(index - length, index).join("");
  });
}

self.onmessage = async ({ data }) => {
  const { audio, windows, language, rate } = data;
  try {
    const recognize = await pipeline(
      "automatic-speech-recognition",
      "whisper-base",
      {
        dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        device: "wasm",
      },
    );
    const convert = language === "zh" ? await simplifier() : null;
    const words = [];
    for (const [index, pass] of windows.entries()) {
      self.postMessage({ type: "progress", done: index });
      const output = await recognize(audio.subarray(pass.start, pass.end), {
        language,
        task: "transcribe",
        return_timestamps: "word",
      });
      const offset = pass.start / rate;
      const length = (pass.end - pass.start) / rate;
      const chunks = (output.chunks || []).filter((chunk) =>
        Number.isFinite(chunk.timestamp?.[0]),
      );
      const texts = chunks.map((chunk) => chunk.text);
      (convert ? simplify(convert, texts) : texts).forEach((text, i) => {
        const [start, end] = chunks[i].timestamp;
        words.push({
          text,
          start: offset + Math.min(start, length),
          end:
            offset +
            Math.min(
              Number.isFinite(end) ? Math.max(end, start) : length,
              length,
            ),
        });
      });
    }
    self.postMessage({ type: "progress", done: windows.length });
    self.postMessage({ type: "done", words });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: String(error?.message || error),
    });
  }
};
