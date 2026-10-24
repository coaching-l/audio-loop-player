// iOS file providers may supply a File whose bytes are not yet local/readable.
// Read once and share the owned, memory-backed File between playback and storage.
const prepared = new WeakMap();
function importError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}
export function readableAudio(file) {
  if (!prepared.has(file)) {
    const promise = (async () => {
      let timer;
      try {
        const bytes = await Promise.race([
          file.arrayBuffer(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  importError(
                    "AudioReadTimeout",
                    "ファイルの読み取りに時間がかかっています。クラウド上のファイルは、端末へのダウンロードを済ませてから選び直してください。",
                  ),
                ),
              60000,
            );
          }),
        ]);
        if (!bytes.byteLength)
          throw importError(
            "AudioReadError",
            "ファイルの中身が空です。元のファイルを確認してください。",
          );
        const extension = file.name.split(".").pop().toLowerCase();
        const types = {
          mp3: "audio/mpeg",
          m4a: "audio/mp4",
          wav: "audio/wav",
          aac: "audio/aac",
          ogg: "audio/ogg",
          opus: "audio/ogg",
          flac: "audio/flac",
          webm: "audio/webm",
        };
        const type = types[extension] || file.type;
        const copy = new File([bytes], file.name, {
          type,
          lastModified: file.lastModified,
        });
        prepared.set(copy, Promise.resolve(copy));
        return copy;
      } catch (error) {
        if (["AudioReadTimeout", "AudioReadError"].includes(error.name))
          throw error;
        throw importError(
          "AudioReadError",
          "ファイルを読み取れません。「ファイル」アプリなどでダウンロードを済ませ、端末に保存してから選び直してください。",
        );
      } finally {
        clearTimeout(timer);
      }
    })();
    prepared.set(file, promise);
  }
  return prepared.get(file);
}
