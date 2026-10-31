# 同梱している外部のプログラム

音声からの文字起こし（`transcriber.js`・`transcribe-worker.js`）だけが使います。CDNからは読み込まず、このサイトのファイルとして配信します。最初に文字起こしするときに `transcriber.js` が受け取り、SHA-256を確かめてからブラウザに保存します（`sw.js` の `FILES` には入れていません）。

| ファイル                                  | 元のパッケージ                                      | ライセンス                                                                          |
| ----------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `transformers/transformers.min.js`        | npm `@huggingface/transformers` 4.3.2 の `dist/`    | Apache-2.0（`transformers/LICENSE`）。ONNX Runtime Web（MIT）などを含みます         |
| `onnxruntime/ort-wasm-simd-threaded.mjs`  | npm `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0 | MIT（`onnxruntime/LICENSE`、第三者の表示は `onnxruntime/ThirdPartyNotices.txt`）    |
| `onnxruntime/ort-wasm-simd-threaded.wasm` | 同上                                                | 同上                                                                                |
| `opencc/t2cn.js`                          | npm `opencc-js` 1.4.2 の `dist/esm/t2cn.js`         | MIT（`opencc/LICENSE`）、辞書データはApache-2.0（`opencc/THIRD_PARTY_LICENSES.md`） |

- `onnxruntime-web` の版は、`transformers.min.js` に組み込まれている版（`1.31.0-dev.20260914-8d85527a0`）と同じものです。違う版のWASMを組み合わせると動きません。
- WASMは、WebGPUを使わない通常版（`ort-wasm-simd-threaded`）です。複数スレッドにはクロスオリジン分離が必要なため、1スレッドで動かします。
- `opencc` は、Whisperが繁体字で書いた中国語を簡体字に直すために使います。

各ファイルのサイズとSHA-256は `transcriber.js` の `MODEL_FILES` にあり、`tests/transcribe.spec.js` がディスク上のファイルと一致するか確かめます。

## 入れ替えるとき

1. 新しい版のファイルをここに置き、`transcriber.js` の `MODEL_FILES` のサイズとSHA-256を書き換えます。
2. `transcriber.js` の `MODEL_CACHE` の末尾の番号を1つ上げます（利用者のブラウザは、変わったファイルだけを受け取り直し、変わっていないファイルは前の保存先から写します）。
3. `npm run bump-shell` を実行します。
