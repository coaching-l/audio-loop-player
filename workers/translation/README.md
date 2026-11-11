# 文脈付きDeepL翻訳

英語・中国語8例の実API比較で改善を確認。実応答は `research/coaching-translation/deepl-context-2026-11-11.json`。仮の前後文を用いた小規模評価で、精度保証ではない。「具体的に」の重複や「理想」の補足などは残る。

今回のアカウントはDeveloperの1回限り100万文字クレジット。利用量APIで上限1,000,000、比較前0、比較後242文字を確認。月50万文字が補充される旧API Freeとして案内しない。期限と使い切った後の契約条件はアカウント画面で確認する。無料クレジットを使い切ったら翻訳を停止し、有料契約へ変更しない。

## 配置

1. Workers FreeのCloudflareアカウントで、このディレクトリの `wrangler.jsonc` を使い `npx wrangler deploy`。初期状態は `ENABLED=false`。
2. Cloudflareの当該Workerの設定で、シークレット `DEEPL_API_KEY` にDeepLキーを登録する。開発環境のHTTPシークレットは自動ではWorkerへ移らない。キーをGitHub・ブラウザ資産・チャットへ記載しない。
3. レート制限バインディング `TRANSLATION_RATE` が10要求/60秒で配置されていることを確認。これはIP・Cloudflare拠点単位であり、認証やアカウント全体の課金制限ではない。CORSも認証ではない。DeepL側の無料契約の上限が総消費の上限となる。無料クレジット後に有料へ自動移行する契約では有効化しない。
4. `ENABLED=true` に変更し、公開元から `/translate` の正常応答と上限時の停止を確認する。
5. ルートの `translation-config.js` の `CONTEXT_TRANSLATION_URL` に正確なWorkerのHTTPS URL（末尾 `/translate`）を設定。`index.html` のCSP `connect-src` にそのホストだけを追加する。`npm run bump-shell` と翻訳・リリーステストの後にアプリを公開する。

未設定時は従来のMyMemoryを使う。有効化後の失敗時にMyMemoryや有料APIへ自動で切り替えない。Workerは有効化済み。DeepLキー登録・公開接続URL設定・英語中国語の実接続を確認済み。

## 動作とデータ

送信は利用者が翻訳を開いた時だけ。選んだ文と前後各1文（各最大1500文字）、言語、一般／コーチングの指定をCloudflare経由でDeepLへ送る。音声・教材全文は送らない。DeepLの `context` を利用し、追加のカスタム指示は今回未検証のため使わない。

サービスのデータ取り扱いはDeepLの契約に従う。独自の本文ログや共有翻訳キャッシュは作らない。Worker観測ログは設定上無効。APIキーはWorker内に保持し、エラー本文・認証情報を利用者へ返さない。Cookieは利用しない。プライバシー説明は有効化後の翻訳画面に表示する。

端末の訳キャッシュは原文・前後文・文脈・言語・プロバイダー版を含めて一致を判定する。古いMyMemory訳をDeepL訳として再利用しない。端末に保存済みの訳はオフラインでも利用できる。教材切り替え・ダイアログ閉鎖時は通信を中止し、古い応答を保存しない。

検証：`node --test tests/context-translation.node.mjs`、`npx playwright test tests/translation.spec.js tests/release.spec.js --project=chromium`。実APIで精度を評価した結果と、モックによる実装テストは区別する。

## 検証・配置状況（2026-11-11）

Workerは `https://coaching-l-translation.hitch1126.workers.dev/translate` で有効。キーを保持したまま更新し、公開URLから英語・中国語の実翻訳を確認した。証拠は `validation/deepl-worker-2026-11-11.json`。残量消費を抑えるため、公開Workerの実翻訳確認は各言語1例とした。

Workersのfetchはredirect:errorを受け付けないため、redirect:manualで3xxをエラーとして扱い、キーを別ホストへ転送しない。公開エラーは固定コードとHTTPステータスのみで、APIの本文・秘密値を含めない。前後の空白を除去してキーを使う。

Nodeのサーバー検証と、PC・Android想定のChromiumで翻訳・オフライン再表示・更新ファイルの整合性を検証。ブラウザテストのAPI応答はモック、公開Workerの実接続はcurlで別途確認。Safari・Android実機は今回未確認。wrangler設定のENABLED=falseは、再配置時に明示的な有効化を要求するための既定値。
