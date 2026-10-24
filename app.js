import { readableAudio } from "./audio-import.js";
import "./offline.js";
import {
  audioKey,
  listAudio,
  addAudio,
  removeAudio,
  restoreAudio,
  storedFile,
  validateAudio,
} from "./audio-library.js";
import {
  LoopPlayer,
  GAP_RATIOS,
  RAMP_STEPS,
  parseTime,
  formatTime,
} from "./player.js";
import { analyzeAudio, drawWaveform } from "./waveform.js";
import { VoiceRecorder, recordingSupported } from "./recorder.js";
const $ = (id) => document.getElementById(id);
const storageKey = "kotonoha.audio.v1";
let library = {};
let engine = null;
let fileKey = null;
let objectURL = null;
let loadGeneration = 0;
let ready = false;
let segments = [];
let storageWarning = false;
let loadTimeout;
let markerDrag = null;
let audioItems = [];
let importQueue = Promise.resolve();
let lastPositionSave = 0;
function notice(message) {
  $("notice").textContent = message;
}
function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}
// One deletion at a time can be undone; a newer deletion or switching audio settles the older one.
let undo = null;
function settleUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  undo = null;
  $("undo-bar").hidden = true;
}
function offerUndo(message, revert) {
  settleUndo();
  $("undo-message").textContent = message;
  $("undo-bar").hidden = false;
  undo = { revert, timer: setTimeout(settleUndo, 10000) };
}
function rangeError(message) {
  $("range-error").textContent = message;
  $("range-error").hidden = !message;
}
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  if (saved && typeof saved === "object" && !Array.isArray(saved))
    library = saved;
} catch {
  storageWarning = true;
  notice(
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
    rampStep: engine.rampStep,
    rate: engine.baseRate,
  };
}
function persist() {
  if (!ready || !fileKey) return;
  library[fileKey] = {
    settings: settings(),
    segments,
    position: engine.audio.currentTime,
  };
  saveLibrary();
}
function saveLibrary() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(library));
  } catch {
    storageWarning = true;
    notice(
      "設定を保存できません。保存容量やプライベートブラウズの設定を確認してください。このページを開いている間は使えます。",
    );
  }
}
function validSegment(x, duration) {
  return (
    validSettings({ ...x, mode: "ab" }, duration) &&
    typeof x.id === "string" &&
    typeof x.name === "string"
  );
}
function validSettings(s, duration) {
  return (
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
    (s.rampStep === undefined || RAMP_STEPS.includes(s.rampStep)) &&
    Number.isFinite(s.rate) &&
    s.rate >= 0.5 &&
    s.rate <= 2
  );
}
function syncFields() {
  if (!ready) return;
  $("point-a").value = formatTime(engine.a);
  $("point-b").value = formatTime(engine.b);
  $("repeat-mode").value = engine.mode;
  $("repeat-count").value = String(engine.limit);
  $("gap").value = String(engine.gap);
  $("gap-mode").value = String(engine.gapRatio);
  $("gap-seconds").hidden = engine.gapRatio !== 0;
  $("ramp-step").value = String(engine.rampStep);
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
      : `完了 ${player.completed} / ${player.limit || "∞"} 回` +
        (player.rampStep && player.baseRate < 1
          ? ` · ${player.audio.playbackRate.toFixed(2)}×`
          : "");
  if ($("repeat-progress").textContent !== progress)
    $("repeat-progress").textContent = progress;
}
function enable(value) {
  for (const id of ["player-controls", "repeat-controls", "save-controls"])
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
function gapLabel({ gap, gapRatio }) {
  if (!gapRatio) return gap + "秒";
  return gapRatio === 1 ? "区間と同じ" : `区間の${gapRatio}倍`;
}
function renderSegments() {
  $("segments").replaceChildren();
  $("saved-count").textContent = segments.length + "件";
  $("empty-segments").hidden = segments.length > 0;
  for (const segment of segments) {
    const li = document.createElement("li");
    li.className = "segment";
    const info = document.createElement("div");
    info.className = "segment-info";
    const name = document.createElement("p");
    name.className = "segment-name";
    name.textContent = segment.name;
    const details = document.createElement("p");
    details.className = "small";
    details.textContent = `${formatTime(segment.a, 2)} – ${formatTime(segment.b, 2)} · ${segment.rate.toFixed(2)}× · ${segment.limit ? segment.limit + "回" : "無制限"} · 無音 ${gapLabel(segment)}${segment.rampStep ? ` · ${segment.rampStep}倍ずつ速く` : ""}`;
    info.append(name, details);
    const load = document.createElement("button");
    load.className = "button secondary";
    load.textContent = "呼び出す";
    load.setAttribute("aria-label", segment.name + "を呼び出す");
    load.addEventListener("click", () => {
      engine.pause();
      engine.configure({ ...segment, mode: "ab" });
      engine.setRate(segment.rate);
      engine.seek(segment.a);
      syncFields();
      rangeError("");
      persist();
      notice(
        `「${segment.name}」を呼び出しました。再生ボタンを押すと練習を始めます。`,
      );
    });
    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", segment.name + "を削除");
    remove.addEventListener("click", () => {
      const index = segments.indexOf(segment);
      segments = segments.filter((item) => item.id !== segment.id);
      persist();
      renderSegments();
      notice("");
      offerUndo(`「${segment.name}」を削除しました。`, () => {
        segments.splice(index, 0, segment);
        persist();
        renderSegments();
      });
    });
    li.append(info, load, remove);
    $("segments").append(li);
  }
}
async function loadFile(file) {
  if (!file) return;
  settleUndo();
  discardRecording();
  persist();
  const generation = ++loadGeneration;
  analysis = null;
  showAnalysis();
  clearTimeout(loadTimeout);
  markerDrag = null;
  if (engine) engine.dispose();
  if (objectURL) URL.revokeObjectURL(objectURL);
  ready = false;
  enable(false);
  error("");
  rangeError("");
  if (!storageWarning) notice("");
  $("load-audio").hidden = false;
  $("file-name").textContent = file.name;
  $("mini-name").textContent = file.name;
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
  segments = [];
  renderSegments();
  // Metadata identifies the file locally; neither audio bytes nor filenames leave this browser.
  fileKey = audioKey(file);
  renderAudioList();
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
      const stored = library[fileKey];
      const defaults = {
        mode: "off",
        a: 0,
        b: audio.duration,
        limit: 2,
        gap: 0,
        rate: 1,
      };
      const s = validSettings(stored?.settings, audio.duration)
        ? stored.settings
        : defaults;
      segments = Array.isArray(stored?.segments)
        ? stored.segments.filter((x) => validSegment(x, audio.duration))
        : [];
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
      renderSegments();
      render(currentEngine);
      persist();
      setMediaMetadata(file.name);
      // The waveform comes after playback is ready, so drawing it never delays practice.
      readableAudio(file)
        .then(analyzeAudio)
        .then((result) => {
          if (generation !== loadGeneration || !result) return;
          analysis = result;
          showAnalysis();
        })
        .catch(() => {
          /* Without a waveform the plain gauge still works. */
        });
      if (!storageWarning)
        notice("音声を読み込みました。再生ボタンを押すと練習を始めます。");
    },
    { once: true },
  );
  $("notice").textContent = "音声を端末から読み込み中です。";
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
$("file-input").addEventListener("change", (event) => {
  importFiles(Array.from(event.target.files));
  event.target.value = "";
});
const dropZone = $("drop-zone");
for (const eventName of ["dragenter", "dragover"])
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
for (const eventName of ["dragleave", "drop"])
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
dropZone.addEventListener("drop", (event) => {
  importFiles(Array.from(event.dataTransfer.files));
});
// Avoid browser navigation when a file is dropped outside the target.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
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
    mode: $("repeat-mode").value,
    a: parseTime($("point-a").value),
    b: parseTime($("point-b").value),
    limit: Number($("repeat-count").value),
    gap: $("gap").value.trim() === "" ? NaN : Number($("gap").value),
    gapRatio: Number($("gap-mode").value),
    rampStep: Number($("ramp-step").value),
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
for (const id of [
  "repeat-mode",
  "point-a",
  "point-b",
  "repeat-count",
  "gap-mode",
  "gap",
  "ramp-step",
]) {
  $(id).addEventListener("change", () => updateSettings());
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      updateSettings();
    }
  });
}
$("save-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!ready || !updateSettings()) return;
  const name = $("segment-name").value.trim();
  if (!name) {
    notice("練習区間の名前を入力してください。");
    return;
  }
  segments.push({ ...settings(), id: crypto.randomUUID(), name });
  persist();
  renderSegments();
  $("segment-name").value = "";
  if (!storageWarning) notice(`「${name}」を保存しました。`);
});
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

let analysis = null;
function showAnalysis() {
  const shown = Boolean(analysis && ready);
  $("waveform").hidden = !shown;
  $("interval-gauge").classList.toggle("has-waveform", shown);
  const phrases = shown && analysis.phrases.length >= 2;
  $("phrase-actions").hidden = !phrases;
  $("phrase-help").hidden = !phrases;
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
function stepPhrase(direction) {
  if (!ready || !analysis) return;
  const here = engine.mode === "ab" ? engine.a : engine.audio.currentTime;
  const phrases = analysis.phrases;
  const target =
    direction > 0
      ? phrases.find((p) => p.start > here + 0.05)
      : phrases.findLast((p) => p.start < here - 0.05);
  if (!target) {
    notice(direction > 0 ? "これが最後の文です。" : "これが最初の文です。");
    return;
  }
  const b = Math.min(target.end, engine.audio.duration);
  if (updateSettings({ a: target.start, b, mode: "ab" })) {
    if (zoomed()) fitView();
    engine.seek(target.start);
  }
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
$("toggle-ab").addEventListener("click", () =>
  updateSettings({ mode: engine.mode === "ab" ? "off" : "ab" }),
);
$("gauge-set-a").addEventListener("click", () =>
  updateSettings({ a: engine.audio.currentTime, mode: "ab" }),
);
$("gauge-set-b").addEventListener("click", () =>
  updateSettings({ b: engine.audio.currentTime, mode: "ab" }),
);

function renderAudioList() {
  $("audio-list").replaceChildren();
  $("audio-count").textContent = audioItems.length + " / 10件";
  for (const record of audioItems) {
    const li = document.createElement("li");
    li.className = "audio-item";
    const open = document.createElement("button");
    open.className = "audio-open";
    open.textContent = record.name;
    open.setAttribute("aria-label", record.name + "を開く");
    if (record.id === fileKey) {
      open.setAttribute("aria-current", "true");
      li.classList.add("current");
    }
    open.addEventListener("click", () => {
      if (record.id !== fileKey || !ready) void loadFile(storedFile(record));
    });
    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.textContent = "音声を削除";
    remove.setAttribute("aria-label", record.name + "の音声を削除");
    remove.addEventListener("click", () => void deleteAudio(record, remove));
    li.append(open, remove);
    $("audio-list").append(li);
  }
}
function closeCurrentAudio() {
  persist();
  setMediaMetadata(null);
  discardRecording();
  analysis = null;
  showAnalysis();
  ++loadGeneration;
  clearTimeout(loadTimeout);
  markerDrag = null;
  seekDrag = null;
  engine?.dispose();
  engine = null;
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  ready = false;
  $("load-audio").hidden = true;
  fileKey = null;
  segments = [];
  enable(false);
  renderSegments();
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
async function deleteAudio(record, button) {
  button.disabled = true;
  // Read the bytes first: a Blob backed by IndexedDB may be unreadable once its record is gone.
  let bytes = null;
  try {
    bytes = await storedFile(record).arrayBuffer();
  } catch {
    /* Delete anyway; this deletion just cannot be undone. */
  }
  try {
    await removeAudio(record.id);
  } catch {
    $("library-status").textContent =
      "削除できませんでした。音声は一覧に残っています。";
    button.disabled = false;
    return;
  }
  audioItems = audioItems.filter((item) => item.id !== record.id);
  if (fileKey === record.id) closeCurrentAudio();
  renderAudioList();
  void showStorageInfo();
  $("library-status").textContent =
    "音声を削除しました。練習区間は残っているので、同じファイルをもう一度追加すると使えます。";
  if (!bytes) {
    settleUndo();
    return;
  }
  offerUndo(`「${record.name}」を削除しました。`, async () => {
    try {
      const restored = await restoreAudio(record, bytes);
      audioItems = [...audioItems, restored].sort(
        (a, b) => a.addedAt - b.addedAt,
      );
      renderAudioList();
      void showStorageInfo();
      $("library-status").textContent = `「${record.name}」を元に戻しました。`;
    } catch (e) {
      $("library-status").textContent = e.message.includes("10件")
        ? e.message
        : "元に戻せませんでした。元のファイルをもう一度追加してください。";
    }
  });
}
function importFiles(files) {
  if (!files.length) return;
  void loadFile(files[0]);
  // Serialize imports so overlapping selections cannot exceed the cap or lose entries.
  importQueue = importQueue
    .then(async () => {
      $("library-status").textContent =
        "音声を保存中です。終わるまでこのページを閉じないでください。";
      let saved = 0;
      let deferred = 0;
      // iOS defers metadata for every file alike; after the first, do not wait 8 s per file.
      let probeWait = 8000;
      const problems = [];
      for (const file of files) {
        try {
          const validation = await validateAudio(file, probeWait);
          if (validation.metadataDeferred) probeWait = 1000;
          const record = await addAudio(file);
          if (validation.metadataDeferred) deferred++;
          if (!audioItems.some((item) => item.id === record.id))
            audioItems.push(record);
          saved++;
          renderAudioList();
        } catch (e) {
          const message =
            e.name === "QuotaExceededError"
              ? "ブラウザの保存容量が不足しています。不要な登録音声を削除してください。"
              : [
                    "AudioReadTimeout",
                    "AudioReadError",
                    "AudioFormatError",
                  ].includes(e.name)
                ? e.message
                : e.message?.includes("10件")
                  ? e.message
                  : "音声を保存できませんでした。ファイルの形式・保存容量・ブラウザの設定を確認してください。";
          problems.push(file.name + "：" + message);
        }
      }
      if (saved) await requestPersistentStorage();
      $("library-status").textContent = problems.length
        ? saved +
          "件を保存しました。保存できなかった音声：" +
          problems.join(" / ") +
          " 保存できなかった音声も、このページを開いている間は再生できますが、閉じると残りません。"
        : saved +
          "件の音声を保存しました。次回も一覧から開けます。" +
          (deferred
            ? " まだ再生を確認できていない音声があります。その音声を開き、「音声の読み込みを始める」を押して、再生できるか確かめてください。"
            : "");
      void showStorageInfo();
    })
    .catch(() => {
      $("library-status").textContent =
        "音声の保存に失敗しました。再度お試しください。";
    });
}
// Avoid racing an import with the initial database read.
importQueue = listAudio()
  .then((items) => {
    audioItems = items;
    renderAudioList();
    $("library-status").textContent = items.length
      ? "音声名を押すと、前回の設定のまま練習を再開できます。"
      : "音声は10件まで登録できます。複数のファイルをまとめて選ぶこともできます。";
    void showStorageInfo();
  })
  .catch(() => {
    $("library-status").textContent =
      "このブラウザでは音声を保存できません。ファイルを選べば、このページを開いている間は再生できます。";
  });

window.addEventListener("offline-update", () => {
  if (engine) {
    engine.pause();
    persist();
  }
});

$("undo-button").addEventListener("click", () => {
  const revert = undo?.revert;
  settleUndo();
  void revert?.();
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

// Without persistent storage, browsers may evict saved audio when the device runs low on space.
async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted()))
      await navigator.storage.persist();
  } catch {
    /* The audio stays saved; it is only less protected from eviction. */
  }
}
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + "GB";
  return Math.max(0.1, bytes / 1024 ** 2).toFixed(1) + "MB";
}
async function showStorageInfo() {
  const info = $("storage-info");
  if (!navigator.storage?.estimate || !audioItems.length) {
    info.hidden = true;
    return;
  }
  try {
    const [{ usage = 0 }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? false,
    ]);
    info.textContent =
      `使用中の容量：約${formatBytes(usage)}。` +
      (persisted
        ? "空き容量が少なくなっても、ブラウザが自動で消さない設定です。"
        : "空き容量が少なくなると、ブラウザが音声を消す場合があります。元のファイルは残しておいてください。");
    info.hidden = false;
  } catch {
    info.hidden = true;
  }
}

// Backup holds settings and segments only; audio stays in the device's own files.
const BACKUP_APP = "coachingl-audio-loop";
function backupStatus(message) {
  $("backup-status").textContent = message;
  $("backup-status").hidden = !message;
}
function countSegments(entries) {
  return Object.values(entries).reduce(
    (total, entry) =>
      total + (Array.isArray(entry?.segments) ? entry.segments.length : 0),
    0,
  );
}
$("export-backup").addEventListener("click", () => {
  persist();
  if (!Object.keys(library).length) {
    backupStatus("まだ、保存する練習区間や設定がありません。");
    return;
  }
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const body = JSON.stringify(
    { app: BACKUP_APP, version: 1, exportedAt: date.toISOString(), library },
    null,
    2,
  );
  const url = URL.createObjectURL(
    new Blob([body], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `coachingl-audio-loop_data_${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupStatus(
    `バックアップを保存しました（練習区間 ${countSegments(library)}件）。音声ファイルは入っていないので、元のファイルも残しておいてください。`,
  );
});
$("import-backup").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    data = null;
  }
  const entries = data?.library;
  if (
    data?.app !== BACKUP_APP ||
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries)
  ) {
    backupStatus(
      "このファイルは、このアプリのバックアップではないようです。「バックアップを保存」で作ったファイル（coachingl-audio-loop_data_….json）を選んでください。",
    );
    return;
  }
  if (data.version > 1) {
    backupStatus(
      "このバックアップは、新しい版のアプリで作られています。このページを再読み込みしてから、もう一度読み込んでください。",
    );
    return;
  }
  persist();
  let added = 0;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    const local = library[key] || {};
    // Local settings and position win; segments are added unless this device has them.
    if (!local.settings && validSettings(entry.settings, Infinity))
      local.settings = entry.settings;
    if (local.position === undefined && Number.isFinite(entry.position))
      local.position = entry.position;
    const have = new Set((local.segments || []).map((x) => x.id));
    const incoming = Array.isArray(entry.segments)
      ? entry.segments.filter(
          (x) => validSegment(x, Infinity) && !have.has(x.id),
        )
      : [];
    if (incoming.length) {
      local.segments = [...(local.segments || []), ...incoming];
      added += incoming.length;
    }
    if (Object.keys(local).length) library[key] = local;
  }
  if (ready && library[fileKey]) {
    segments = (library[fileKey].segments || []).filter((x) =>
      validSegment(x, engine.audio.duration),
    );
    renderSegments();
  }
  saveLibrary();
  backupStatus(
    added
      ? `練習区間を${added}件読み込みました。対象の音声を開くと使えます。今ある練習区間はそのまま残っています。`
      : "このバックアップの練習区間は、すべてこの端末に入っています。足すものはありません。",
  );
});

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
  r: () => updateSettings({ mode: engine.mode === "ab" ? "off" : "ab" }),
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
const voice = new Audio();
let recordingURL = null;
let recordTick = null;
let compareToken = 0;
// A recording still running when its audio is closed belongs to that audio; drop it.
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
  $("play-recording").disabled = false;
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
  $("play-recording").disabled = true;
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
$("play-recording").addEventListener("click", () => {
  if (!recordingURL) return;
  stopCompare();
  if (engine?.active) engine.pause();
  const token = compareToken;
  recordStatus("自分の声を再生中");
  voice.currentTime = 0;
  voice.play().catch(() => {});
  voice.onended = () => token === compareToken && recordStatus("録音あり");
});
$("compare").addEventListener("click", async () => {
  if (!ready || !recordingURL) return;
  stopCompare();
  const token = compareToken;
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
