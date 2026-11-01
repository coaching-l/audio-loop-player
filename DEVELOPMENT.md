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
| `app.js`                   | 最初の画面：2つの入口の切り替え、「音源から始める」（追加・ドラッグ＆ドロップ）、「保存した教材」の一覧（空のうちは隠す）・削除と取り消し、保存容量が残り少ないときの知らせ |
| `text-entry.js`            | 入口「テキストから始める」：言語・声・テキスト、音声づくりの進み具合と中止、止まった文の表示、作った音声とスクリプトを練習画面へ |
| `tts.js`                   | 音声づくり：Workerの管理（3分進まなければ中止）、出力の確認、文ごとの音声の保存（IndexedDB、今のテキストの分だけ）、20分の確認、途中で止まったことの記録 |
| `tts-worker.js`            | Workerの中でKokoroを動かし、1文を24kHzの音声にする                                                      |
| `voices.js`                | 声とモデルの一覧（版を固定）                                                                            |
| `english.js` / `mandarin.js` | 英語（kokoro-jsの正規化＋eSpeak NG）と中国語（pinyin-pro＋Kokoro v1.1の記号）の読み                   |
| `audio-tools.js`           | WAVの作成（MP3にできなかったときの予備）、音声の連結、20分の確認、文のあとの無音の長さ、音声の読み込み                                 |
| `export.js` / `mp3-worker.js` | MP3の書き出し（全体・A–B・N文ごとのZIP・無音入り）                                                   |
| `model-files.js`           | このサイトのファイルを、初めて使うときにサイズとSHA-256を確かめて保存する（文字起こしと音声づくりで共通） |
| `practice.js`              | 練習画面（どの入口からも共通。音声を開くまでは隠す）：再生・A–B・速度・スクリプト（文字起こしと文の時刻の直しを含む）・詳しい設定（録音して聞き比べを含む）・ミニプレーヤー・Media Session・キー操作 |
| `ui.js`                    | 入口と練習画面で共通のお知らせ・エラー表示と「元に戻す」                                                |
| `player.js`                | 再生エンジン：A–B・回数・無音、タイマーの破棄、時刻の変換                                               |
| `audio-library.js`         | IndexedDBへの音声保存（10件まで）、削除と取り消し、保存前の再生確認                                     |
| `audio-import.js`          | 選んだファイルを一度だけ読み取り、MIMEを補う（iOSのファイル提供元への対策）                             |
| `transcript.js`            | スクリプトの文への区切り（英語・中国語）、波形の無音を使った時刻の対応づけ、文字コードの判別                  |
| `transcriber.js`           | 文字起こしの準備：モデルの受け取りと確認・保存（Cache Storage）、16kHzへの変換、無音での分割            |
| `transcribe-worker.js`     | Workerの中でWhisperを動かし、区切り（セグメント）ごとの時刻を返す。中国語は簡体字に直す                 |
| `vendor/` / `models/`      | Transformers.js・ONNX Runtime・OpenCC・phonemizer・pinyin-pro・lamejs・fflateと、Whisper baseのモデル（出所とライセンスは `vendor/README.md`） |
| `waveform.js`              | 低いサンプリングレートでの解析、波形の描画、無音での区切り                                              |
| `recorder.js`              | マイク録音（メモリ上だけ、最長60秒）                                                                    |
| `offline.js` / `sw.js`     | オフライン準備と更新、アプリ本体のキャッシュ                                                            |
| `scripts/serve.mjs`        | 開発用の静的サーバー                                                                                    |
| `scripts/bump-shell.mjs`   | キャッシュの版を上げるリリース用スクリプト                                                              |

保存先：音声はIndexedDB（`coaching-l-audio-library`）、設定と再生位置はlocalStorage（`kotonoha.audio.v1`、以前の版との互換のため名前はそのまま）。スクリプトは素材ごとに `kotonoha.transcript.v1:<素材のキー>`、文字起こしの言語は `kotonoha.prefs.v1`、選んだ入口は `kotonoha.entry.v1`、「テキストから始める」の入力中のテキスト・声・前回作った音声のキーは `kotonoha.textdraft.v1` です。テキストから作った音声も、音源と同じIndexedDBに保存します。文ごとの音声は `coaching-l-tts-clips`（IndexedDB）に、今のテキストの分だけ16ビットで置きます。以前の版が保存した練習区間（`segments`）は、画面では使いませんが、保存したまま残します。練習のしかたは設定の `practice`（`shadowing` か `repeating`）で、無音の長さ（`gap`・`gapRatio`）はシャドーイングの間も選んだまま保存し、プレーヤーにはリピーティングのときだけ渡します。`practice` のない以前の設定は、無音があるか「文ごとに止める」（`sentencePause`）がONなら `repeating` として開きます。無音を選んでいない設定は、リピーティングにすると文（区間）の1.5倍になります。「音声全体」のくり返しと速度の段階アップの設定は、区間リピートOFF・元の速度として開きます。

## テキストからの音声づくり

COACHING-L シャドーイング（`coaching-l/shadowing`）の音声化機能を移植しました。英語は Kokoro-82M v1.0 の q8、中国語は Kokoro-82M v1.1-zh の fp32（q8はブラウザでNaNになるため、移植元の判断どおり）。

- 実行は `tts-worker.js`。Transformers.js と ONNX Runtime（WASM・1スレッド）は文字起こしと同じ `vendor/` のものです。kokoro-js は使わず、英語の読み（正規化と eSpeak NG）を `english.js` に移しました（kokoro-js と同じ結果になることを確認）。512トークンの上限は、kokoro-js の内部に頼らず自分で数えます。phonemizer はデータを `for await` で `ReadableStream` から取り出しますが、古いSafari（CIのWebKitを含む）はこれに対応しておらず、エラーも出さずに止まり続けていました。`stream-iterator.js` がその機能を補います（phonemizer より先に読み込む）。
- モデルと声のデータだけは Hugging Face から受け取ります（中国語のモデルは339MBで、GitHubに置ける1ファイル100MBを超えるため）。`voices.js` で版（コミット）を固定し、文ごとの音声のキーにも版を入れています。Transformers.js が Cache Storage（`transformers-cache`）に、声は `coaching-l-tts-voices` に保存するので、2回目からは通信なしで作れます。テキストは送りません。Workerにはページの CSP がかからないため、CSP は変えていません。
- Workerが使うこのサイトのファイル（Transformers.js・ONNX Runtime・phonemizer・pinyin-pro）は、`tts.js` の `RUNTIME_FILES` にサイズとSHA-256があり、初めて作るときに `model-files.js` が確かめて保存します。文字起こしで保存済みのファイルは写して使います。
- 移植元の確認で挙がった点への対応：3分の制限はモデルの受け取りが進むたびに数え直す。古い版の文の音声は残さない（今のテキストの文だけ残す）。20分の確認は1か所（`audio-tools.js`）で、作った音声・書き出す音声の実際の長さで行う。第三声の変調は、pinyin-pro が2音節の語の中で変えたものには重ねてかからない（`tests/text-entry.spec.js` で確認）。
- 文の区切りはスクリプトと同じ `transcript.js` の `splitSentences` なので、練習画面でスクリプトを直しても、直していない文の時刻は残ります。
- 作った音声は、MP3（モノラル・24kHz・64kbps、1分で約0.5MB）にして保存します（WAVでは1分で約2.9MB）。MP3は書き出しと同じ `mp3-worker.js`（lamejs）で作ります。MP3の再生は、元の音より1,105サンプル（エンコーダー576＋デコーダー529、24kHzで約46ミリ秒）遅れて始まります。lamejsはこれを飛ばすための情報を書かないため、文の時刻をその分うしろへずらします（`export.js` の `MP3_DELAY_SAMPLES`）。MP3にできなかったときは、同じ音声をWAVで保存します。`mp3-worker.js` は読み込めたら最初に知らせ、10秒たっても知らせがないとき（モジュールのWorkerは、読み込めなくてもエラーにならないことがある）は、MP3にできなかったとみなします。
- 生成の速さ（読み上げ速度）は1.0に固定しました。練習画面の再生速度で変えられるためです。試聴はありません（1文目から作られるので、それで確かめます）。

## 練習画面と入口

練習画面（`practice.js`）は、素材の出どころを知りません。入口は素材を用意して、次を呼ぶだけです。

```js
import { openPractice } from "./practice.js";
openPractice({
  file,             // 音声（File、またはBlob）。必須
  key,              // 設定とスクリプトの保存先。省略すると音声のファイル名・サイズ・更新日時
  name,             // プレーヤーに出す名前。省略するとファイル名
  script: {         // 素材についているスクリプト（省略可）
    text,           // 全文
    sentences,      // [{ text, start, end }]（秒）。省略すると貼り付けと同じく波形の無音から推し量る
  },
});
```

`script` は、その `key` にスクリプトがまだ保存されていないときだけ使います。利用者が直したスクリプトは上書きしません。「音源から始める」（`app.js`）は `file` だけを、「テキストから始める」（`text-entry.js`）は作ったMP3と、文ごとの時刻つきのスクリプトを渡します。文字起こし用のデータは、Cache Storageの `coaching-l-audio-model:<パス>:whisper-base-q8-2` に保存します。

## 文字起こし

- `transcriber.js` が、`MODEL_FILES` のファイル（約95MB）を初回だけ受け取り、サイズとSHA-256を確かめてからCache Storageに保存します。`sw.js` は `vendor/` と `models/` への要求をその保存先から返すので、保存後は通信なしで動きます。アプリ本体のキャッシュ（`FILES`）には入れていないため、文字起こしを使わない人は受け取りません。
- 音声は16kHzのモノラルにして、28秒以内のまとまりに分けます（区切りは最後の8秒のうちいちばん静かなところ）。音のないまとまりは飛ばします（Whisperは無音に文を作ってしまうため）。
- メモリ：変換元のエンコーダーは、使わない注意の重み（`encoder_attentions.0`〜`5`、計約430MB）も出力していました。ONNX Runtimeは出力を最後まで持ち続けるため、作業用メモリ（WASM）が約730MBになり、iPhoneでページが再読み込みされました。そこで `scripts/strip-encoder-attentions.py` で出力の一覧から外しています（ノードと重みはそのまま）。さらに、`navigator.deviceMemory` が8未満か不明なとき（Safariは不明）は、まとまりごとにWorkerを作り直してメモリを手放します。
- `transcribe-worker.js` は、Transformers.jsの `automatic-speech-recognition` を `return_timestamps: true` で動かし、Whisperの区切り（セグメント）ごとの時刻を受け取ります。ONNX RuntimeはWASM・1スレッドです。WASMを動かすため、CSPの `script-src` に `'wasm-unsafe-eval'` を加えています（JavaScriptの `eval` は許可していません）。
- `transcript.js` の `transcriptFromSegments` が、区切りの中の時間を、波形の音のある部分だけで単語（中国語は1字）の長さに応じて割り振り、`transcriptFromWords` が句読点と長い無音（1秒以上）で文に分けます。同じ句がすぐくり返されるとき（中国語4字以上、英語3語以上。大文字小文字と読点は問わない）は1回ずつの文にし、8秒を超える文は0.5秒以上の間でも、12秒を超える文はいちばん長い間で分けます（中国語は句点を省いて文がつながりやすいため）。文と文の間は、近く（0.6秒以内）にある波形の無音へ寄せます。スクリプトを直したときは `retimeSentences` が、変わっていない文の時刻を残します。
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
- テキストからの音声づくりのテスト（`tests/text-entry.spec.js`）は、Kokoroの代わりに文の長さの音を返す偽のWorker（`tests/fixtures/fake-tts-worker.js`）を使います。本物のWorkerとその読み（英語・中国語）がブラウザで読み込めること、`RUNTIME_FILES` とディスク上のファイルの一致も確かめます。本物のモデルでの音声づくりは、モデルの取得が必要なため自動テストに入れていません。
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
- マイクの許可と、録音・聞き比べ（「詳しい設定」の中）
- 文字起こし：初回の受け取りと保存、機内モードでの文字起こし、英語・中国語の音声での精度と所要時間、長めの音声（10分ほど）でメモリが足りるか
- ホーム画面に追加したときの起動と保存
