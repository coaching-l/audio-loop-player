// Encodes mono samples as MP3 off the page. From COACHING-L Shadowing (src/mp3.worker.ts).
// lamejs (LGPL-3.0) is used unchanged, as a separate file: vendor/lamejs.
import { Mp3Encoder } from "./vendor/lamejs/lamejs.js";

self.onmessage = ({ data }) => {
  try {
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
