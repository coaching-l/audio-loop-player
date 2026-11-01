// Small audio helpers shared by making audio from text (tts.js), the MP3 export
// (export.js) and the pauses after each sentence (practice.js). From COACHING-L
// Shadowing (src/core.ts), with one length check used everywhere.

// To protect the device's memory, audio that is made or written out stays within 20
// minutes. Every place measures the audio it actually produces, silences included.
export const MAX_OUTPUT_SECONDS = 20 * 60;
export function checkLength(seconds) {
  if (seconds > MAX_OUTPUT_SECONDS)
    throw new Error(
      "端末のメモリーを守るため、作ったり書き出したりできる音声は20分までです。テキストや範囲を分けてください。",
    );
}

// The silence after a sentence for repeating it aloud: as long as the sentence itself,
// at least 1 and at most 8 seconds (Shadowing's "auto" gap).
export const PAUSE_MIN = 1;
export const PAUSE_MAX = 8;
export function pauseAfter(seconds) {
  return Math.max(PAUSE_MIN, Math.min(PAUSE_MAX, seconds));
}

export function wavBlob(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, s) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
      true,
    );
  return new Blob([buffer], { type: "audio/wav" });
}

// Joins clips of the same rate, back to back, and returns where each one sits.
export function joinClips(clips) {
  if (!clips.length) throw new Error("音声がありません。");
  const rate = clips[0].rate;
  if (clips.some((c) => c.rate !== rate))
    throw new Error("サンプルレートが異なります。");
  const length = clips.reduce((sum, c) => sum + c.samples.length, 0);
  checkLength(length / rate);
  const samples = new Float32Array(length);
  const spans = [];
  let at = 0;
  for (const clip of clips) {
    samples.set(clip.samples, at);
    spans.push({ start: at / rate, end: (at + clip.samples.length) / rate });
    at += clip.samples.length;
  }
  return { samples, rate, spans };
}

// The audio of a file as one channel at `rate`, for writing it out again.
export async function decodeMono(file, rate) {
  const Offline =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const buffer = await new Offline(1, 1, rate).decodeAudioData(
    await file.arrayBuffer(),
  );
  checkLength(buffer.duration);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++)
      mono[i] += data[i] / buffer.numberOfChannels;
  }
  return { samples: mono, rate: buffer.sampleRate };
}
