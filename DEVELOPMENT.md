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

| ファイル | 役割 |
| --- | --- |
| `index.html` / `style.css` | 画面と見た目。CSPは `index.html` の `<meta>` にあります |
| `app.js` | 画面の操作、保存・呼び出し、バックアップ、取り消し、ミニプレーヤー、Media Session、キー操作、録音の画面 |
| `player.js` | 再生エンジン：A–B・回数・無音・速度の段階アップ、タイマーの破棄、時刻の変換 |
| `audio-library.js` | IndexedDBへの音声保存（10件まで）、削除と取り消し、保存前の再生確認 |
| `audio-import.js` | 選んだファイルを一度だけ読み取り、MIMEを補う（iOSのファイル提供元への対策） |
| `waveform.js` | 低いサンプリングレートでの解析、波形の描画、無音での区切り |
| `recorder.js` | マイク録音（メモリ上だけ、最長60秒） |
| `offline.js` / `sw.js` | オフライン準備と更新、アプリ本体のキャッシュ |
| `scripts/serve.mjs` | 開発用の静的サーバー |
| `scripts/bump-shell.mjs` | キャッシュの版を上げるリリース用スクリプト |

保存先：音声はIndexedDB（`coaching-l-audio-library`）、設定・練習区間・再生位置はlocalStorage（`kotonoha.audio.v1`、以前の版との互換のため名前はそのまま）。

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
- モバイル設定は画面幅・タッチ・ユーザーエージェントの模擬で、実機の確認にはなりません。

### CI（GitHub Actions）

`.github/workflows/test.yml` が、PRと `main` への変更ごとにChromium（デスクトップ・Android想定）とWebKit（デスクトップ・iPhone想定）を実行します。

WebKitのジョブは失敗してもPRを止めない設定です。Linux版WebKitでは、通信を切ったあとの読み込みでブラウザが内部エラーになるため、`offline.spec.js` の5種類（×2）が失敗します。iPhone実機ではオフラインで使えることを確認済みです。それ以外のWebKitの失敗は調べてください。

### クラウド環境でWebKitを入れるとき

ブラウザの配信元 `cdn.playwright.dev` と `playwright.download.prss.microsoft.com` への通信が必要です。許可されていない環境では、WebKitのテストはCIで確かめてください。

## 公開（GitHub Pages）

すべて相対パスなので、`https://<owner>.github.io/audio-loop-player/` のようなプロジェクトサイトでもそのまま動きます。リポジトリの Settings → Pages で、公開するブランチ（例：`main`）とフォルダー `/ (root)` を選びます。配信に必要なのは、`sw.js` の `FILES` にあるファイルと `sw.js` です。

## 実機で確かめること

自動テストでは確かめられないため、変更の内容に応じて実機で確認してください。

- iPhone Safari・Android Chromeで、端末内のMP3・M4A・WAVを選んで再生できる
- 機内モードでページを開き直して再生できる
- 画面ロック中のロック画面の操作（再生・一時停止・5秒移動）
- マイクの許可と、録音・聞き比べ
- ホーム画面に追加したときの起動と保存
