// The voices of "テキストから始める" and the Kokoro models behind them, in one place for the
// page (tts.js) and the worker (tts-worker.js). From COACHING-L Shadowing (src/engine.ts),
// with each model pinned to a revision so a change upstream cannot silently replace it.

export const SAMPLE_RATE = 24000;
export const PREVIEW_TEXT = {
  en: "Hello. Let's practice together, one sentence at a time, and enjoy learning.",
  zh: "你好，让我们每天练习，一起进步，享受学习的乐趣。",
};
// Kokoro reads at most 512 tokens at a time; longer text is refused, never cut.
export const MAX_TOKENS = 512;
export const MAX_SENTENCE_CHARS = 400;

export const MODELS = {
  en: {
    repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
    revision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    dtype: "q8", // onnx/model_quantized.onnx
    bytes: 92361116,
  },
  zh: {
    repo: "onnx-community/Kokoro-82M-v1.1-zh-ONNX",
    revision: "6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3",
    // The quantized model gave only NaN samples in the browser (Shadowing's VOICE-RESEARCH.md).
    dtype: "fp32", // onnx/model.onnx
    bytes: 339369442,
  },
};

export const VOICES = [
  { id: "af_heart", lang: "en", name: "Heart（米国英語・女性）" },
  { id: "af_bella", lang: "en", name: "Bella（米国英語・女性）" },
  { id: "am_michael", lang: "en", name: "Michael（米国英語・男性）" },
  { id: "bf_emma", lang: "en", name: "Emma（英国英語・女性）" },
  { id: "bf_isabella", lang: "en", name: "Isabella（英国英語・女性）" },
  { id: "bm_george", lang: "en", name: "George（英国英語・男性）" },
  { id: "zf_001", lang: "zh", name: "普通話 001（女性）" },
  { id: "zf_002", lang: "zh", name: "普通話 002（女性）" },
  { id: "zm_010", lang: "zh", name: "普通話 010（男性）" },
  { id: "zm_011", lang: "zh", name: "普通話 011（男性）" },
];

export function voiceInfo(id) {
  const voice = VOICES.find((v) => v.id === id);
  if (!voice) throw new Error("この声は使えません。");
  return { ...voice, model: MODELS[voice.lang] };
}

export function voiceURL(id) {
  const { model } = voiceInfo(id);
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/voices/${id}.bin`;
}
