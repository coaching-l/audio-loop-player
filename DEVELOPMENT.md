# 開発者向けメモ

利用者向けの説明は [README.md](README.md)、検証の記録は [VALIDATION.md](VALIDATION.md)、デザインの基準は [DESIGN.md](DESIGN.md) にあります。

## 起動

ビルド不要の静的サイトです。Node.js 22以降で、リポジトリのルートから実行します（アプリの起動に `npm install` は不要です）。

```sh
npm start            # http://localhost:4173
PORT=8080 npm start  # ポートを変える
```

JavaScriptモジュールとService Workerを使うため、HTMLをダブルクリックする `file://` では動きません。オフライン機能とマイクは、HTTPSか `localhost` でだけ使えます。

## 構成

| ファイル                   | 役割                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `index.html` / `style.css` | 画面と見た目。CSPは `index.html` の `<meta>` にあります                                                 |
| `app.js`                   | 画面の操作、保存・呼び出し、バックアップ、取り消し、ミニプレーヤー、Media Session、キー操作、録音の画面 |
| `player.js`                | 再生エンジン：A–B・回数・無音・速度の段階アップ、タイマーの破棄、時刻の変換                             |
| `audio-library.js`         | IndexedDBへの音声保存（10件まで）、削除と取り消し、保存前の再生確認                                     |
| `audio-import.js`          | 選んだファイルを一度だけ読み取り、MIMEを補う（iOSのファイル提供元への対策）                             |
| `transcript.js`            | 原文の文への区切り（英語・中国語）、波形の無音を使った時刻の対応づけ、文字コードの判別                  |
| `transcriber.js`           | 文字起こしの準備：モデルの受け取りと確認・保存（Cache Storage）、16kHzへの変換、無音での分割            |
| `transcribe-worker.js`     | Workerの中でWhisperを動かし、区切り（セグメント）ごとの時刻を返す。中国語は簡体字に直す                 |
| `vendor/` / `models/`      | Transformers.js・ONNX Runtime・OpenCCと、Whisper baseのモデル（出所とライセンスは各フォルダーのREADME） |
| `waveform.js`              | 低いサンプリングレートでの解析、波形の描画、無音での区切り                                              |
| `recorder.js`              | マイク録音（メモリ上だけ、最長60秒）                                                                    |
| `offline.js` / `sw.js`     | オフライン準備と更新、アプリ本体のキャッシュ                                                            |
| `scripts/serve.mjs`        | 開発用の静的サーバー                                                                                    |
| `scripts/bump-shell.mjs`   | キャッシュの版を上げるリリース用スクリプト                                                              |

保存先：音声はIndexedDB（`coaching-l-audio-library`）、設定・練習区間・再生位置はlocalStorage（`kotonoha.audio.v1`、以前の版との互換のため名前はそのまま）。原文は音声ごとに `kotonoha.transcript.v1:<音声のキー>`、表示のオン・オフと文字起こしの言語・自動の設定は `kotonoha.prefs.v1` です。文字起こし用のデータは、Cache Storageの `coaching-l-audio-model:<パス>:whisper-base-q8-2` に保存します。

## 文字起こし

- `transcriber.js` が、`MODEL_FILES` のファイル（約95MB）を初回だけ受け取り、サイズとSHA-256を確かめてからCache Storageに保存します。`sw.js` は `vendor/` と `models/` への要求をその保存先から返すので、保存後は通信なしで動きます。アプリ本体のキャッシュ（`FILES`）には入れていないため、文字起こしを使わない人は受け取りません。
- 音声は16kHzのモノラルにして、28秒以内のまとまりに分けます（区切りは最後の8秒のうちいちばん静かなところ）。音のないまとまりは飛ばします（Whisperは無音に文を作ってしまうため）。
- メモリ：変換元のエンコーダーは、使わない注意の重み（`encoder_attentions.0`〜`5`、計約430MB）も出力していました。ONNX Runtimeは出力を最後まで持ち続けるため、作業用メモリ（WASM）が約730MBになり、iPhoneでページが再読み込みされました。そこで `scripts/strip-encoder-attentions.py` で出力の一覧から外しています（ノードと重みはそのまま）。さらに、`navigator.deviceMemory` が8未満か不明なとき（Safariは不明）は、まとまりごとにWorkerを作り直してメモリを手放します。
- `transcribe-worker.js` は、Transformers.jsの `automatic-speech-recognition` を `return_timestamps: true` で動かし、Whisperの区切り（セグメント）ごとの時刻を受け取ります。ONNX RuntimeはWASM・1スレッドです。WASMを動かすため、CSPの `script-src` に `'wasm-unsafe-eval'` を加えています（JavaScriptの `eval` は許可していません）。
- `transcript.js` の `transcriptFromSegments` が、区切りの中の時間を、波形の音のある部分だけで単語（中国語は1字）の長さに応じて割り振り、`transcriptFromWords` が句読点と長い無音（1秒以上）で文に分けます。同じ句がすぐくり返されるとき（中国語4字以上、英語3語以上。大文字小文字と読点は問わない）は1回ずつの文にし、8秒を超える文は0.5秒以上の間でも、12秒を超える文はいちばん長い間で分けます（中国語は句点を省いて文がつながりやすいため）。文と文の間は、近く（0.6秒以内）にある波形の無音へ寄せます。原文を直したときは `retimeSentences` が、変わっていない文の時刻を残します。
- モデルやライブラリを入れ替える手順は `vendor/README.md` にあります。

## リリース（キャッシュの版の更新）

アプリ本体は `sw.js` の `FILES` を版ごとに一式でキャッシュし、利用者の「新しいバージョンに更新する」で切り替えます。`FILES` に入っているファイルを変えたら、公開前に必ず次を実行してください。

```sh
npm run bump-shell
```

`sw.js` の `VERSION` と、`index.html`・`sw.js` のCSS／JSの `?v=` を1つ上げ、ファイルの内容のハッシュを `tests/shell-version.json` に記録します。`tests/release.spec.js` は、ファイルが変わったのに版が上がっていないと失敗します。モジュールやアイコンを足したときは `FILES` にも加えてください（入っていないとこのテストが失敗します）。

ローカルで変更が見えないときは、版を上げて更新するか、開発用ブラウザのService Workerを解除してください。

## テスト

Playwrightで実際のブラウザを動かします。テスト用の音声はローカルで作ったトーンです（教材は使いません）。

```sh
npm ci
npx playwright install chromium webkit
npm test                 # デスクトップChromium
npm run test:android     # Pixel 7設定のモバイルChromium
npm run test:safari      # デスクトップとiPhone 13設定のWebKit
npm run test:all         # すべて
```

- Linuxの `/usr/bin/chromium` があればそれを使います（CIではPlaywrightのChromium）。`CHROMIUM_PATH=/path/to/chromium npm test` で指定もできます。
- 録音のテストはChromiumの偽のマイク（`--use-fake-device-for-media-stream`）を使うため、WebKitでは対象外にしています。
- 文字起こしの画面のテスト（`tests/transcribe.spec.js`）は、Whisperの代わりに決まった単語を返す偽のWorkerを使います。モデルの受け取りと保存は本物で確かめ、`MODEL_FILES` とディスク上のファイルのサイズ・SHA-256も照合します。
- モバイル設定は画面幅・タッチ・ユーザーエージェントの模擬で、実機の確認にはなりません。

### CI（GitHub Actions）

`.github/workflows/test.yml` が、PRと `main` への変更ごとにChromium（デスクトップ・Android想定）とWebKit（デスクトップ・iPhone想定）を実行します。

WebKitのジョブは失敗してもPRを止めない設定です。Linux版WebKitでは、通信を切ったあとの読み込みでブラウザが内部エラー（`WebKit encountered an internal error`）になるため、次の11件が失敗します。iPhone実機ではオフラインで使えることを確認済みです。それ以外のWebKitの失敗は調べてください。

- `offline.spec.js` の5種類（デスクトップとiPhone設定で×2）
- `transcribe.spec.js` の本物のWhisperのテストの後半（デスクトップのみ）。通信ありの文字起こしは成功し、通信を切ったあとの2回目で、すでに読み込んだ音声ファイル（Blob）の読み直しが `NotReadableError` になります。

### クラウド環境でWebKitを入れるとき

ブラウザの配信元 `cdn.playwright.dev` と `playwright.download.prss.microsoft.com` への通信が必要です。許可されていない環境では、WebKitのテストはCIで確かめてください。

## 公開（GitHub Pages）

すべて相対パスなので、`https://<owner>.github.io/audio-loop-player/` のようなプロジェクトサイトでもそのまま動きます。リポジトリの Settings → Pages で、公開するブランチ（例：`main`）とフォルダー `/ (root)` を選びます。配信に必要なのは、`sw.js` の `FILES` にあるファイルと `sw.js`、文字起こし用の `vendor/` と `models/` です。`.mjs` はJavaScript、`.wasm` は `application/wasm` として配信されるようにしてください（GitHub Pagesはそうなっています）。

## 実機で確かめること

自動テストでは確かめられないため、変更の内容に応じて実機で確認してください。

- iPhone Safari・Android Chromeで、端末内のMP3・M4A・WAVを選んで再生できる
- 機内モードでページを開き直して再生できる
- 画面ロック中のロック画面の操作（再生・一時停止・5秒移動）
- マイクの許可と、録音・聞き比べ
- 文字起こし：初回の受け取りと保存、機内モードでの文字起こし、英語・中国語の音声での精度と所要時間、長めの音声（10分ほど）でメモリが足りるか
- ホーム画面に追加したときの起動と保存
