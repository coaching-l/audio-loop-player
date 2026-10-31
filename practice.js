// The practice screen: one screen for every way in. An entry (audio files today, text
// later) prepares the material and calls openPractice; everything after that is shared:
// playback, the A–B interval, speed, the script and the detailed settings.
import { readableAudio } from "./audio-import.js";
import { audioKey } from "./audio-library.js";
import { LoopPlayer, GAP_RATIOS, parseTime, formatTime } from "./player.js";
import { analyzeAudio, drawWaveform } from "./waveform.js";
import { VoiceRecorder, recordingSupported } from "./recorder.js";
import {
  splitSentences,
  alignSentences,
  retimeSentences,
  transcriptFromSegments,
  sentenceAt,
  isCjk,
  decodeText,
  validTranscript,
} from "./transcript.js";
import {
  transcribe,
  transcriptionSupported,
  modelSaved,
  deleteModel,
  MODEL_BYTES,
  MAX_SECONDS,
} from "./transcriber.js";
import {
  $,
  notice,
  routineNotice,
  storageProblem,
  error,
  settleUndo,
  offerUndo,
} from "./ui.js";

// Settings and playback position per material. The name is kept from earlier versions.
const storageKey = "kotonoha.audio.v1";
let library = {};
let engine = null;
let materialKey = null;
let currentFile = null;
let objectURL = null;
let loadGeneration = 0;
let ready = false;
let loadTimeout;
let markerDrag = null;
let lastPositionSave = 0;

// What a new material starts with: interval repeat off, and once it is on, it repeats
// until paused, with no silence in between (shadowing).
const DEFAULTS = { mode: "off", a: 0, limit: 0, gap: 0, gapRatio: 0, rate: 1 };

function rangeError(message) {
  $("range-error").textContent = message;
  $("range-error").hidden = !message;
}
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  if (saved && typeof saved === "object" && !Array.isArray(saved))
    library = saved;
} catch {
  storageProblem(
    "このブラウザでは設定を保存できません。このページを開いている間は使えますが、閉じると設定は残りません。",
  );
}
function settings() {
  return {
    mode: engine.mode,
    a: engine.a,
    b: engine.b,
    limit: engine.limit,
    gap: engine.gap,
    gapRatio: engine.gapRatio,
    rate: engine.baseRate,
  };
}
function persist() {
  if (!ready || !materialKey) return;
  // Anything else saved for this material by earlier versions is kept as it is.
  library[materialKey] = {
    ...library[materialKey],
    settings: settings(),
    position: engine.audio.currentTime,
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(library));
  } catch {
    storageProblem(
      "設定を保存できません。保存容量やプライベートブラウズの設定を確認してください。このページを開いている間は使えます。",
    );
  }
}
// Settings saved by earlier versions may say "all" (whole audio) or carry a speed ramp;
// neither exists any more, so they open with interval repeat off at the base speed.
function savedSettings(s, duration) {
  const valid =
    s &&
    ["off", "ab", "all"].includes(s.mode) &&
    Number.isFinite(s.a) &&
    Number.isFinite(s.b) &&
    s.a >= 0 &&
    s.b > s.a &&
    s.b <= duration + 0.001 &&
    [0, 2, 3, 5, 10].includes(s.limit) &&
    Number.isFinite(s.gap) &&
    s.gap >= 0 &&
    s.gap <= 10 &&
    // Settings saved before relative gaps existed have no gapRatio.
    (s.gapRatio === undefined || GAP_RATIOS.includes(s.gapRatio)) &&
    Number.isFinite(s.rate) &&
    s.rate >= 0.5 &&
    s.rate <= 2;
  if (!valid) return { ...DEFAULTS, b: duration };
  return {
    mode: s.mode === "ab" ? "ab" : "off",
    a: s.a,
    b: s.b,
    limit: s.limit,
    gap: s.gap,
    gapRatio: s.gapRatio || 0,
    rate: s.rate,
  };
}
function syncFields() {
  if (!ready) return;
  $("point-a").value = formatTime(engine.a);
  $("point-b").value = formatTime(engine.b);
  $("repeat-count").value = String(engine.limit);
  $("gap").value = String(engine.gap);
  $("gap-mode").value = String(engine.gapRatio);
  $("gap-seconds").hidden = engine.gapRatio !== 0;
  $("speed").value = String(engine.baseRate);
  $("speed-value").textContent = engine.baseRate.toFixed(2) + "×";
  $("a-legend").textContent = "A " + formatTime(engine.a, 1);
  $("b-legend").textContent = "B " + formatTime(engine.b, 1);
  syncGauge();
}
// The player checks the interval end every 15 ms; the screen only needs one update per frame.
let renderFrame = 0;
function render(player) {
  if (!ready) return;
  if (
    player.phase === "playing" &&
    performance.now() - lastPositionSave > 2000
  ) {
    lastPositionSave = performance.now();
    persist();
  }
  // Media Session updates also run while the page is hidden, when frames do not.
  updateMediaSession(player);
  renderFrame ||= requestAnimationFrame(() => {
    renderFrame = 0;
    if (ready && player === engine) drawPlayer(player);
  });
}
function drawPlayer(player) {
  $("current-time").textContent = formatTime(player.audio.currentTime, 1);
  $("mini-time").textContent = $("current-time").textContent;
  $("seek").value = player.audio.currentTime;
  // While zoomed, the view follows playback that runs past its edges.
  const time = player.audio.currentTime;
  if (zoomed() && player.active && (time < view.start || time > view.end)) {
    const span = view.end - view.start;
    setView(time + span * 0.4, span);
  }
  highlightSentence(player.audio.currentTime, player.active);
  const active = player.active;
  $("play").dataset.state = active ? "playing" : "paused";
  $("play").setAttribute("aria-label", active ? "一時停止" : "再生");
  const statuses = {
    playing: "再生中",
    waiting: "無音中",
    "gap-paused": "無音中に一時停止",
    paused: "一時停止",
    done: "再生完了",
  };
  const status = statuses[player.phase] || "";
  if ($("play-status").textContent !== status)
    $("play-status").textContent = status;
  $("mini-status").textContent = status;
  $("mini-play").dataset.state = $("play").dataset.state;
  $("mini-play").setAttribute(
    "aria-label",
    "下のバー：" + (active ? "一時停止" : "再生"),
  );
  $("play-status").classList.toggle(
    "waiting",
    player.phase === "waiting" || player.phase === "gap-paused",
  );
  const progress =
    player.mode === "off"
      ? "くり返しなし"
      : `完了 ${player.completed} / ${player.limit || "∞"} 回`;
  if ($("repeat-progress").textContent !== progress)
    $("repeat-progress").textContent = progress;
}
function enable(value) {
  for (const id of ["player-controls", "repeat-controls", "transcript-controls"])
    $(id).disabled = !value;
  $("record-controls").disabled = !value || !recordingSupported();
  syncMiniPlayer();
}
// A compact bar at the bottom keeps play/pause reachable once the main controls are scrolled past.
let transportVisible = true;
function syncMiniPlayer() {
  const show = ready && !transportVisible;
  $("mini-player").hidden = !show;
  document.body.classList.toggle("has-mini-player", show);
}
// Show it only once the controls are above the viewport; below it, the player is still ahead.
let transportFrame = 0;
function checkTransport() {
  transportFrame = 0;
  const passed =
    document.querySelector(".transport").getBoundingClientRect().bottom <= 0;
  if (transportVisible === !passed) return;
  transportVisible = !passed;
  syncMiniPlayer();
}
for (const eventName of ["scroll", "resize"])
  window.addEventListener(
    eventName,
    () => {
      transportFrame ||= requestAnimationFrame(checkTransport);
    },
    { passive: true },
  );

// Which material is open, for the entries' lists.
export function practiceState() {
  return { key: materialKey, ready };
}

/**
 * Opens material on the practice screen.
 * - file: the audio (a File, or a Blob with a name given separately). Required.
 * - key: where its settings and script are saved. Defaults to the file's name, size and date.
 * - name: the title shown above the player. Defaults to the file's name.
 * - script: { text, sentences? } for material that brings its own script. It is used
 *   only while nothing is saved for this key, so the learner's edits are kept.
 *   Sentences are { text, start, end } in seconds; without them, times are estimated.
 */
export async function openPractice({ file, key, name, script } = {}) {
  if (!file) return;
  name ||= file.name || "";
  settleUndo();
  discardRecording();
  persist();
  const generation = ++loadGeneration;
  currentFile = file;
  stopTranscription();
  analysis = null;
  showAnalysis();
  transcript = null;
  renderTranscript();
  clearTimeout(loadTimeout);
  markerDrag = null;
  if (engine) engine.dispose();
  if (objectURL) URL.revokeObjectURL(objectURL);
  ready = false;
  enable(false);
  error("");
  rangeError("");
  routineNotice("");
  $("load-audio").hidden = false;
  $("file-name").textContent = name;
  $("mini-name").textContent = name;
  $("play-status").textContent = "音声を読み込み中…";
  $("play").dataset.state = "paused";
  $("play").setAttribute("aria-label", "再生");
  $("current-time").textContent = "0:00.0";
  $("duration").textContent = "0:00.0";
  $("seek").value = 0;
  view = { start: 0, end: 0 };
  applyView();
  $("repeat-progress").textContent = "—";
  $("a-legend").textContent = "A —";
  $("b-legend").textContent = "B —";
  // Metadata identifies the file locally; neither audio bytes nor filenames leave this browser.
  materialKey = key || audioKey(file);
  const audio = document.createElement("audio");
  audio.id = "audio";
  audio.preload = "auto";
  $("audio-container").replaceChildren(audio);
  engine = new LoopPlayer(audio, render, error);
  const currentEngine = engine;
  function fail(message) {
    if (generation !== loadGeneration) return;
    clearTimeout(loadTimeout);
    ready = false;
    enable(false);
    $("load-audio").hidden = true;
    currentEngine.pause();
    error(message);
    $("play-status").textContent = "読み込めませんでした";
  }
  audio.addEventListener("error", () =>
    fail(
      "この音声を読み込めません。形式がブラウザに対応していないか、ファイルが壊れています。MP3・M4A・WAVなど、別のファイルをお試しください。",
    ),
  );
  audio.addEventListener(
    "loadedmetadata",
    () => {
      if (generation !== loadGeneration) return;
      clearTimeout(loadTimeout);
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        fail("音声の長さを読み取れません。別の音声ファイルをお試しください。");
        return;
      }
      const stored = library[materialKey];
      const s = savedSettings(stored?.settings, audio.duration);
      ready = true;
      $("load-audio").hidden = true;
      currentEngine.configure(s);
      currentEngine.setRate(s.rate);
      if (Number.isFinite(stored?.position))
        currentEngine.seek(stored.position);
      $("duration").textContent = formatTime(audio.duration, 1);
      resetView();
      syncFields();
      enable(true);
      render(currentEngine);
      persist();
      setMediaMetadata(name);
      openTranscript();
      if (!transcript && script) useScript(script);
      // The waveform comes after playback is ready, so drawing it never delays practice.
      readableAudio(file)
        .then(analyzeAudio)
        .then((result) => {
          if (generation !== loadGeneration || !result) return;
          analysis = result;
          realignTranscript();
          showAnalysis();
        })
        .catch(() => {
          /* Without a waveform the plain gauge still works. */
        });
      routineNotice("音声を読み込みました。再生ボタンを押すと練習を始めます。");
    },
    { once: true },
  );
  notice("音声を端末から読み込み中です。");
  try {
    const copy = await readableAudio(file);
    if (generation !== loadGeneration) return;
    objectURL = URL.createObjectURL(copy);
    notice(
      "読み込みが始まらないときは「音声の読み込みを始める」を押してください。",
    );
    loadTimeout = setTimeout(() => {
      if (generation !== loadGeneration || ready) return;
      $("play-status").textContent = "読み込みを待っています";
      notice(
        "ブラウザが読み込みを止めています。「音声の読み込みを始める」を押してください。クラウド上のファイルは、端末へのダウンロードを済ませてから選び直してください。",
      );
    }, 15000);
    audio.src = objectURL;
    audio.load();
  } catch (e) {
    fail(e.message);
  }
}

// Empties the practice screen, for example when its audio is deleted.
export function closePractice() {
  persist();
  setMediaMetadata(null);
  discardRecording();
  stopTranscription();
  analysis = null;
  transcript = null;
  renderTranscript();
  showAnalysis();
  ++loadGeneration;
  currentFile = null;
  clearTimeout(loadTimeout);
  markerDrag = null;
  seekDrag = null;
  engine?.dispose();
  engine = null;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  ready = false;
  $("load-audio").hidden = true;
  materialKey = null;
  enable(false);
  $("file-name").textContent = "まだ音声を開いていません";
  $("play-status").textContent = "音声を選んでください";
  $("play").dataset.state = "paused";
  $("play").setAttribute("aria-label", "再生");
  $("current-time").textContent = "0:00.0";
  $("duration").textContent = "0:00.0";
  $("seek").value = 0;
  view = { start: 0, end: 0 };
  applyView();
}

function togglePlay() {
  if (!ready) return;
  stopCompare();
  error("");
  if (engine.active) {
    engine.pause();
    persist();
    return;
  }
  // The model must not play into the microphone: finish the recording first.
  if (recorder.recording) {
    recorder.stop();
    notice("録音を止めて、再生します。");
  }
  void engine.play();
}
function skip(seconds) {
  stopCompare();
  if (ready) engine.seek(engine.audio.currentTime + seconds);
}
$("play").addEventListener("click", togglePlay);
$("mini-play").addEventListener("click", togglePlay);
$("back").addEventListener("click", () => skip(-5));
$("mini-back").addEventListener("click", () => skip(-5));
$("forward").addEventListener("click", () => skip(5));
$("mini-forward").addEventListener("click", () => skip(5));
// Hold playback while the thumb is dragged, so each input does not restart the audio.
let seekDrag = null;
$("seek").addEventListener("pointerdown", () => {
  if (!ready) return;
  seekDrag = { player: engine, resume: engine.active };
  engine.pause();
});
$("seek").addEventListener("input", () => engine.seek(Number($("seek").value)));
function endSeekDrag() {
  const drag = seekDrag;
  seekDrag = null;
  if (!drag || drag.player !== engine || !ready) return;
  persist();
  if (drag.resume) void engine.play();
}
for (const eventName of ["change", "pointerup", "pointercancel"])
  $("seek").addEventListener(eventName, endSeekDrag);
function changeRate(rate) {
  engine.setRate(rate);
  syncFields();
  persist();
}
$("speed").addEventListener("input", () =>
  changeRate(Number($("speed").value)),
);
$("normal-speed").addEventListener("click", () => changeRate(1));
function updateSettings(overrides = {}) {
  if (!ready) return false;
  const s = {
    mode: engine.mode,
    a: parseTime($("point-a").value),
    b: parseTime($("point-b").value),
    limit: Number($("repeat-count").value),
    gap: $("gap").value.trim() === "" ? NaN : Number($("gap").value),
    gapRatio: Number($("gap-mode").value),
    ...overrides,
  };
  // The seconds field is hidden for a relative gap, so a stale entry there must not block changes.
  if (s.gapRatio && !(s.gap >= 0 && s.gap <= 10)) s.gap = engine.gap;
  try {
    engine.configure(s);
    rangeError("");
    syncFields();
    persist();
    return true;
  } catch (e) {
    rangeError(
      s.gap < 0 || s.gap > 10 || !Number.isFinite(s.gap)
        ? "無音の秒数は0〜10秒で入力してください。"
        : e.message,
    );
    return false;
  }
}
for (const id of ["point-a", "point-b", "repeat-count", "gap-mode", "gap"]) {
  $(id).addEventListener("change", () => updateSettings());
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      updateSettings();
    }
  });
}
window.addEventListener("pagehide", () => {
  if (engine) {
    engine.pause();
    persist();
  }
});
// iOS may suspend or discard a backgrounded page without firing pagehide.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persist();
});
window.addEventListener("offline-update", () => {
  if (engine) {
    engine.pause();
    persist();
  }
});
$("load-audio").addEventListener("click", () => {
  if (!engine || !engine.audio.src) {
    notice(
      "まだファイルを読み取っています。クラウド上のファイルは、端末へのダウンロードが済んでいるか確認してください。",
    );
    return;
  }
  // Called directly by the gesture, not after an await: Safari may require this.
  const player = engine;
  player.audio.play().catch((error) => {
    if (player !== engine || error.name === "AbortError") return;
    notice(
      error.name === "NotAllowedError"
        ? "もう一度このボタンを押してください。ほかのアプリの中でこのページを開いているときは、SafariやChromeなどのブラウザで開き直してください。"
        : "音声を再生できません。端末に保存してある別のMP3・M4A・WAVもお試しください。",
    );
  });
});

let analysis = null;
function showAnalysis() {
  const shown = Boolean(analysis && ready);
  $("waveform").hidden = !shown;
  $("interval-gauge").classList.toggle("has-waveform", shown);
  showSteps();
  if (shown) drawGauge();
}
function drawGauge() {
  if (analysis && ready)
    drawWaveform(
      $("waveform"),
      analysis,
      view.start,
      view.end,
      engine.a,
      engine.b,
    );
}
let redrawFrame = 0;
function redrawSoon() {
  redrawFrame ||= requestAnimationFrame(() => {
    redrawFrame = 0;
    drawGauge();
  });
}
window.addEventListener("resize", redrawSoon);
matchMedia("(prefers-color-scheme: dark)").addEventListener?.(
  "change",
  redrawSoon,
);
// One idea of a "sentence": the script's sentences when there is a script, otherwise the
// stretches of sound between the waveform's pauses.
function steps() {
  if (!ready) return [];
  if (transcript) return transcript.sentences;
  return analysis?.phrases || [];
}
function showSteps() {
  $("phrase-actions").hidden = steps().length < 2;
}
function stepPhrase(direction) {
  if (!ready) return;
  const here = engine.mode === "ab" ? engine.a : engine.audio.currentTime;
  const list = steps();
  const index =
    direction > 0
      ? list.findIndex((p) => p.start > here + 0.05)
      : list.findLastIndex((p) => p.start < here - 0.05);
  if (index < 0) {
    notice(direction > 0 ? "これが最後の文です。" : "これが最初の文です。");
    return;
  }
  if (transcript) selectSentence(index);
  else playInterval(list[index]);
}
// Makes a sentence the A–B interval and moves playback to its start.
function playInterval({ start, end }) {
  const b = Math.min(end, engine.audio.duration);
  if (!updateSettings({ a: start, b, mode: "ab" })) return false;
  if (zoomed()) fitView();
  engine.seek(start);
  return true;
}
$("prev-phrase").addEventListener("click", () => stepPhrase(-1));
$("next-phrase").addEventListener("click", () => stepPhrase(1));
// The gauge can show part of the audio, so a short phrase gets room for A and B.
const MIN_VIEW = 0.5;
let view = { start: 0, end: 0 };
function zoomed() {
  return ready && view.end - view.start < engine.audio.duration - 0.001;
}
function percent(time) {
  const span = view.end - view.start;
  return span > 0 ? ((time - view.start) / span) * 100 : 0;
}
function setView(center, span) {
  const duration = engine.audio.duration;
  span = Math.min(duration, Math.max(Math.min(MIN_VIEW, duration), span));
  const start = Math.min(Math.max(0, center - span / 2), duration - span);
  view = { start, end: start + span };
  applyView();
}
function resetView() {
  view = { start: 0, end: ready ? engine.audio.duration : 0 };
  applyView();
}
function applyView() {
  $("seek").min = view.start;
  $("seek").max = view.end;
  $("seek").step = zoomed() ? "0.001" : "0.01";
  if (!ready) return;
  $("seek").value = engine.audio.currentTime;
  $("zoom-out").disabled = !zoomed();
  $("zoom-in").disabled = view.end - view.start <= MIN_VIEW + 0.001;
  $("zoom-range").textContent = zoomed()
    ? `${formatTime(view.start, 2)}–${formatTime(view.end, 2)} を表示中`
    : "全体を表示中";
  syncGauge();
}
function fitView() {
  const pad = Math.max(0.2, (engine.b - engine.a) * 0.25);
  setView((engine.a + engine.b) / 2, engine.b - engine.a + pad * 2);
}
$("zoom-in").addEventListener("click", () => {
  const span = view.end - view.start;
  // Zoom toward the practice interval when it is on screen, else toward playback.
  const middle = (engine.a + engine.b) / 2;
  const center =
    engine.mode === "ab" && middle >= view.start && middle <= view.end
      ? middle
      : engine.audio.currentTime;
  setView(center, span / 2);
});
$("zoom-out").addEventListener("click", () =>
  setView((view.start + view.end) / 2, (view.end - view.start) * 2),
);
$("zoom-fit").addEventListener("click", fitView);
function syncGauge() {
  const duration = engine.audio.duration;
  for (const point of ["a", "b"]) {
    const marker = $("marker-" + point);
    const left = percent(engine[point]);
    marker.style.left = left + "%";
    // A handle outside the zoomed range is hidden until the view reaches it.
    marker.style.visibility = left < -0.01 || left > 100.01 ? "hidden" : "";
    marker.setAttribute("aria-valuenow", engine[point]);
    marker.setAttribute("aria-valuemin", point === "a" ? 0 : engine.a + 0.001);
    marker.setAttribute(
      "aria-valuemax",
      point === "a" ? engine.b - 0.001 : duration,
    );
    marker.setAttribute("aria-valuetext", formatTime(engine[point]));
  }
  const clamp = (value) => Math.min(100, Math.max(0, value));
  $("interval-fill").style.left = clamp(percent(engine.a)) + "%";
  $("interval-fill").style.right = 100 - clamp(percent(engine.b)) + "%";
  $("toggle-ab").setAttribute("aria-pressed", String(engine.mode === "ab"));
  $("toggle-ab").textContent =
    "区間リピート " + (engine.mode === "ab" ? "ON" : "OFF");
  drawGauge();
}
function moveMarker(point, time) {
  const duration = engine.audio.duration;
  const minimum = Math.min(0.01, duration / 2);
  const value =
    point === "a"
      ? Math.max(0, Math.min(engine.b - minimum, time))
      : Math.min(duration, Math.max(engine.a + minimum, time));
  engine.configure({ ...settings(), [point]: value, mode: "ab" });
  syncFields();
  rangeError("");
}
for (const point of ["a", "b"]) {
  const marker = $("marker-" + point);
  marker.addEventListener("pointerdown", (event) => {
    if (!ready || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    marker.focus();
    markerDrag = {
      point,
      id: event.pointerId,
      player: engine,
      resume: engine.active,
    };
    engine.pause();
    marker.setPointerCapture(event.pointerId);
  });
  marker.addEventListener("pointermove", (event) => {
    if (
      !markerDrag ||
      markerDrag.id !== event.pointerId ||
      markerDrag.point !== point ||
      markerDrag.player !== engine
    )
      return;
    const rect = document
      .querySelector(".interval-markers")
      .getBoundingClientRect();
    const fraction = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    moveMarker(point, view.start + fraction * (view.end - view.start));
  });
  function finish(event) {
    if (
      !markerDrag ||
      markerDrag.id !== event.pointerId ||
      markerDrag.point !== point
    )
      return;
    const drag = markerDrag;
    markerDrag = null;
    if (drag.player !== engine || !ready) return;
    persist();
    if (event.type === "pointerup" && drag.resume) void engine.play();
  }
  marker.addEventListener("pointerup", finish);
  marker.addEventListener("pointercancel", finish);
  marker.addEventListener("lostpointercapture", finish);
  marker.addEventListener("keydown", (event) => {
    if (!ready) return;
    // Finer steps when zoomed in: about 1% of the visible range.
    const fine = zoomed()
      ? Math.max(0.01, Math.min(0.1, (view.end - view.start) / 100))
      : 0.1;
    const step = event.shiftKey ? fine * 10 : fine;
    const values = {
      ArrowLeft: engine[point] - step,
      ArrowDown: engine[point] - step,
      ArrowRight: engine[point] + step,
      ArrowUp: engine[point] + step,
      Home: 0,
      End: engine.audio.duration,
    };
    if (!(event.key in values)) return;
    event.preventDefault();
    moveMarker(point, values[event.key]);
    persist();
  });
}
function toggleRepeat() {
  updateSettings({ mode: engine.mode === "ab" ? "off" : "ab" });
}
$("toggle-ab").addEventListener("click", toggleRepeat);
$("gauge-set-a").addEventListener("click", () =>
  updateSettings({ a: engine.audio.currentTime, mode: "ab" }),
);
$("gauge-set-b").addEventListener("click", () =>
  updateSettings({ b: engine.audio.currentTime, mode: "ab" }),
);

// Lock screen, headset and keyboard media keys act on the same player as the on-screen buttons.
const mediaSession =
  "mediaSession" in navigator ? navigator.mediaSession : null;
let lastPositionState = 0;
function setMediaMetadata(name) {
  if (!mediaSession) return;
  mediaSession.metadata =
    name && "MediaMetadata" in window
      ? new MediaMetadata({
          title: name,
          artist: "COACHING-L 音声リピートプレーヤー",
          artwork: [
            {
              src: "./icons/icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "./icons/icon-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        })
      : null;
  mediaSession.playbackState = name ? "paused" : "none";
}
function updateMediaSession(player) {
  if (!mediaSession) return;
  mediaSession.playbackState = player.active ? "playing" : "paused";
  // Position updates let the lock screen show progress; once a second is enough.
  if (performance.now() - lastPositionState < 1000 && player.active) return;
  lastPositionState = performance.now();
  try {
    mediaSession.setPositionState({
      duration: player.audio.duration,
      playbackRate: player.audio.playbackRate,
      position: Math.min(player.audio.currentTime, player.audio.duration),
    });
  } catch {
    /* Older browsers lack position state; the controls still work. */
  }
}
if (mediaSession) {
  const actions = {
    play: () => ready && !engine.active && togglePlay(),
    pause: () => ready && engine.active && togglePlay(),
    seekbackward: (details) => skip(-(details.seekOffset || 5)),
    seekforward: (details) => skip(details.seekOffset || 5),
    seekto: (details) => ready && engine.seek(details.seekTime),
    // "Previous" returns to the start of the practice interval.
    previoustrack: () => ready && engine.seek(engine.start),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      /* Not every browser supports every action. */
    }
  }
}

function stepRate(delta) {
  const rate = Math.round((engine.baseRate + delta) * 100) / 100;
  changeRate(Math.min(2, Math.max(0.5, rate)));
}
const shortcuts = {
  " ": togglePlay,
  k: togglePlay,
  arrowleft: () => skip(-5),
  j: () => skip(-5),
  arrowright: () => skip(5),
  l: () => skip(5),
  a: () => updateSettings({ a: engine.audio.currentTime, mode: "ab" }),
  b: () => updateSettings({ b: engine.audio.currentTime, mode: "ab" }),
  r: toggleRepeat,
  "[": () => stepRate(-0.05),
  "]": () => stepRate(0.05),
};
document.addEventListener("keydown", (event) => {
  if (
    !ready ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  // Typing in a field and the A/B handles' own arrow keys come first.
  if (
    event.target.closest?.(
      "input, select, textarea, [contenteditable], [role=slider]",
    )
  )
    return;
  if (event.key === " " && event.target.closest?.("button, summary, a, label"))
    return;
  const action = shortcuts[event.key.toLowerCase()];
  if (!action) return;
  event.preventDefault();
  action();
});

// Record the learner, then play the model interval and the recording back to back.
// Kept in memory only: never saved or sent, and dropped when other material opens.
const voice = new Audio();
let recordingURL = null;
let recordTick = null;
let compareToken = 0;
// A recording still running when its material is closed belongs to that material; drop it.
let dropNextRecording = false;
function recordStatus(text) {
  $("record-status").textContent = text;
}
function recordError(message) {
  $("record-error").textContent = message;
  $("record-error").hidden = !message;
}
const recorder = new VoiceRecorder((blob) => {
  clearInterval(recordTick);
  $("record").textContent = "録音する";
  if (dropNextRecording) {
    dropNextRecording = false;
    return;
  }
  if (!blob) {
    recordStatus(recordingURL ? "録音あり" : "録音なし");
    recordError("録音できませんでした。もう一度お試しください。");
    return;
  }
  discardRecording();
  recordingURL = URL.createObjectURL(blob);
  voice.src = recordingURL;
  $("compare").disabled = false;
  recordStatus("録音あり");
});
function discardRecording() {
  if (recorder.recording) {
    dropNextRecording = true;
    recorder.stop();
  }
  stopCompare();
  voice.removeAttribute("src");
  voice.load();
  if (recordingURL) URL.revokeObjectURL(recordingURL);
  recordingURL = null;
  $("compare").disabled = true;
  recordStatus("録音なし");
}
function stopCompare() {
  compareToken++;
  if (!voice.paused) voice.pause();
  if (recordingURL && !recorder.recording) recordStatus("録音あり");
}
if (!recordingSupported()) recordError("このブラウザでは録音できません。");
$("record").addEventListener("click", async () => {
  recordError("");
  if (recorder.recording) {
    recorder.stop();
    return;
  }
  stopCompare();
  // Pause the model so it is not recorded along with the voice.
  if (engine?.active) {
    engine.pause();
    persist();
  }
  try {
    await recorder.start();
  } catch (e) {
    recorder.release();
    recordError(
      e.name === "NotAllowedError"
        ? "マイクの使用が許可されていません。ブラウザの設定で、このページにマイクの使用を許可してください。"
        : "マイクを使えません。ほかのアプリがマイクを使っていないか確認してください。",
    );
    return;
  }
  $("record").textContent = "録音を止める";
  recordStatus("録音中 0:00");
  recordTick = setInterval(
    () => recordStatus("録音中 " + formatTime(recorder.elapsed, 0)),
    250,
  );
});
$("compare").addEventListener("click", async () => {
  if (!ready || !recordingURL) return;
  stopCompare();
  const token = compareToken;
  // The model is the A–B interval.
  const { a, b } = engine;
  const audio = engine.audio;
  engine.pause();
  engine.seek(a);
  recordStatus("お手本を再生中");
  try {
    await audio.play();
  } catch {
    if (token === compareToken) recordStatus("録音あり");
    return;
  }
  // Any other control (play, seek, switching audio) stops the comparison.
  const reached = await new Promise((resolve) => {
    const check = setInterval(() => {
      const done = audio.ended || audio.currentTime >= b;
      if (done || audio.paused || token !== compareToken) {
        clearInterval(check);
        resolve(done && token === compareToken);
      }
    }, 20);
  });
  if (!reached) return;
  audio.pause();
  recordStatus("自分の声を再生中");
  voice.currentTime = 0;
  voice.onended = () => token === compareToken && recordStatus("録音あり");
  voice.play().catch(() => {});
});

// The script: one line per sentence, the sentence being heard is highlighted.
// Stored per material, apart from the settings, so playback saves stay small.
const transcriptPrefix = "kotonoha.transcript.v1:";
const prefsKey = "kotonoha.prefs.v1";
let transcript = null;
let editingTranscript = false;
const canTranscribe = transcriptionSupported();
let transcribing = null; // the AbortController of the running transcription
let currentSentence = -1;
let selectedSentence = -1;
function loadTranscript(key) {
  try {
    const value = JSON.parse(localStorage.getItem(transcriptPrefix + key));
    return validTranscript(value) ? value : null;
  } catch {
    return null;
  }
}
function saveTranscript(key, value) {
  try {
    if (value)
      localStorage.setItem(transcriptPrefix + key, JSON.stringify(value));
    else localStorage.removeItem(transcriptPrefix + key);
  } catch {
    notice(
      "スクリプトを保存できません。保存容量やプライベートブラウズの設定を確認してください。このページを開いている間は使えます。",
    );
  }
}
function openTranscript() {
  transcript = loadTranscript(materialKey);
  editingTranscript = false;
  realignTranscript();
  renderTranscript();
}
// A script that came with the material: with its own times, or timed like a pasted one.
function useScript({ text, sentences }) {
  if (typeof text !== "string" || !text.trim()) return;
  const given = { text, sentences };
  if (!validTranscript(given)) {
    setTranscriptText(text, "material");
    return;
  }
  transcript = { ...given, source: "material", timing: "given" };
  saveTranscript(materialKey, transcript);
  renderTranscript();
}
function setTranscriptText(text, source = "manual") {
  const sentences = splitSentences(text);
  if (!sentences.length) {
    notice("スクリプトが空です。文を入力してください。");
    return false;
  }
  const previous = transcript;
  const duration = engine.audio.duration;
  const phrases = analysis?.phrases || [];
  // Editing keeps the times of the sentences that did not change.
  const keep = previous && previous.timing !== "estimate";
  transcript = {
    ...previous,
    text,
    source: previous?.source || source,
    // Without the waveform yet, times are shared out by length; pauses refine them later.
    timing: keep ? previous.timing : analysis ? "pauses" : "estimate",
    sentences: keep
      ? retimeSentences(previous.sentences, sentences, duration, phrases)
      : alignSentences(sentences, duration, phrases),
  };
  saveTranscript(materialKey, transcript);
  editingTranscript = false;
  renderTranscript();
  notice(
    `スクリプトを${sentences.length}文に分けて表示しました。色の位置がずれる文は、「詳しい設定」で時刻を直せます。`,
  );
  return true;
}
function realignTranscript() {
  if (
    !transcript ||
    !analysis ||
    transcript.timing !== "estimate" ||
    transcript.sentences.some((s) => s.edited)
  )
    return;
  transcript.sentences = alignSentences(
    transcript.sentences,
    engine.audio.duration,
    analysis.phrases,
  );
  transcript.timing = "pauses";
  saveTranscript(materialKey, transcript);
  renderTranscript();
}
function renderTranscript() {
  const has = Boolean(ready && transcript);
  $("transcript-status").textContent = !ready
    ? "—"
    : editingTranscript
      ? "入力中"
      : has
        ? `${transcript.sentences.length}文`
        : transcribing
          ? "文字起こし中"
          : "スクリプトなし";
  $("transcript-empty").hidden =
    has || editingTranscript || Boolean(transcribing);
  $("transcribe-hint").hidden = !canTranscribe;
  $("transcribe-progress").hidden = !transcribing;
  $("transcribe-controls").hidden = !canTranscribe;
  $("transcribe-controls").disabled = !ready || Boolean(transcribing);
  $("transcript-editor").hidden = !editingTranscript;
  $("transcript-view").hidden = !has || editingTranscript;
  const list = $("transcript-sentences");
  list.replaceChildren();
  currentSentence = -1;
  if (!has) selectedSentence = -1;
  if (has) {
    // Chinese needs Chinese glyphs, not the Japanese forms the page defaults to.
    list.lang = isCjk(transcript.text) ? "zh-CN" : "en";
    transcript.sentences.forEach((sentence, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sentence";
      button.dataset.index = index;
      button.textContent = sentence.text;
      if (index === selectedSentence) button.classList.add("is-selected");
      list.append(button);
    });
    highlightSentence(engine.audio.currentTime, false);
  }
  $("transcript-fit").disabled = !has || selectedSentence < 0;
  showSteps();
}
function highlightSentence(time, follow) {
  if (!transcript || editingTranscript) return;
  const index = sentenceAt(transcript.sentences, time);
  if (index === currentSentence) return;
  const list = $("transcript-sentences");
  const previous = list.children[currentSentence];
  previous?.classList.remove("is-current");
  previous?.removeAttribute("aria-current");
  currentSentence = index;
  const current = list.children[index];
  if (!current) return;
  current.classList.add("is-current");
  current.setAttribute("aria-current", "true");
  // Keep the sentence being heard in view inside the box, without scrolling the page.
  const top = current.offsetTop;
  if (
    follow &&
    (top < list.scrollTop ||
      top + current.offsetHeight > list.scrollTop + list.clientHeight)
  )
    list.scrollTo({
      top: Math.max(0, top - list.clientHeight / 3),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
}
function selectSentence(index) {
  if (!playInterval(transcript.sentences[index])) return;
  selectedSentence = index;
  const list = $("transcript-sentences");
  [...list.children].forEach((item, i) =>
    item.classList.toggle("is-selected", i === index),
  );
  $("transcript-fit").disabled = false;
  notice("選んだ文をA–B区間にしました。再生ボタンでくり返し練習できます。");
}
$("transcript-sentences").addEventListener("click", (event) => {
  const button = event.target.closest(".sentence");
  if (!button || !ready || !transcript) return;
  selectSentence(Number(button.dataset.index));
});
$("transcript-fit").addEventListener("click", () => {
  const sentence = transcript?.sentences[selectedSentence];
  if (!sentence) return;
  sentence.start = engine.a;
  sentence.end = engine.b;
  sentence.edited = true;
  saveTranscript(materialKey, transcript);
  renderTranscript();
  notice("選んだ文の時刻を、今のA–B区間に合わせました。");
});
function startEditing(text) {
  editingTranscript = true;
  renderTranscript();
  $("transcript-input").value = text;
  $("transcript-input").focus();
}
$("transcript-paste").addEventListener("click", () => startEditing(""));
$("transcript-edit").addEventListener("click", () =>
  startEditing(transcript?.text || ""),
);
$("transcript-cancel").addEventListener("click", () => {
  editingTranscript = false;
  renderTranscript();
});
$("transcript-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  if (ready) setTranscriptText($("transcript-input").value);
});
$("transcript-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !ready) return;
  // Opens the text for checking before it is saved.
  startEditing(decodeText(await file.arrayBuffer()));
});
$("transcript-delete").addEventListener("click", () => {
  if (!transcript) return;
  const removed = transcript;
  const key = materialKey;
  transcript = null;
  saveTranscript(key, null);
  renderTranscript();
  offerUndo("スクリプトを消しました。", () => {
    saveTranscript(key, removed);
    if (key === materialKey) {
      transcript = removed;
      renderTranscript();
    }
  });
});
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(prefsKey)) || {};
  } catch {
    return {};
  }
}
function savePrefs(changes) {
  try {
    localStorage.setItem(
      prefsKey,
      JSON.stringify({ ...readPrefs(), ...changes }),
    );
  } catch {
    /* The choice still applies on this page. */
  }
}

// Speech to text with Whisper, on this device: a helper when there is no script.
// One audio file at a time; opening another file stops it.
const modelSize = `約${Math.round(MODEL_BYTES / 1e6)}MB`;
for (const item of document.querySelectorAll(".model-size"))
  item.textContent = modelSize;
function transcribeProgress(message, ratio) {
  $("transcribe-status").textContent = message;
  if (ratio === null) $("transcribe-bar").removeAttribute("value");
  else $("transcribe-bar").value = ratio;
}
function stopTranscription() {
  transcribing?.abort();
  transcribing = null;
}
async function startTranscription() {
  if (!ready || transcribing || !canTranscribe) return;
  if (engine.audio.duration > MAX_SECONDS) {
    notice(
      `文字起こしできるのは${MAX_SECONDS / 60}分までの音声です。スクリプトを貼り付けてください。`,
    );
    return;
  }
  const controller = new AbortController();
  const generation = loadGeneration;
  const key = materialKey;
  const language = $("transcribe-language").value;
  transcribing = controller;
  transcribeProgress("文字起こしの準備をしています…", null);
  renderTranscript();
  notice("文字起こしを始めました。そのまま再生して練習できます。");
  try {
    const segments = await transcribe(await readableAudio(currentFile), {
      language,
      signal: controller.signal,
      onProgress: ({ phase, ratio, done, total }) => {
        if (phase === "download")
          transcribeProgress(
            `文字起こし用のデータを保存しています（初回のみ・${modelSize}）… ${Math.floor(ratio * 100)}%`,
            ratio,
          );
        else if (phase === "prepare")
          transcribeProgress("音声を準備しています…", null);
        else
          transcribeProgress(
            `${language === "zh" ? "中国語" : "英語"}の文字を起こしています… ${done} / ${total}`,
            total ? done / total : null,
          );
      },
    });
    if (generation !== loadGeneration) return;
    const result = transcriptFromSegments(
      segments,
      engine.audio.duration,
      analysis?.phrases || [],
    );
    if (!result) {
      notice(
        "音声から文を聞き取れませんでした。話している言語の選択が合っているか確かめてください。",
      );
      return;
    }
    transcript = {
      text: result.text,
      source: "auto",
      language,
      timing: "words",
      sentences: result.sentences,
    };
    editingTranscript = false;
    saveTranscript(key, transcript);
    notice(
      `音声から${result.sentences.length}文を書き起こしました。精度はそこそこです。必要に応じて「スクリプトを直す」で手直ししてください。`,
    );
  } catch (e) {
    // A stop (button or another file) has already updated the screen.
    if (generation !== loadGeneration || e.name === "AbortError") return;
    if (
      ["ModelDownloadError", "ModelStorageError", "AudioDecodeError"].includes(
        e.name,
      )
    )
      notice(e.message);
    else {
      // The details stay in the console, for checking with the browser's tools.
      console.error("Transcription failed:", e);
      notice(
        "文字起こしの途中で問題が起きました。ページを開き直して、もう一度お試しください。",
      );
    }
  } finally {
    if (transcribing === controller) transcribing = null;
    if (generation === loadGeneration) renderTranscript();
    void showModelStatus();
  }
}
async function showModelStatus() {
  if (!canTranscribe) {
    $("model-status").textContent =
      "このブラウザでは、音声からの文字起こしを使えません。";
    $("model-delete").hidden = true;
    return;
  }
  const saved = await modelSaved();
  $("model-status").textContent = saved
    ? `文字起こし用のデータ（${modelSize}）を保存しています。通信がなくても文字起こしできます。`
    : "文字起こし用のデータは、まだ保存していません。";
  $("model-delete").hidden = !saved;
}
$("transcribe-start").addEventListener("click", () => {
  void startTranscription();
});
$("transcribe-cancel").addEventListener("click", () => {
  stopTranscription();
  renderTranscript();
  notice("文字起こしを中止しました。");
});
$("model-delete").addEventListener("click", async () => {
  if (transcribing) {
    notice("文字起こしが終わってから削除してください。");
    return;
  }
  await deleteModel();
  await showModelStatus();
  notice(
    "文字起こし用のデータを削除しました。次に文字起こしするときに、もう一度受け取ります。",
  );
});
{
  const prefs = readPrefs();
  if (["en", "zh"].includes(prefs.transcribeLanguage))
    $("transcribe-language").value = prefs.transcribeLanguage;
}
$("transcribe-language").addEventListener("change", () =>
  savePrefs({ transcribeLanguage: $("transcribe-language").value }),
);
renderTranscript();
void showModelStatus();
