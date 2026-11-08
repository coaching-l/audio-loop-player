# 話者の試聴サンプル

全10話者の実際の合成音声です。テスト用のトーンや別サービスの代替音声ではありません。

- 英語：Kokoro v1.0（fp32）、中国語：Kokoro v1.1-zh（fp32）。話者IDはアプリと同じです。英語の試聴は品質を優先し、事前生成には量子化していないモデルを使います（通常のテキスト音声化は従来のq8）。試聴時はMP3だけを読み込みます。
- 読み：このリポジトリの `english.js` / `mandarin.js`。速度1.0、24kHzモノラル、MP3 128kbps。
- 原稿は `voices.js` の `PREVIEW_TEXT`。各言語で同じ文章を使います。
- 話者ベクトルはアプリと同じく音素数で選択します。音量の個別補正・速度変更・音声の差し替えはしていません。
- 生成にはKokoro-ONNXのGitHub release `model-files-v1.1` のモデルと声の配布ファイルを使用しました。この環境からHugging Faceを取得できないためです。Kokoroの世代と声はアプリと同じですが、アプリが使うHugging Face固定版ONNXと同一バイナリではありません。CPU実行とブラウザ実行、ONNX変換・量子化の違いで波形が完全に一致することは保証しません。
- `manifest.json` に配布元URL、モデル・声のSHA-256、原稿、音素、読み処理のハッシュ、音声の長さ・サイズ・SHA-256を記録しています。新たに生成する音声には、生成直後とMP3復号後のピーク振幅も記録します。両段階で音量上限に余裕があることを確認しますが、数値検査だけで聴感品質を保証するものではありません。
- KokoroのモデルはApache-2.0です。ライセンスは `LICENSE-Kokoro.txt`。参照：https://github.com/hexgrad/kokoro 、https://github.com/thewh1teagle/kokoro-onnx 。

## 再作成（開発時だけ）

Pythonの `numpy`・`onnxruntime` と `ffmpeg` が必要です。`manifest.json` の配布元からモデル2個・声のデータ2個をローカルのディレクトリに用意してください。大きなモデル本体をリポジトリに追加しないでください。

```sh
node scripts/preview-inputs.mjs /tmp/voice-preview-inputs.json
python scripts/build-voice-previews.py /tmp/voice-preview-inputs.json /path/to/model-directory
# 一方の言語だけなら、上の生成コマンドの代わりに（もう一方の音声と記録は保持）
python scripts/build-voice-previews.py /tmp/voice-preview-inputs.json /path/to/model-directory --language en
npm run bump-shell
```

音声生成は端末内で行います。配布元へ原稿を送信しません。試聴にモデルのダウンロードや実行は不要です。

再作成した際は更新対象の実再生・波形・原稿を確認し、音声と `manifest.json` を一緒に更新します。音割れや自然さは、人が実際に聴いて確認する必要があります。声を追加するときは `sw.js` のキャッシュ対象にもMP3を追加します。
