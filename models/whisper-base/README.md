# Whisper base（文字起こし用のモデル）

OpenAIのWhisper（base・多言語）を、Transformers.jsで動くONNX形式にしたものです。英語と中国語の文字起こしに使います。

- 元のファイル：Hugging Face の [`Xenova/whisper-base`](https://huggingface.co/Xenova/whisper-base)（コミット `64da57285918e20ea79ea5c88eed7197933abaa8`）。Transformers.jsの作者が公開している変換版です。元のモデルは [`openai/whisper-base`](https://huggingface.co/openai/whisper-base) です。
- 入手の経路：作業環境からHugging Faceの配信サーバーに接続できなかったため、同じファイルを収めたnpmパッケージ `sts-whisper-base` 1.0.0 から取り出しました。取り出した全14ファイル（エンコーダーは手を加える前）が、Hugging Faceが公開しているハッシュ（大きなファイルはSHA-256、それ以外はgitのblobのSHA-1）と一致することを確かめてあります。つまり中身はHugging Face上のファイルと同一です。
- 使っているファイル：設定とトークナイザー（`*.json`）、8ビット量子化したエンコーダー（`onnx/encoder_model_quantized.onnx`）とデコーダー（`onnx/decoder_model_merged_quantized.onnx`）。
- エンコーダーだけ手を加えています：使わない注意の重み（`encoder_attentions.0`〜`5`）を出力の一覧から外しました（`scripts/strip-encoder-attentions.py`、onnx 1.23.2）。ノードと重みは変えていません。これがあると、ONNX Runtimeが約430MBを最後まで持ち続け、iPhoneでページが再読み込みされたためです。元のファイルのSHA-256は `3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9`（Hugging Faceの値と同じ）、手を加えたあとの値は `transcriber.js` の `MODEL_FILES` にあります。
- 形式：ONNXとJSONだけです（Pythonのpickle形式のファイルは含みません）。
- 時刻：このモデルは単語ごとの時刻を出せない版なので、Whisperの区切り（セグメント）ごとの時刻を使い、中の文には波形の音のある部分で時間を割り振っています（`transcript.js` の `transcriptFromSegments`）。
- ライセンス：Whisperのコードとモデルの重みはMITライセンスで公開されています（`LICENSE`、[openai/whisper](https://github.com/openai/whisper)）。Hugging Face上の `openai/whisper-base` と `sts-whisper-base` はApache-2.0と表示しています。

各ファイルのサイズとSHA-256は `transcriber.js` の `MODEL_FILES` に記録し、`tests/transcribe.spec.js` がディスク上のファイルと照合します。
