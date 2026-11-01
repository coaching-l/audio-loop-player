// The way in from text ("テキストから始める"): the text is made into speech one sentence
// at a time on this device (tts.js), and the audio and the text, with each sentence's
// time, go to the shared practice screen as they are.
import { splitSentences } from "./transcript.js";
import { joinClips, wavBlob } from "./audio-tools.js";
import { encodeMp3, MP3_DELAY_SAMPLES } from "./export.js";
import { VOICES, voiceInfo } from "./voices.js";
import {
  SpeechEngine,
  synthesize,
  prepareRuntime,
  ttsSupported,
  ttsDataSaved,
  deleteTtsData,
  takeInterruptedAttempt,
  modelBytes,
  RUNTIME_BYTES,
} from "./tts.js";
import { openPractice } from "./practice.js";
import { $, notice } from "./ui.js";

const draftKey = "kotonoha.textdraft.v1";
const MAX_TEXT = 50000;
const engine = new SpeechEngine();
let running = null; // AbortController of the audio being made
let save = async () => null;

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey)) || {};
    return draft && typeof draft === "object" ? draft : {};
  } catch {
    return {};
  }
}
function saveDraft(changes) {
  try {
    localStorage.setItem(
      draftKey,
      JSON.stringify({ ...readDraft(), ...changes }),
    );
  } catch {
    /* The text stays on this page. */
  }
}

function fillVoices(lang, chosen) {
  const select = $("tts-voice");
  select.replaceChildren(
    ...VOICES.filter((v) => v.lang === lang).map(
      (v) => new Option(v.name, v.id, false, v.id === chosen),
    ),
  );
}
function megabytes(bytes) {
  return `約${Math.round(bytes / 1e6)}MB`;
}
function progress(message, ratio) {
  $("tts-status").textContent = message;
  if (ratio === null) $("tts-bar").removeAttribute("value");
  else $("tts-bar").value = ratio;
}
function busy(on) {
  $("tts-controls").disabled = on;
  $("tts-progress").hidden = !on;
}
function failed(message) {
  $("tts-failed").textContent = message;
  $("tts-failed").hidden = !message;
}

// The title in the saved list: the start of the first sentence.
function title(sentences) {
  const first = sentences[0]
    .replace(/\s+/g, " ")
    .replace(/[\s.。!?！？…]+$/u, "")
    .trim();
  return (first.length > 24 ? first.slice(0, 24) + "…" : first) + ".mp3";
}

// Speech at 64 kbps (mono, 24 kHz) takes about 0.5 MB a minute, against 2.9 MB as WAV.
const KBPS = 64;
// The audio to keep: MP3, with each sentence's time moved by the MP3's delay. Should the
// encoder fail, the same audio as WAV, so what was made is not lost.
async function audioFile(joined, name) {
  const { samples, rate, spans } = joined;
  const lastModified = Date.now();
  try {
    const blob = await encodeMp3(samples, rate, KBPS);
    const shift = MP3_DELAY_SAMPLES / rate;
    return {
      file: new File([blob], name, { type: "audio/mpeg", lastModified }),
      spans: spans.map((s) => ({ start: s.start + shift, end: s.end + shift })),
    };
  } catch {
    const wav = name.replace(/\.mp3$/, ".wav");
    return {
      file: new File([wavBlob(samples, rate)], wav, {
        type: "audio/wav",
        lastModified,
      }),
      spans,
    };
  }
}

async function make() {
  if (running) return;
  failed("");
  const text = $("tts-text").value.trim();
  const voice = $("tts-voice").value;
  const sentences = splitSentences(text);
  if (!sentences.length) {
    failed("読み上げるテキストを入力してください。");
    return;
  }
  if (text.length > MAX_TEXT) {
    failed(
      "一度に音声にできるのは50,000文字までです。テキストを分けてください。",
    );
    return;
  }
  const controller = new AbortController();
  running = controller;
  busy(true);
  try {
    progress(`音声づくりの準備をしています…`, null);
    await prepareRuntime(
      (ratio) =>
        progress(
          `音声づくりの準備をしています（初回のみ・${megabytes(RUNTIME_BYTES)}）… ${Math.floor(ratio * 100)}%`,
          ratio,
        ),
      controller.signal,
    );
    const texts = sentences.map((s) => s.text);
    const result = await synthesize(texts, voice, {
      engine,
      signal: controller.signal,
      onProgress: ({ index, total, download }) =>
        download
          ? progress(
              `音声モデルを受け取っています（初回のみ・${megabytes(modelBytes(voice))}）… ${Math.floor((download.loaded / download.total) * 100)}%`,
              download.loaded / download.total,
            )
          : progress(`${index + 1} / ${total} 文目を音声にしています…`, index / total),
    });
    if (result.failed) {
      const { index, message } = result.failed;
      failed(
        `${index + 1}文目「${texts[index]}」で止まりました。${message} ` +
          "テキストを直してから「音声を作る」を押すと、続きから作ります（できた文はそのまま使います）。",
      );
      return;
    }
    const joined = joinClips(result.clips);
    progress("MP3にしています…", null);
    const { file, spans } = await audioFile(joined, title(texts));
    if (controller.signal.aborted)
      throw new DOMException("中止しました。", "AbortError");
    const name = file.name;
    const script = {
      text,
      sentences: sentences.map((s, i) => ({
        text: s.text,
        lineEnd: s.lineEnd,
        start: spans[i].start,
        end: spans[i].end,
      })),
    };
    void openPractice({ file, name, script });
    const previous = readDraft().audioId;
    const record = await save(file, previous);
    if (record) saveDraft({ audioId: record.id });
    notice(
      `${texts.length}文を音声にしました。スクリプトと一緒に練習画面で開いています。`,
    );
  } catch (error) {
    if (error.name !== "AbortError") failed(error.message);
    else notice("音声づくりを中止しました。できた文は、次に作るときに使います。");
  } finally {
    running = null;
    busy(false);
    void showData();
  }
}

async function showData() {
  const saved = ttsSupported() && (await ttsDataSaved());
  $("tts-data-status").textContent = saved
    ? "音声づくり用のデータを、この端末に保存しています。通信がなくても音声を作れます（一度使った言語のみ）。"
    : "音声づくり用のデータは、まだ保存していません。";
  $("tts-data-delete").hidden = !saved;
  // The download note matters only before the first download.
  $("tts-first-note").hidden = saved;
}

/**
 * Sets up the text entry. `saveMaterial(file, replaceId)` keeps the made audio in the
 * saved list, in place of the previous version of the same draft, and returns its record.
 */
export function initTextEntry({ saveMaterial }) {
  save = saveMaterial;
  const draft = readDraft();
  const voice = VOICES.some((v) => v.id === draft.voice)
    ? draft.voice
    : "af_heart";
  const lang = voiceInfo(voice).lang;
  $("tts-lang").value = lang;
  fillVoices(lang, voice);
  if (typeof draft.text === "string") $("tts-text").value = draft.text;
  $("tts-lang").addEventListener("change", () => {
    fillVoices($("tts-lang").value);
    saveDraft({ voice: $("tts-voice").value });
  });
  $("tts-voice").addEventListener("change", () =>
    saveDraft({ voice: $("tts-voice").value }),
  );
  $("tts-text").addEventListener("input", () =>
    saveDraft({ text: $("tts-text").value }),
  );
  $("tts-make").addEventListener("click", () => void make());
  $("tts-cancel").addEventListener("click", () => {
    running?.abort();
    engine.cancel();
  });
  $("tts-data-delete").addEventListener("click", async () => {
    if (running) return;
    await deleteTtsData();
    await showData();
    notice(
      "音声づくり用のデータを削除しました。次に音声を作るときに、もう一度受け取ります。",
    );
  });
  if (!ttsSupported()) {
    $("tts-controls").disabled = true;
    failed("このブラウザでは、テキストから音声を作れません。");
    return;
  }
  const interrupted = takeInterruptedAttempt();
  if (interrupted)
    failed(
      "前回、音声づくりが途中で止まりました。端末のメモリーが足りなかった可能性があります。ほかのタブやアプリを閉じてから、もう一度お試しください。" +
        (interrupted.lang === "zh"
          ? "中国語の音声モデルは大きく、特に多くのメモリーを使います。"
          : ""),
    );
  void showData();
}
