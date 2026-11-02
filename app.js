// The first screen: the two ways in ("テキストから始める" in text-entry.js and
// "音源から始める" here: adding audio files) and the list of saved materials, which both
// fill. Opening one hands it to the shared practice screen (practice.js).
import "./offline.js";
import {
  listAudio,
  addAudio,
  removeAudio,
  restoreAudio,
  storedFile,
  validateAudio,
  displayName,
  renameAudio,
} from "./audio-library.js";
import {
  openPractice,
  closePractice,
  practiceState,
  renamePractice,
} from "./practice.js";
import { initTextEntry } from "./text-entry.js";
import { $, settleUndo, offerUndo } from "./ui.js";

let audioItems = [];
let importQueue = Promise.resolve();

// Which way in is shown; remembered for the next visit.
const entryKey = "kotonoha.entry.v1";
function chooseEntry(entry) {
  for (const [name, button, card] of [
    ["text", "entry-text", "text-entry"],
    ["audio", "entry-audio", "drop-zone"],
  ]) {
    $(button).setAttribute("aria-pressed", String(entry === name));
    $(card).hidden = entry !== name;
  }
  try {
    localStorage.setItem(entryKey, entry);
  } catch {
    /* Chosen for this page only. */
  }
}
$("entry-text").addEventListener("click", () => chooseEntry("text"));
$("entry-audio").addEventListener("click", () => chooseEntry("audio"));
try {
  const entry = localStorage.getItem(entryKey);
  if (["text", "audio"].includes(entry)) chooseEntry(entry);
} catch {
  /* Nothing chosen yet: both ways in are offered. */
}

// Keeps audio made from text in the saved list, in place of the previous version of the
// same text. With the list full, that previous version makes room for the new one.
async function saveMaterial(file, replaceId) {
  const run = importQueue.then(async () => {
    const replaced = audioItems.find((item) => item.id === replaceId);
    let record;
    try {
      record = await addAudio(file);
    } catch (error) {
      if (!replaced || !error.message?.includes("10件")) throw error;
      await removeAudio(replaced.id);
      audioItems = audioItems.filter((item) => item.id !== replaced.id);
      record = await addAudio(file);
    }
    if (!audioItems.some((item) => item.id === record.id))
      audioItems.push(record);
    // Made again from the same text: the name the learner gave it carries over.
    if (replaced?.title && !record.title) {
      record = await renameAudio(record.id, replaced.title);
      audioItems = audioItems.map((item) =>
        item.id === record.id ? record : item,
      );
      if (practiceState().key === record.id) renamePractice(record.title);
    }
    if (replaced && replaced.id !== record.id && audioItems.includes(replaced)) {
      await removeAudio(replaced.id);
      audioItems = audioItems.filter((item) => item.id !== replaced.id);
    }
    renderAudioList();
    await requestPersistentStorage();
    void showStorageInfo();
    libraryStatus(
      `「${displayName(record)}」を保存しました。次回も一覧から開けます。`,
    );
    return record;
  });
  importQueue = run.catch(() => {});
  try {
    return await run;
  } catch (error) {
    renderAudioList();
    libraryStatus(
      error.message?.includes("10件")
        ? error.message
        : "作った音声を保存できませんでした。このページを開いている間は練習できますが、閉じると残りません。",
      true,
    );
    return null;
  }
}
initTextEntry({ saveMaterial });

function openAudio(file) {
  void openPractice({ file });
  renderAudioList();
}
// A saved material opens under its own name, with the settings kept for its file.
function openRecord(record) {
  void openPractice({
    file: storedFile(record),
    key: record.id,
    name: displayName(record),
  });
  renderAudioList();
}
const MAX_TITLE = 60;
async function renameRecord(record) {
  const current = displayName(record);
  const answer = prompt("新しい名前を入力してください。", current);
  if (answer === null) return;
  const title = answer.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title || title === current) return;
  try {
    const renamed = await renameAudio(record.id, title);
    audioItems = audioItems.map((item) =>
      item.id === record.id ? renamed : item,
    );
    renderAudioList();
    if (practiceState().key === record.id) renamePractice(title);
    libraryStatus(`名前を「${title}」に変えました。`);
  } catch {
    libraryStatus("名前を変えられませんでした。もう一度お試しください。", true);
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

// The saved list stays out of the way while it is empty, unless it has news to show
// (saving in progress, or something that could not be saved).
let libraryNews = false;
function libraryStatus(message, news = false) {
  $("library-status").textContent = message;
  libraryNews = news;
  showLibrary();
}
function showLibrary() {
  $("audio-library").hidden = !audioItems.length && !libraryNews;
}
function renderAudioList() {
  showLibrary();
  const { key } = practiceState();
  $("audio-list").replaceChildren();
  $("audio-count").textContent = audioItems.length + " / 10件";
  for (const record of audioItems) {
    const li = document.createElement("li");
    li.className = "audio-item";
    const open = document.createElement("button");
    open.className = "audio-open";
    const name = displayName(record);
    open.textContent = name;
    open.setAttribute("aria-label", name + "を開く");
    if (record.id === key) {
      open.setAttribute("aria-current", "true");
      li.classList.add("current");
    }
    open.addEventListener("click", () => {
      const state = practiceState();
      if (record.id !== state.key || !state.ready)
        openRecord(record);
    });
    const rename = document.createElement("button");
    rename.className = "rename-button";
    rename.type = "button";
    rename.textContent = "✎";
    rename.setAttribute("aria-label", name + "の名前を変更");
    rename.addEventListener("click", () => void renameRecord(record));
    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", name + "の音声を削除");
    remove.addEventListener("click", () => void deleteAudio(record, remove));
    li.append(open, rename, remove);
    $("audio-list").append(li);
  }
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
    libraryStatus(
      "削除できませんでした。音声は一覧に残っています。",
    );
    button.disabled = false;
    return;
  }
  audioItems = audioItems.filter((item) => item.id !== record.id);
  if (practiceState().key === record.id) closePractice();
  renderAudioList();
  void showStorageInfo();
  libraryStatus(
    "音声を削除しました。設定とスクリプトは残っているので、同じファイルをもう一度追加すると使えます。",
  );
  if (!bytes) {
    settleUndo();
    return;
  }
  offerUndo(`「${displayName(record)}」を削除しました。`, async () => {
    try {
      const restored = await restoreAudio(record, bytes);
      audioItems = [...audioItems, restored].sort(
        (a, b) => a.addedAt - b.addedAt,
      );
      renderAudioList();
      void showStorageInfo();
      libraryStatus(
      `「${displayName(record)}」を元に戻しました。`,
    );
    } catch (e) {
      libraryStatus(
        e.message.includes("10件")
          ? e.message
          : "元に戻せませんでした。元のファイルをもう一度追加してください。",
        true,
      );
    }
  });
}
function importFiles(files) {
  if (!files.length) return;
  openAudio(files[0]);
  // Serialize imports so overlapping selections cannot exceed the cap or lose entries.
  importQueue = importQueue
    .then(async () => {
      libraryStatus(
        "音声を保存中です。終わるまでこのページを閉じないでください。",
        true,
      );
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
      libraryStatus(
        problems.length
          ? saved +
            "件を保存しました。保存できなかった音声：" +
            problems.join(" / ") +
            " 保存できなかった音声も、このページを開いている間は再生できますが、閉じると残りません。"
          : saved +
            "件の音声を保存しました。次回も一覧から開けます。" +
            (deferred
              ? " まだ再生を確認できていない音声があります。その音声を開き、「音声の読み込みを始める」を押して、再生できるか確かめてください。"
              : ""),
        problems.length > 0,
      );
      void showStorageInfo();
    })
    .catch(() => {
      libraryStatus(
        "音声の保存に失敗しました。再度お試しください。",
        true,
      );
    });
}
// Avoid racing an import with the initial database read.
importQueue = listAudio()
  .then((items) => {
    audioItems = items;
    renderAudioList();
    libraryStatus(
      items.length
        ? "名前を押すと、前回の設定のまま練習を再開できます。"
        : "作った音声や読み込んだ音源が、ここに10件まで保存されます。",
    );
    void showStorageInfo();
  })
  .catch(() => {
    libraryStatus(
      "このブラウザでは音声を保存できません。ファイルを選べば、このページを開いている間は再生できます。",
      true,
    );
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
const LOW_SPACE = 500 * 1024 ** 2;
async function showStorageInfo() {
  const info = $("storage-info");
  if (!navigator.storage?.estimate || !audioItems.length) {
    info.hidden = true;
    return;
  }
  try {
    const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? false,
    ]);
    // Shown only when space runs low: otherwise there is nothing to do about it.
    const free = quota - usage;
    if (!(quota > 0 && (free < LOW_SPACE || usage / quota > 0.8))) {
      info.hidden = true;
      return;
    }
    info.textContent =
      `保存容量が残り少なくなっています（使用中 約${formatBytes(usage)}・残り 約${formatBytes(Math.max(0, free))}）。使わない教材を削除してください。` +
      (persisted
        ? ""
        : "空き容量が足りなくなると、ブラウザが音声を消す場合があります。元のファイルは残しておいてください。");
    info.hidden = false;
  } catch {
    info.hidden = true;
  }
}
