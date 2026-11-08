# 話者の試聴サンプル

全10話者の実際の合成音声です。テスト用のトーンや別サービスの代替音声ではありません。

- 英語：Kokoro v1.0（int8）、中国語：Kokoro v1.1-zh（fp32）。話者IDはアプリと同じです。
- 読み：このリポジトリの `english.js` / `mandarin.js`。速度1.0、24kHzモノラル、MP3 128kbps。
- 原稿は `voices.js` の `PREVIEW_TEXT`。各言語で同じ文章を使います。
- 話者ベクトルはアプリと同じく音素数で選択します。音量の個別補正・速度変更・音声の差し替えはしていません。
- 生成にはKokoro-ONNXのGitHub release `model-files-v1.1` のモデルと声の配布ファイルを使用しました。この環境からHugging Faceを取得できないためです。Kokoroの世代と声はアプリと同じですが、アプリが使うHugging Face固定版ONNXと同一バイナリではありません。CPU実行とブラウザ実行、ONNX変換・量子化の違いで波形が完全に一致することは保証しません。
- `manifest.json` に配布元URL、モデル・声のSHA-256、原稿、音素、読み処理のハッシュ、音声の長さ・サイズ・SHA-256を記録しています。
- KokoroのモデルはApache-2.0です。ライセンスは `LICENSE-Kokoro.txt`。参照：https://github.com/hexgrad/kokoro 、https://github.com/thewh1teagle/kokoro-onnx 。

## 再作成（開発時だけ）

Pythonの `numpy`・`onnxruntime` と `ffmpeg` が必要です。`manifest.json` の配布元からモデル2個・声のデータ2個をローカルのディレクトリに用意してください。大きなモデル本体をリポジトリに追加しないでください。

```sh
node scripts/preview-inputs.mjs /tmp/voice-preview-inputs.json
python scripts/build-voice-previews.py /tmp/voice-preview-inputs.json /path/to/model-directory
npm run bump-shell
```

音声生成は端末内で行います。配布元へ原稿を送信しません。試聴にモデルのダウンロードや実行は不要です。

再作成した際は全10ファイルの実再生と原稿の確認を行い、音声と `manifest.json` を一緒に更新します。声を追加するときは `sw.js` のキャッシュ対象にもMP3を追加します。
