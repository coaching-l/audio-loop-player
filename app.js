import { readableAudio } from "./audio-import.js";
import "./offline.js";
import {
  audioKey,
  listAudio,
  addAudio,
  removeAudio,
  storedFile,
  validateAudio,
} from "./audio-library.js";
import { LoopPlayer, parseTime, formatTime } from "./player.js";
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
    "ブラウザの保存機能を利用できないか、保存データを読み込めません。設定は今回の画面内で利用できます。",
  );
}
function settings() {
  return {
    mode: engine.mode,
    a: engine.a,
    b: engine.b,
    limit: engine.limit,
    gap: engine.gap,
    rate: engine.audio.playbackRate,
  };
}
function persist() {
  if (!ready || !fileKey) return;
  library[fileKey] = {
    settings: settings(),
    segments,
    position: engine.audio.currentTime,
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(library));
  } catch {
    storageWarning = true;
    notice(
      "ブラウザに保存できません。容量やプライベートブラウズの設定を確認してください。今回の画面内では利用できます。",
    );
  }
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
  $("speed").value = String(engine.audio.playbackRate);
  $("speed-value").textContent = engine.audio.playbackRate.toFixed(2) + "×";
  $("a-legend").textContent = "A " + formatTime(engine.a, 1);
  $("b-legend").textContent = "B " + formatTime(engine.b, 1);
  syncGauge();
}
function render(player) {
  if (!ready) return;
  $("current-time").textContent = formatTime(player.audio.currentTime, 1);
  $("seek").value = player.audio.currentTime;
  if (
    player.phase === "playing" &&
    performance.now() - lastPositionSave > 2000
  ) {
    lastPositionSave = performance.now();
    persist();
  }
  const active = player.active;
  $("play").textContent = active ? "Ⅱ" : "▶";
  $("play").setAttribute("aria-label", active ? "一時停止" : "再生");
  const statuses = {
    playing: "再生中",
    waiting: "無音待ち中",
    "gap-paused": "無音待ちを一時停止",
    paused: "一時停止",
    done: "再生完了",
  };
  const status = statuses[player.phase] || "";
  if ($("play-status").textContent !== status)
    $("play-status").textContent = status;
  $("play-status").classList.toggle(
    "waiting",
    player.phase === "waiting" || player.phase === "gap-paused",
  );
  const progress =
    player.mode === "off"
      ? "OFF"
      : `完了 ${player.completed} / ${player.limit || "∞"} 回`;
  if ($("repeat-progress").textContent !== progress)
    $("repeat-progress").textContent = progress;
}
function enable(value) {
  for (const id of ["player-controls", "repeat-controls", "save-controls"])
    $(id).disabled = !value;
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
    details.textContent = `${formatTime(segment.a, 2)} – ${formatTime(segment.b, 2)} · ${segment.rate.toFixed(2)}× · ${segment.limit || "無制限"}回 · 無音 ${segment.gap}秒`;
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
      notice(`「${segment.name}」を呼び出しました。再生ボタンで練習できます。`);
    });
    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", segment.name + "を削除");
    remove.addEventListener("click", () => {
      segments = segments.filter((item) => item.id !== segment.id);
      persist();
      renderSegments();
      notice(`「${segment.name}」を削除しました。`);
    });
    li.append(info, load, remove);
    $("segments").append(li);
  }
}
async function loadFile(file) {
  if (!file) return;
  persist();
  const generation = ++loadGeneration;
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
  $("play-status").textContent = "音声を読み込み中…";
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "再生");
  $("current-time").textContent = "0:00.0";
  $("duration").textContent = "0:00.0";
  $("seek").value = 0;
  $("seek").max = 0;
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
      "この音声を読み込めません。形式がブラウザに対応していないか、ファイルが破損しています。MP3・M4A・WAVなどの別のファイルをお試しください。",
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
        ? stored.segments.filter(
            (x) =>
              validSettings({ ...x, mode: "ab" }, audio.duration) &&
              typeof x.id === "string" &&
              typeof x.name === "string",
          )
        : [];
      ready = true;
      $("load-audio").hidden = true;
      currentEngine.configure(s);
      currentEngine.setRate(s.rate);
      if (Number.isFinite(stored?.position))
        currentEngine.seek(stored.position);
      $("duration").textContent = formatTime(audio.duration, 1);
      $("seek").max = audio.duration;
      syncFields();
      enable(true);
      renderSegments();
      render(currentEngine);
      persist();
      if (!storageWarning)
        notice("音声を読み込みました。再生ボタンで練習できます。");
    },
    { once: true },
  );
  $("notice").textContent = "音声を端末から読み込み中です。";
  try {
    const copy = await readableAudio(file);
    if (generation !== loadGeneration) return;
    objectURL = URL.createObjectURL(copy);
    notice(
      "読み込みが始まらない場合は「タップして読み込みを開始」を押してください。",
    );
    loadTimeout = setTimeout(() => {
      if (generation !== loadGeneration || ready) return;
      $("play-status").textContent = "タップして読み込み";
      notice(
        "ブラウザが読み込みを待機しています。「タップして読み込みを開始」を押してください。端末に未保存の場合は、ダウンロードを完了してから選び直してください。",
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
$("play").addEventListener("click", () => {
  if (!ready) return;
  error("");
  if (engine.active) {
    engine.pause();
    persist();
  } else void engine.play();
});
$("back").addEventListener("click", () =>
  engine.seek(engine.audio.currentTime - 5),
);
$("forward").addEventListener("click", () =>
  engine.seek(engine.audio.currentTime + 5),
);
$("seek").addEventListener("input", () => engine.seek(Number($("seek").value)));
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
    ...overrides,
  };
  try {
    engine.configure(s);
    rangeError("");
    syncFields();
    persist();
    return true;
  } catch (e) {
    rangeError(
      s.gap < 0 || s.gap > 10 || !Number.isFinite(s.gap)
        ? "無音時間は0〜10秒で指定してください。"
        : e.message,
    );
    return false;
  }
}
for (const id of ["repeat-mode", "point-a", "point-b", "repeat-count", "gap"]) {
  $(id).addEventListener("change", () => updateSettings());
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      updateSettings();
    }
  });
}
$("set-a").addEventListener("click", () =>
  updateSettings({ a: engine.audio.currentTime }),
);
$("set-b").addEventListener("click", () =>
  updateSettings({ b: engine.audio.currentTime }),
);
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

function syncGauge() {
  const duration = engine.audio.duration;
  for (const point of ["a", "b"]) {
    const marker = $("marker-" + point);
    marker.style.left = (engine[point] / duration) * 100 + "%";
    marker.setAttribute("aria-valuenow", engine[point]);
    marker.setAttribute("aria-valuemin", point === "a" ? 0 : engine.a + 0.001);
    marker.setAttribute(
      "aria-valuemax",
      point === "a" ? engine.b - 0.001 : duration,
    );
    marker.setAttribute("aria-valuetext", formatTime(engine[point]));
  }
  $("interval-fill").style.left = (engine.a / duration) * 100 + "%";
  $("interval-fill").style.right = 100 - (engine.b / duration) * 100 + "%";
  $("toggle-ab").setAttribute("aria-pressed", String(engine.mode === "ab"));
  $("toggle-ab").textContent =
    "区間リピート " + (engine.mode === "ab" ? "ON" : "OFF");
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
    moveMarker(
      point,
      ((event.clientX - rect.left) / rect.width) * engine.audio.duration,
    );
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
    const step = event.shiftKey ? 1 : 0.1;
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
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await removeAudio(record.id);
        audioItems = audioItems.filter((item) => item.id !== record.id);
        if (fileKey === record.id) {
          persist();
          ++loadGeneration;
          clearTimeout(loadTimeout);
          markerDrag = null;
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
          $("file-name").textContent = "ここに音声ファイルをドロップ";
          $("play-status").textContent = "音声を選択してください";
          $("play").textContent = "▶";
          $("play").setAttribute("aria-label", "再生");
          $("current-time").textContent = "0:00.0";
          $("duration").textContent = "0:00.0";
          $("seek").value = 0;
          $("seek").max = 0;
        }
        renderAudioList();
        $("library-status").textContent =
          "音声を削除しました。保存した練習区間は、同じ元ファイルを追加すると再利用できます。";
      } catch {
        $("library-status").textContent =
          "削除できませんでした。音声は一覧に残しています。";
        remove.disabled = false;
      }
    });
    li.append(open, remove);
    $("audio-list").append(li);
  }
}
function importFiles(files) {
  if (!files.length) return;
  void loadFile(files[0]);
  // Serialize imports so overlapping selections cannot exceed the cap or lose entries.
  importQueue = importQueue
    .then(async () => {
      $("library-status").textContent =
        "音声を保存中です。この画面を閉じずにお待ちください。";
      let saved = 0;
      let deferred = 0;
      const problems = [];
      for (const file of files) {
        try {
          const validation = await validateAudio(file);
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
                  : "音声を保存できませんでした。形式・保存容量・ブラウザの保存設定を確認してください。";
          problems.push(file.name + "：" + message);
        }
      }
      $("library-status").textContent = problems.length
        ? saved +
          "件保存。" +
          problems.join(" / ") +
          " 保存できない音声も今回の画面では再生を試せますが、再訪問時には残りません。"
        : saved +
          "件の音声を保存しました。次回も一覧から開けます。" +
          (deferred
            ? " 再生確認が必要な音声があります。音声を開き、読み込み開始ボタンを押して再生できるか確認してください。"
            : "");
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
      ? "音声を選ぶと前回の設定で開けます。"
      : "音声を10件まで追加できます。複数選択・まとめてドロップにも対応。";
  })
  .catch(() => {
    $("library-status").textContent =
      "音声の保存機能が利用できません。ファイルを選ぶと今回の画面内では再生できます。";
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
      "まだファイルを取得中です。端末へのダウンロードが完了しているか確認してください。",
    );
    return;
  }
  // Called directly by the gesture, not after an await: Safari may require this.
  const player = engine;
  player.audio.play().catch((error) => {
    if (player !== engine || error.name === "AbortError") return;
    notice(
      error.name === "NotAllowedError"
        ? "再度このボタンをタップしてください。別アプリ内で開いている場合は、通常のブラウザで開いてください。"
        : "音声を再生できません。端末に保存済みの別のMP3・M4A・WAVもお試しください。",
    );
  });
});
