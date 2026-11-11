# コーチング文脈の日本語訳：候補比較

2026-11-11。公開アプリの翻訳サービスはまだ変更していない。これは品質を確認してから移行先を決めるための調査・評価用コード。

## 確認できたこと

- 現行のMyMemoryは、利用者が示した2例の不自然な訳を実APIで再現した。英語・中国語8例の応答を `mymemory-baseline-2026-11-11.json` に記録。取得成功は翻訳品質の合格を意味しない。
- 別途、英語2例・中国語2例について前の文を一緒に送る比較を行ったが、問題の部分の訳は変わらなかった。例えば `I could not put my finger on it.` は文脈を足しても「私はそれに指を入れることができませんでした」。現行APIに文章を追加するだけでは改善を確認できていない。
- Cloudflare Workers AIは公式の料金資料で、Workers Freeの場合、1日10,000 Neuronsまで無料。超過はエラーになり、それ以上の利用にはWorkers Paidへの変更が必要。無料枠はアカウント単位で、翻訳以外のWorkers AI利用とも共通。日本時間では午前9時に日次枠がリセットされる。
- Qwen3-30B-A3B-FP8とLlama-3.3-70B-Instruct-FP8-Fastを候補とする。公式料金表に記載があり、有料の支払い方法を必要とするモデルの一覧には含まれていない。単価欄があることと、Free枠内で請求されることは区別する。Paidプランへ変更せず、AI Gatewayの有料・プリペイド経路も利用しない。
- Qwen3は開発元が多言語の指示追従・翻訳を説明しているため最初の候補にするが、本アプリの例で品質が上がったとはまだ確認していない。
- DeepLの公式SDK資料にはAPI Freeの月50万文字枠、翻訳対象と別に渡す `context`（文脈文字は課金対象外）、さらに `custom_instructions` がある。日本語もカスタム指示の対象。カスタム指示がFreeのキーで利用できるかと、今回の文での改善は未確認。通常のcontext比較と、カスタム指示を加えた比較を別々に実行できる。
- Geminiの公式CookbookはアカウントとAPIキーを必要とする。今回、現行モデルごとの無料条件を確認できていないため、無料候補として確定せず、比較の実装には含めていない。

## 評価方法

`cases.json` は英語4文・中国語4文。利用者の画像にある原文2文を含む。実際の教材全文は受け取っていないため、前後の文は比較用に作成した仮の文脈であり、利用者の教材から抜粋したものではない。

参考訳と確認項目は人が評価するためのもの。モデルへの要求には送信しない。完全一致や簡単な単語置換を精度評価に使わず、次を確認する。

1. イディオムと指示対象が文脈に合うか。
2. コーチングの問いとして自然で、相手を誘導しないか。
3. 感情・動機・助言・事実を勝手に補っていないか。
4. 問いかけ・仮定・曖昧さが保たれているか。
5. 訳だけを返し、問いに回答したり解説を追加したりしていないか。

複数の訳が正解になり得る。小規模な8例の改善だけで一般的な翻訳品質を保証しない。移行前には利用者の実際の前後の文でも比較し、意味を変える誤訳が残る場合は採用しない。

## 実行

Python 3と標準ライブラリだけを使用する。既存のプロキシ・CA信頼設定を維持し、TLS検証は無効にしない。

```sh
# 通信なし。送信する内容だけを確認する。
python scripts/compare-coaching-translations.py --provider cloudflare
python scripts/compare-coaching-translations.py --provider deepl --deepl-instructions

# 実サービスへ8例を送信。自動リトライなし。最初の失敗で停止する。
python scripts/compare-coaching-translations.py --provider mymemory --live
python scripts/compare-coaching-translations.py --provider cloudflare --model qwen --live --confirmed-workers-free
python scripts/compare-coaching-translations.py --provider cloudflare --model llama --live --confirmed-workers-free
python scripts/compare-coaching-translations.py --provider deepl --live
python scripts/compare-coaching-translations.py --provider deepl --deepl-instructions --live

# 通信・課金なしのスクリプト検証。翻訳品質の検証ではない。
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p test_coaching_compare.py -v
```

結果はGit管理外の `test-results/coaching-*.json`。要求されたモデル名、日時、プロンプト・評価文のハッシュ、応答、所要時間を保存する。人の確認前は `qualityAssessment: not-reviewed`。模範訳を実モデルの出力として表示しない。APIの例外の本文・認証ヘッダー・キーは保存しない。

## 実比較に必要な設定

Cloudflareの接続設定を確認し、2026-11-11にQwen・Llamaの実比較を実施した。意味の変化や未翻訳が残ったため、今回はどちらも採用しない。詳しくは [比較結果](evaluation-2026-11-11.md) を参照。DeepLはその後の8例で改善を確認。実応答は `deepl-context-2026-11-11.json`。今回登録したDeveloperプランは1回限り100万文字であり、旧API Freeの月50万文字という説明をこの契約には適用しない。

最初はCloudflareの **Workers Free** を使う。運営者が無料アカウントを1つ用意すればよく、アプリ利用者のログインは不要。Cloudflare管理画面の **Workers AI → Use REST API → Create a Workers AI API Token** から対象アカウントに限定したトークンを作る。公式テンプレートを使う（手動指定の場合Workers AI Read・Edit）。運営者のアカウントIDも必要。

- `CONTEXT_CF_ACCOUNT_ID`：通常の環境変数。CloudflareのアカウントID。
- `CONTEXT_CF_API_TOKEN`：接続先を `api.cloudflare.com` に限定したシークレット。
- 通信先：`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`。

`--confirmed-workers-free` は運営者がFreeプランを確認したことを表すフラグで、APIによるプランの自動検証ではない。Paidプランのアカウントでは実行しない。無料枠の残量不足・サービス停止では比較を中断し、別の有料モデルへ切り替えない。

DeepLを追加比較する場合は、`CONTEXT_DEEPL_API_KEY` を `api-free.deepl.com` 宛てのシークレットとして別途用意する。キーはプロキシによって代替値になる場合があるため、末尾でプランを判定しない。接続先は `api-free.deepl.com` に固定し、Proのエンドポイントを使わない。契約内容・残量は別途確認する。

**キーをチャットやリポジトリへ貼り付けない。** 環境設定のシークレット欄で安全に登録する。

## 採用後のアプリ構成案

品質を確認できた場合に限り、静的なGitHub Pagesの画面から、運営者のWorkerへ「対象の文・教材の文脈・必要な前後の文」を送信する。音声は送らない。Workers AIのバインディングを使えばAPIトークンをブラウザへ配布する必要はない。Worker自体のFree枠も適用される。無料アカウントのまま上限時は停止し、自動課金へ切り替えない。

教材ごとの「一般／コーチング」等の文脈指定、前後の文の範囲、送信内容の説明を画面で扱う。共有エンドポイントを一般向けに公開する場合は利用上限とリクエスト制限を設ける。CORSだけでは外部からの無断利用を防げない。

訳の保存キーは「原文・文脈・前後の文・言語・モデル・プロンプト版」を含める。古いMyMemoryの訳を新しい文脈付き訳として使い回さず、取得し直す。新しく取得する際はオンラインが必要で、保存済みの訳は引き続きオフラインで表示する。

このWorkerや本番UIはまだ実装・デプロイしていない。モデルの品質、通信時間、サービスのデータ取り扱いを確認してから進める。

## 公式資料（2026-11-11閲覧）

- [Cloudflare Workers AI料金・無料枠](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers-ai/platform/pricing.mdx)
- [Cloudflare Workersの無料枠](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/pricing.mdx)
- [Workers AIのREST APIとトークン作成](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers-ai/get-started/rest-api.mdx)
- [Workers AIのChat Completions互換API](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers-ai/configuration/open-ai-compatibility.mdx)
- [Qwen3開発元](https://github.com/QwenLM/Qwen3)
- [DeepL公式SDKの無料枠・context・custom_instructions](https://github.com/DeepLcom/deepl-python)
- [DeepL公式APIスキーマ](https://github.com/DeepLcom/openapi/blob/main/openapi.yaml)
- [Gemini公式Cookbookの利用前提](https://github.com/google-gemini/cookbook)
