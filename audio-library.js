import { readableAudio } from "./audio-import.js";
export const MAX_AUDIO_FILES = 20;
// Thrown when the library already holds MAX_AUDIO_FILES; callers check its name.
function libraryFull(message) {
  const error = new Error(message);
  error.name = "LibraryFullError";
  return error;
}
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
        reject(
          new Error(
            "このページを開いているほかのタブを閉じてから、もう一度お試しください。",
          ),
        );
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
  try {
    return await saveRecord(file, new Blob([file], { type: file.type }));
  } catch (error) {
    // WebKit cannot store Blobs in private browsing (UnknownError); raw bytes still work there.
    if (error.name !== "UnknownError") throw error;
    return saveRecord(file, await file.arrayBuffer());
  }
}
// `data` is a Blob, or an ArrayBuffer where Blobs cannot be stored; File accepts either.
async function saveRecord(file, data) {
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
          problem = libraryFull(
            `登録できる音声は${MAX_AUDIO_FILES}件までです。不要な音声を削除してから追加してください。`,
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
          blob: data,
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
// Undo for a deletion: put the record back with bytes read before it was deleted.
export async function restoreAudio(record, bytes) {
  const save = (data) => putBack({ ...record, blob: data });
  try {
    return await save(new Blob([bytes], { type: record.type }));
  } catch (error) {
    if (error.name !== "UnknownError") throw error;
    return save(bytes);
  }
}
async function putBack(record) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("audio", "readwrite");
    const store = transaction.objectStore("audio");
    let problem;
    const count = store.count();
    count.onsuccess = () => {
      if (count.result >= MAX_AUDIO_FILES) {
        problem = libraryFull(
          `登録できる音声が${MAX_AUDIO_FILES}件に達しているため、元に戻せません。`,
        );
        transaction.abort();
        return;
      }
      try {
        store.put(record);
      } catch (error) {
        problem = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(record);
    transaction.onabort = () =>
      reject(problem || transaction.error || new Error("元に戻せません。"));
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
// The name shown for a material: the learner's own, or else its file name. The file
// name itself never changes, since it identifies the material and its settings.
export function displayName(record) {
  return record.title || record.name;
}
export async function renameAudio(id, title) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("audio", "readwrite");
    const store = transaction.objectStore("audio");
    let record;
    const lookup = store.get(id);
    lookup.onsuccess = () => {
      if (!lookup.result) return;
      record = { ...lookup.result, title };
      store.put(record);
    };
    transaction.oncomplete = () =>
      record ? resolve(record) : reject(new Error("音声が見つかりません。"));
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
// `wait` shortens the probe once a batch has shown that this browser defers metadata.
export async function validateAudio(file, wait = 8000) {
  file = await readableAudio(file);
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const timeout = setTimeout(() => finish("deferred"), wait);
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
                "このブラウザでは再生できない形式か、ファイルが壊れています。MP3・M4A・WAVなど、別のファイルをお試しください。",
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
