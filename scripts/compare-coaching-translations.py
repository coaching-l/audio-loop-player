#!/usr/bin/env python3
"""Offline request preview / explicit live comparison. Never part of app or CI.

Uses Python's standard TLS trust and environment proxy configuration. API secrets
are read from the environment, never included in command arguments or reports.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "research/coaching-translation"
MODELS = {
    "qwen": "@cf/qwen/qwen3-30b-a3b-fp8",
    "llama": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
}


def payload(case, provider, prompt, model="qwen", deepl_instructions=False):
    if provider == "cloudflare":
        source = {key: case[key] for key in ("language", "domain", "target", "before", "after")}
        return {"model": MODELS[model], "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps(source, ensure_ascii=False)},
        ], "temperature": 0, "max_tokens": 512, "stream": False}
    if provider == "deepl":
        body = {
            "text": [case["target"]], "source_lang": "EN" if case["language"] == "en" else "ZH",
            "target_lang": "JA",
            "context": f'This is a {case["domain"]} dialogue.\n{case["before"]}\n{case["after"]}',
        }
        if deepl_instructions:
            body["custom_instructions"] = [
                "Translate idioms into natural spoken Japanese appropriate for a coaching dialogue.",
                "Preserve open, non-leading questions. Do not add emotions, motives, advice or facts not supported by the source and context.",
                "Translate only the target sentence, without answering it or adding an explanation.",
            ]
        return body
    return {"q": case["target"], "langpair": case["language"] + "|ja", "mt": "1"}


def configuration(args):
    if args.provider == "cloudflare":
        if not args.confirmed_workers_free:
            raise ValueError("Workers Freeプランであることを確認し、--confirmed-workers-free を付けてください。プランは自動判定できません。Paidプランでは使用しないでください。")
        account = os.environ.get("CONTEXT_CF_ACCOUNT_ID", "")
        key = os.environ.get("CONTEXT_CF_API_TOKEN", "")
        if not re.fullmatch(r"[a-fA-F0-9]{32}", account) or not key:
            raise ValueError("CONTEXT_CF_ACCOUNT_ID と CONTEXT_CF_API_TOKEN を安全な環境設定で指定してください。")
        return f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions", {"Authorization": "Bearer " + key}
    if args.provider == "deepl":
        key = os.environ.get("CONTEXT_DEEPL_API_KEY", "")
        if not key:
            raise ValueError("DeepLの無料プランのキーを CONTEXT_DEEPL_API_KEY に設定してください。接続先は無料用APIに固定します。")
        return "https://api-free.deepl.com/v2/translate", {"Authorization": "DeepL-Auth-Key " + key}
    return "https://api.mymemory.translated.net/get", {}


def read_translation(provider, data):
    if provider == "mymemory":
        if data.get("quotaFinished") or int(data.get("responseStatus", 0)) != 200:
            raise ValueError("MyMemoryの利用上限またはAPIエラー。追加要求を停止します。")
        value = data["responseData"]["translatedText"]
    elif provider == "deepl":
        value = data["translations"][0]["text"]
    else:
        choice = data["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise ValueError("生成が正常終了していません。途中の訳を評価しません。")
        # Do not silently strip reasoning or prose and call an invalid response a pass.
        content = json.loads(choice["message"]["content"])
        if set(content) != {"translation"}:
            raise ValueError("翻訳だけを返す出力形式に従っていません。")
        value = content["translation"]
    if not isinstance(value, str) or not value.strip():
        raise ValueError("日本語訳が空です。")
    return value.strip()


def request(endpoint, headers, body, provider):
    if provider == "mymemory":
        if len(body["q"].encode("utf-8")) > 500:
            raise ValueError("評価文がMyMemoryの500バイト制限を超えています。")
        req = urllib.request.Request(endpoint + "?" + urllib.parse.urlencode(body))
    else:
        req = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={**headers, "Content-Type": "application/json"}, method="POST")
    # Do not follow redirects carrying API credentials to a different endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=45) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("API応答が上限を超えています。")
        return read_translation(provider, json.loads(raw))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["mymemory", "cloudflare", "deepl"], required=True)
    parser.add_argument("--model", choices=MODELS, default="qwen")
    parser.add_argument("--live", action="store_true", help="Explicitly send the eight evaluation samples; otherwise offline preview only.")
    parser.add_argument("--confirmed-workers-free", action="store_true")
    parser.add_argument("--deepl-instructions", action="store_true", help="Test custom_instructions on the Free endpoint; availability is not yet verified.")
    args = parser.parse_args()
    cases = json.loads((DATA / "cases.json").read_text())
    prompt = (DATA / "prompt.txt").read_text()
    if not args.live:
        print(json.dumps({"mode": "offline-preview", "provider": args.provider,
                          "requests": [{"id": c["id"], "body": payload(c, args.provider, prompt, args.model, args.deepl_instructions)} for c in cases]}, ensure_ascii=False, indent=2))
        return 0
    try:
        endpoint, headers = configuration(args)
    except ValueError as error:
        print(str(error))
        return 2
    report = {"provider": args.provider, "model": MODELS[args.model] if args.provider == "cloudflare" else None,
              "promptSha256": hashlib.sha256(prompt.encode()).hexdigest(),
              "casesSha256": hashlib.sha256((DATA / "cases.json").read_bytes()).hexdigest(),
              "evaluatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "qualityAssessment": "not-reviewed", "results": []}
    report["deeplCustomInstructions"] = args.provider == "deepl" and args.deepl_instructions
    directory = ROOT / "test-results"
    directory.mkdir(exist_ok=True)
    path = directory / f"coaching-{args.provider}-{time.time_ns()}.json"
    failed = False
    for case in cases:
        row = {"id": case["id"], "source": case["target"], "reference": case["reference"], "checks": case["checks"]}
        start = time.monotonic()
        try:
            row["translation"] = request(endpoint, headers, payload(case, args.provider, prompt, args.model, args.deepl_instructions), args.provider)
            row["status"] = "received-not-graded"
        except urllib.error.HTTPError as error:
            row.update(status="failed", error=f"HTTP {error.code}; no automatic retry or paid fallback")
            failed = True
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as error:
            # Do not write raw remote error bodies, URLs, keys, or headers to reports.
            row.update(status="failed", error=type(error).__name__)
            failed = True
        row["elapsedSeconds"] = round(time.monotonic() - start, 2)
        report["results"].append(row)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(case["id"], row["status"], flush=True)
        if failed:
            break
    print(path)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
