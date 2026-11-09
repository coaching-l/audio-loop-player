// Encodes mono samples as MP3 off the page. From COACHING-L Shadowing (src/mp3.worker.ts).
// lamejs (LGPL-3.0) is used unchanged, as a separate file: vendor/lamejs.
import { Mp3Encoder } from "./vendor/lamejs/lamejs.js";

// Says it has loaded, so the page knows to wait for the encoding (see encodeMp3).
self.postMessage({ ready: true });

let streaming = null;
function append(samples) {
  const { encoder, parts, tail } = streaming;
  const pcm = new Int16Array(tail.length + samples.length);
  pcm.set(tail);
  for (let i = 0; i < samples.length; i++)
    pcm[tail.length + i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  let i = 0;
  for (; i + 1152 <= pcm.length; i += 1152) {
    const frame = encoder.encodeBuffer(pcm.subarray(i, i + 1152));
    if (frame.length) parts.push(new Uint8Array(frame));
  }
  streaming.tail = pcm.slice(i);
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === "start") {
      streaming = { encoder: new Mp3Encoder(1, data.rate, data.kbps || 128), parts: [], tail: new Int16Array() };
      return;
    }
    if (data.type === "append") {
      append(data.samples);
      self.postMessage({ appended: data.id });
      return;
    }
    if (data.type === "finish") {
      const { encoder, parts, tail } = streaming;
      if (tail.length) parts.push(new Uint8Array(encoder.encodeBuffer(tail)));
      parts.push(new Uint8Array(encoder.flush()));
      self.postMessage({ blob: new Blob(parts, { type: "audio/mpeg" }) });
      streaming = null;
      return;
    }
    const encoder = new Mp3Encoder(1, data.rate, data.kbps || 128);
    const parts = [];
    const pcm = new Int16Array(data.samples.length);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(Math.max(-1, Math.min(1, data.samples[i])) * 32767);
    for (let i = 0; i < pcm.length; i += 1152) {
      const frame = encoder.encodeBuffer(pcm.subarray(i, i + 1152));
      if (frame.length) parts.push(new Uint8Array(frame));
    }
    parts.push(new Uint8Array(encoder.flush()));
    self.postMessage({ blob: new Blob(parts, { type: "audio/mpeg" }) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
