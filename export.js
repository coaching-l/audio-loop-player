// "MP3で書き出す" in the detailed settings: the whole audio, the A–B interval, or a few
// sentences per file in a ZIP, with or without a silence after each sentence for
// repeating it aloud. From COACHING-L Shadowing (src/export.ts and output() in
// src/Practice.tsx), for any material with a script, not only audio made from text.
import { decodeMono, checkLength, pauseAfter } from "./audio-tools.js";
import { zipSync } from "./vendor/fflate/fflate.js";

// Speech needs no more; it also keeps 20 minutes within a phone's memory.
const RATE = 24000;
// An MP3 plays this many samples of silence before the audio it was made from: the
// encoder's delay (576, lamejs) and the decoder's (529). lamejs writes no header that
// tells players to skip it, so times taken from the original samples move by this much.
export const MP3_DELAY_SAMPLES = 576 + 529;

/**
 * Where to cut and where to add silence, as files of pieces { from, to, pause } in seconds.
 * kind: "all", "ab", or a number of sentences per file. Sentences are { start, end }.
 */
export function planExport({ kind, duration, sentences = [], withPauses, a, b }) {
  if (kind === "ab") return [{ suffix: "_A-B", pieces: [{ from: a, to: b, pause: 0 }] }];
  const per = kind === "all" ? Infinity : Number(kind);
  if (per !== Infinity && !sentences.length)
    throw new Error("文ごとに分けるには、スクリプトが必要です。");
  if (withPauses && !sentences.length)
    throw new Error("文のあとに無音を入れるには、スクリプトが必要です。");
  if (!sentences.length || (per === Infinity && !withPauses))
    return [{ suffix: "", pieces: [{ from: 0, to: duration, pause: 0 }] }];
  const groups = [];
  for (let i = 0; i < sentences.length; i += per)
    groups.push(sentences.slice(i, i + per));
  let from = 0;
  return groups.map((group, g) => {
    const lastGroup = g === groups.length - 1;
    const pieces = [];
    const cuts = withPauses ? group : [group[group.length - 1]];
    cuts.forEach((sentence, i) => {
      const last = i === cuts.length - 1;
      const to = last && lastGroup ? duration : Math.min(sentence.end, duration);
      pieces.push({
        from,
        to,
        pause: withPauses && !last ? pauseAfter(sentence.end - sentence.start) : 0,
      });
      from = to;
    });
    return {
      suffix: groups.length > 1 ? "_" + String(g + 1).padStart(2, "0") : "",
      pieces,
    };
  });
}

// The samples of one file: its pieces with their silences.
export function renderPieces(samples, rate, pieces) {
  const at = (seconds) =>
    Math.min(samples.length, Math.max(0, Math.round(seconds * rate)));
  const length = pieces.reduce(
    (sum, p) => sum + (at(p.to) - at(p.from)) + Math.round(p.pause * rate),
    0,
  );
  checkLength(length / rate);
  const out = new Float32Array(length);
  let offset = 0;
  for (const piece of pieces) {
    const part = samples.subarray(at(piece.from), at(piece.to));
    out.set(part, offset);
    offset += part.length + Math.round(piece.pause * rate);
  }
  return out;
}

export function encodeMp3(samples, rate, kbps = 128) {
  const worker = new Worker(new URL("./mp3-worker.js", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const done = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    worker.onerror = (event) => {
      done();
      reject(new Error("MP3に変換できませんでした。" + (event.message || "")));
    };
    worker.onmessage = ({ data }) => {
      done();
      if (data?.blob instanceof Blob) resolve(data.blob);
      else reject(new Error("MP3に変換できませんでした。" + (data?.error || "")));
    };
    worker.postMessage({ samples, rate, kbps });
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Writes the material out as MP3 (or a ZIP of MP3s) and starts the download. */
export async function exportMp3({ file, name, kind, withPauses, sentences, a, b, onProgress }) {
  const base = (name || "audio").replace(/\.[^.]+$/, "");
  onProgress("音声を読み込んでいます…");
  const { samples, rate } = await decodeMono(file, RATE);
  const files = planExport({
    kind,
    duration: samples.length / rate,
    sentences,
    withPauses,
    a,
    b,
  });
  const made = [];
  for (const [i, { suffix, pieces }] of files.entries()) {
    onProgress(`MP3に変換しています… ${i + 1} / ${files.length}`);
    made.push({
      name: base + suffix + ".mp3",
      blob: await encodeMp3(renderPieces(samples, rate, pieces), rate),
    });
  }
  if (made.length === 1) {
    download(made[0].blob, made[0].name);
    return made[0].name;
  }
  const entries = {};
  for (const item of made)
    entries[item.name] = new Uint8Array(await item.blob.arrayBuffer());
  const zip = new Blob([zipSync(entries, { level: 0 })], {
    type: "application/zip",
  });
  const zipName = `${base}_${kind}文ごと.zip`;
  download(zip, zipName);
  return zipName;
}
