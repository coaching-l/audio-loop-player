# Whisper base（文字起こし用のモデル）

OpenAIのWhisper（base・多言語）を、Transformers.jsで動くONNX形式にしたものです。英語と中国語の文字起こしに使います。

- 入手元：Hugging Face の [`onnx-community/whisper-base_timestamped`](https://huggingface.co/onnx-community/whisper-base_timestamped)（リビジョン `608c49e61301901684bc36cac8f74b95ff6b5a8e`）
  - 単語ごとの時刻（`return_timestamps: "word"`）に必要なクロスアテンションを出力する版です。
  - 元のモデル：[`openai/whisper-base`](https://huggingface.co/openai/whisper-base)
- 使っているファイル：設定とトークナイザー（`*.json`）、8ビット量子化したエンコーダー（`onnx/encoder_model_quantized.onnx`）とデコーダー（`onnx/decoder_model_merged_quantized.onnx`）
- 形式：ONNXとJSONだけです（Pythonのpickle形式のファイルは含みません）。
- ライセンス：Whisperのコードとモデルの重みはMITライセンスで公開されています（`LICENSE`、[openai/whisper](https://github.com/openai/whisper)）。Hugging Face上の `openai/whisper-base` はApache-2.0と表示しています。

各ファイルのサイズとSHA-256は `transcriber.js` の `MODEL_FILES` に記録しています。ダウンロードしたファイルのSHA-256は、Hugging Faceが表示する値（LFSのoid）と一致することを確かめました。
