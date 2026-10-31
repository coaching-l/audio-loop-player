// The way in from audio files ("音源から始める"): the saved audio list, adding files and
// deleting them. Opening one hands it to the shared practice screen (practice.js).
import "./offline.js";
import {
  listAudio,
  addAudio,
  removeAudio,
  restoreAudio,
  storedFile,
  validateAudio,
} from "./audio-library.js";
import { openPractice, closePractice, practiceState } from "./practice.js";
import { $, settleUndo, offerUndo } from "./ui.js";

let audioItems = [];
let importQueue = Promise.resolve();

function openAudio(file) {
  void openPractice({ file });
  renderAudioList();
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

function renderAudioList() {
  const { key } = practiceState();
  $("audio-list").replaceChildren();
  $("audio-count").textContent = audioItems.length + " / 10件";
  for (const record of audioItems) {
    const li = document.createElement("li");
    li.className = "audio-item";
    const open = document.createElement("button");
    open.className = "audio-open";
    open.textContent = record.name;
    open.setAttribute("aria-label", record.name + "を開く");
    if (record.id === key) {
      open.setAttribute("aria-current", "true");
      li.classList.add("current");
    }
    open.addEventListener("click", () => {
      const state = practiceState();
      if (record.id !== state.key || !state.ready)
        openAudio(storedFile(record));
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
  if (practiceState().key === record.id) closePractice();
  renderAudioList();
  void showStorageInfo();
  $("library-status").textContent =
    "音声を削除しました。設定とスクリプトは残っているので、同じファイルをもう一度追加すると使えます。";
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
  openAudio(files[0]);
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
