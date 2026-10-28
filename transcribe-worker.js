// Runs Whisper on the passes of audio sent by transcriber.js and sends back its
// segments (a phrase or a sentence each) with their times. Everything is loaded from
// this site; nothing is sent anywhere.
import { pipeline, env } from "./vendor/transformers/transformers.min.js";

const here = (path) => new URL(path, import.meta.url).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
// A path, not a full URL: Transformers.js only checks which local files exist when the
// path has no http(s): in front.
env.localModelPath = new URL("./models/", import.meta.url).pathname;
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

// Whisper often writes Mandarin in Traditional characters.
async function simplifier() {
  const { Converter } = await import("./vendor/opencc/t2cn.js");
  return Converter({ from: "t", to: "cn" });
}

self.onmessage = async ({ data }) => {
  const { audio, windows, base = 0, language, rate } = data;
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
    const segments = [];
    for (const [index, pass] of windows.entries()) {
      self.postMessage({ type: "progress", done: index });
      const output = await recognize(audio.subarray(pass.start, pass.end), {
        language,
        task: "transcribe",
        return_timestamps: true,
      });
      const offset = (base + pass.start) / rate;
      const length = (pass.end - pass.start) / rate;
      for (const chunk of output.chunks || []) {
        const [start, end] = chunk.timestamp || [];
        if (!Number.isFinite(start)) continue;
        segments.push({
          text: convert ? convert(chunk.text) : chunk.text,
          start: offset + Math.min(start, length),
          end:
            offset +
            Math.min(
              Number.isFinite(end) ? Math.max(end, start) : length,
              length,
            ),
        });
      }
    }
    self.postMessage({ type: "progress", done: windows.length });
    self.postMessage({ type: "done", segments });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: String(error?.message || error),
    });
  }
};
