import { readableAudio } from "./audio-import.js";
export const MAX_AUDIO_FILES = 10;
export function audioKey(file) {
  return JSON.stringify([file.name, file.size, file.lastModified]);
}
let connection;
export function openLibrary() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open("coaching-l-audio-library", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("audio", { keyPath: "id" });
      request.onerror = () => {
        connection = null;
        reject(request.error);
      };
      request.onblocked = () => {
        connection = null;
        reject(new Error("別のタブを閉じてから、もう一度お試しください。"));
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        resolve(db);
      };
    });
  return connection;
}
export async function listAudio() {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("audio", "readonly");
    const request = transaction.objectStore("audio").getAll();
    transaction.oncomplete = () =>
      resolve(request.result.sort((a, b) => a.addedAt - b.addedAt));
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => {};
  });
}
export async function addAudio(file) {
  file = await readableAudio(file);
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("audio", "readwrite");
    const store = transaction.objectStore("audio");
    let record, problem;
    const lookup = store.get(audioKey(file));
    lookup.onsuccess = () => {
      if (lookup.result) {
        record = lookup.result;
        return;
      }
      const count = store.count();
      count.onsuccess = () => {
        if (count.result >= MAX_AUDIO_FILES) {
          problem = new Error(
            "登録できる音声は10件までです。不要な音声を削除してから追加してください。",
          );
          transaction.abort();
          return;
        }
        record = {
          id: audioKey(file),
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          addedAt: Date.now(),
          blob: new Blob([file], { type: file.type }),
        };
        try {
          store.add(record);
        } catch (error) {
          problem = error;
          transaction.abort();
        }
      };
    };
    transaction.oncomplete = () => resolve(record);
    transaction.onabort = () =>
      reject(
        problem || transaction.error || new Error("音声を保存できません。"),
      );
    transaction.onerror = () => {};
  });
}
export async function removeAudio(id) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("audio", "readwrite");
    transaction.objectStore("audio").delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => {};
  });
}
export function storedFile(record) {
  return new File([record.blob], record.name, {
    type: record.type,
    lastModified: record.lastModified,
  });
}
// Explicitly load the probe. Mobile browsers may still defer metadata until a tap.
// A timeout is not proof of corrupt bytes: preserve the file and request playback confirmation.
export async function validateAudio(file) {
  file = await readableAudio(file);
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const timeout = setTimeout(() => finish("deferred"), 8000);
    function finish(valid) {
      clearTimeout(timeout);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      valid
        ? resolve({ metadataDeferred: valid === "deferred" })
        : reject(
            Object.assign(
              new Error(
                "このブラウザで再生できない形式か、音声ファイルが破損しています。MP3・M4A・WAVなどの別ファイルをお試しください。",
              ),
              { name: "AudioFormatError" },
            ),
          );
    }
    audio.preload = "metadata";
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) && audio.duration > 0);
    audio.onerror = () => finish(false);
    audio.src = url;
    audio.load();
  });
}
