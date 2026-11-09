// The way in from text ("テキストから始める"): the text is made into speech one sentence
// at a time on this device (tts.js), and the audio and the text, with each sentence's
// time, go to the shared practice screen as they are.
import { splitSentences, joinWrappedEnglishLines } from "./transcript.js";
import { joinClips, wavBlob } from "./audio-tools.js";
import { Mp3StreamEncoder, MP3_DELAY_SAMPLES } from "./export.js";
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
import { $, notice, offerUndo } from "./ui.js";
import { initVoicePreviews } from "./voice-previews.js";

const draftKey = "kotonoha.textdraft.v1";
const MAX_TEXT = 50000;
const engine = new SpeechEngine();
let running = null; // AbortController of the audio being made
let save = async () => null;
let previewURL = null;
let previewGeneration = 0;

function stopPreview(clear = false) {
  previewGeneration++;
  const audio = $("tts-preview-audio");
  audio.pause();
  audio.currentTime = 0;
  $("tts-preview").textContent = "▶ 冒頭を先に聴く";
  $("tts-preview").setAttribute("aria-pressed", "false");
  if (clear) {
    audio.removeAttribute("src");
    audio.load();
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = null;
    $("tts-preview").hidden = true;
    $("tts-preview-status").textContent = "";
  }
}

async function playPreview() {
  const audio = $("tts-preview-audio");
  if (!audio.paused) { stopPreview(); return; }
  if (!previewURL) return;
  if (!window.dispatchEvent(new Event("voice-preview-start", { cancelable: true }))) {
    $("tts-preview-status").textContent = "録音を止めてから聴いてください。";
    return;
  }
  const current = ++previewGeneration;
  $("tts-preview-status").textContent = "";
  $("tts-preview").textContent = "■ 試聴を停止";
  $("tts-preview").setAttribute("aria-pressed", "true");
  try { await audio.play(); }
  catch {
    if (current !== previewGeneration) return;
    stopPreview();
    $("tts-preview-status").textContent = "もう一度タップしてお試しください。";
  }
}

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

const SENTENCE_PAUSE = 0.3;
const LINE_PAUSE = 0.6;
// Keep consonants clear without a second encoding on an unchanged whole-file export.
// 128 kbps mono is about 1 MB/minute (24 kHz PCM would be 2.9 MB/minute).
const KBPS = 128;
// The audio to keep: MP3, with each sentence's time moved by the MP3's delay. Should the
// encoder fail, the same audio as WAV, so what was made is not lost.
async function audioFile(joined, name, encoder) {
  const { samples, rate, spans } = joined;
  const lastModified = Date.now();
  try {
    const blob = await encoder.finish();
    const shift = MP3_DELAY_SAMPLES / rate;
    return {
      file: new File([blob], name, { type: "audio/mpeg", lastModified }),
      spans: spans.map((s) => ({ start: s.start + shift, end: s.end + shift })),
    };
  } catch (error) {
    if (error.name === "AbortError") throw error;
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
  let encoder;
  controller.signal.addEventListener("abort", () => encoder?.cancel(), { once: true });
  running = controller;
  stopPreview(true);
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
      onClip: async (clip, index) => {
        encoder ??= new Mp3StreamEncoder(clip.rate, KBPS);
        await encoder.drain();
        if (controller.signal.aborted) throw new DOMException("中止しました。", "AbortError");
        if (index > 0) {
          const pause = sentences[index - 1].lineEnd ? LINE_PAUSE : SENTENCE_PAUSE;
          encoder.append(new Float32Array(Math.round(pause * clip.rate)));
        }
        encoder.append(clip.samples);
        if (index === 0) {
          previewURL = URL.createObjectURL(wavBlob(clip.samples, clip.rate));
          $("tts-preview-audio").src = previewURL;
          $("tts-preview").hidden = false;
        }
      },
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
    // Sentences joined back to back ran into each other: a short pause between them,
    // a longer one where the text starts a new line.
    const joined = joinClips(
      result.clips,
      sentences.map((s) => (s.lineEnd ? LINE_PAUSE : SENTENCE_PAUSE)),
    );
    progress("MP3にしています…", null);
    const { file, spans } = await audioFile(joined, title(texts), encoder);
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
    encoder?.cancel();
    stopPreview(true);
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

function showClear() {
  const text = $("tts-text").value;
  $("tts-clear").hidden = !text;
  $("tts-join-lines").hidden = $("tts-lang").value !== "en" ||
    joinWrappedEnglishLines(text) === text;
}
// Empties the text box, with undo. The next audio made is new material: it does not
// replace the audio made from the text that was cleared.
function clearText(message) {
  const text = $("tts-text").value;
  if (!text) return;
  const { audioId } = readDraft();
  $("tts-text").value = "";
  saveDraft({ text: "", audioId: null });
  failed("");
  showClear();
  offerUndo(message, () => {
    $("tts-text").value = text;
    saveDraft({ text, audioId });
    showClear();
  });
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
  initVoicePreviews();
  if (typeof draft.text === "string") $("tts-text").value = draft.text;
  showClear();
  // Text in one language is not read in the other: switching starts with an empty box.
  $("tts-lang").addEventListener("change", () => {
    fillVoices($("tts-lang").value);
    saveDraft({ voice: $("tts-voice").value });
    clearText("言語を切り替えたので、テキストを消しました。");
  });
  $("tts-clear").addEventListener("click", () =>
    clearText("テキストを消しました。"),
  );
  $("tts-join-lines").addEventListener("click", () => {
    const original = $("tts-text").value;
    const text = joinWrappedEnglishLines(original);
    $("tts-text").value = text;
    saveDraft({ text });
    showClear();
    offerUndo("文途中の改行をつなぎました。内容を確認してから音声を作ってください。", () => {
      $("tts-text").value = original;
      saveDraft({ text: original });
      showClear();
    });
  });
  $("tts-voice").addEventListener("change", () =>
    saveDraft({ voice: $("tts-voice").value }),
  );
  $("tts-text").addEventListener("input", () => {
    saveDraft({ text: $("tts-text").value });
    showClear();
  });
  $("tts-make").addEventListener("click", () => void make());
  $("tts-preview").addEventListener("click", () => void playPreview());
  $("tts-preview-audio").addEventListener("ended", () => stopPreview());
  $("tts-preview-audio").addEventListener("error", () => {
    if (!previewURL) return;
    stopPreview();
    $("tts-preview-status").textContent = "冒頭を再生できませんでした。音声づくりは続いています。";
  });
  document.addEventListener("play", (event) => {
    if (event.target !== $("tts-preview-audio")) stopPreview();
  }, true);
  for (const id of ["record", "compare", "entry-audio"])
    $(id).addEventListener("click", () => stopPreview(), true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopPreview(); });
  window.addEventListener("pagehide", () => stopPreview());
  window.addEventListener("offline-update", () => stopPreview());
  $("tts-cancel").addEventListener("click", () => {
    running?.abort();
    engine.cancel();
  });
  $("tts-data-delete").addEventListener("click", async () => {
    if (running) return;
    engine.cancel();
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
