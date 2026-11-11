"""Checks for the research harness, not translation-quality tests."""
import argparse
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("compare_coaching", ROOT / "scripts/compare-coaching-translations.py")
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class ComparisonHarnessTests(unittest.TestCase):
    def setUp(self):
        self.cases = json.loads((compare.DATA / "cases.json").read_text())
        self.prompt = (compare.DATA / "prompt.txt").read_text()

    def test_references_are_never_sent_to_the_model(self):
        for case in self.cases:
            marked = {**case, "reference": "DO_NOT_SEND_THIS_REFERENCE", "checks": ["DO_NOT_SEND_THE_RUBRIC"]}
            for provider in ["cloudflare", "deepl", "mymemory"]:
                body = json.dumps(compare.payload(marked, provider, self.prompt), ensure_ascii=False)
                self.assertNotIn("DO_NOT_SEND", body)
                self.assertIn(case["target"], body if provider != "cloudflare" else json.loads(body)["messages"][1]["content"])

    def test_cloudflare_requires_explicit_free_plan_and_credentials(self):
        args = argparse.Namespace(provider="cloudflare", confirmed_workers_free=False)
        with patch.dict(compare.os.environ, {}, clear=True):
            with self.assertRaises(ValueError): compare.configuration(args)
            args.confirmed_workers_free = True
            with self.assertRaises(ValueError): compare.configuration(args)
        with patch.dict(compare.os.environ, {"CONTEXT_CF_ACCOUNT_ID": "a" * 32, "CONTEXT_CF_API_TOKEN": "test-placeholder"}, clear=True):
            url, headers = compare.configuration(args)
            self.assertTrue(url.startswith("https://api.cloudflare.com/client/v4/accounts/"))
            self.assertNotIn("test-placeholder", url)
            self.assertEqual(headers["Authorization"], "Bearer test-placeholder")

    def test_deepl_requires_key_and_always_uses_free_endpoint(self):
        args = argparse.Namespace(provider="deepl")
        with patch.dict(compare.os.environ, {"CONTEXT_DEEPL_API_KEY": ""}, clear=True):
            with self.assertRaises(ValueError): compare.configuration(args)
        with patch.dict(compare.os.environ, {"CONTEXT_DEEPL_API_KEY": "opaque-proxy-placeholder"}, clear=True):
            self.assertEqual(compare.configuration(args)[0], "https://api-free.deepl.com/v2/translate")

    def test_generation_must_be_complete_and_follow_the_output_contract(self):
        good = {"choices": [{"finish_reason": "stop", "message": {"content": '{"translation":"今、そのことをどう受け止めていますか？"}'}}]}
        self.assertIn("受け止め", compare.read_translation("cloudflare", good))
        for finish, content in [("length", '{"translation":"途中"}'), ("stop", 'Reasoning: {"translation":"訳"}'), ("stop", '{"translation":""}'), ("stop", '{"translation":"訳","explanation":"余分"}')]:
            with self.assertRaises(ValueError):
                compare.read_translation("cloudflare", {"choices": [{"finish_reason": finish, "message": {"content": content}}]})

    def test_quota_failure_is_not_a_translation(self):
        with self.assertRaises(ValueError):
            compare.read_translation("mymemory", {"responseStatus": 200, "quotaFinished": True, "responseData": {"translatedText": "quota warning"}})

    def test_corpus_contains_both_languages_and_matches_service_size_limit(self):
        self.assertEqual(len({c["id"] for c in self.cases}), 8)
        self.assertEqual({c["language"] for c in self.cases}, {"en", "zh-CN"})
        for case in self.cases:
            self.assertLessEqual(len(case["target"].encode("utf-8")), 500)


if __name__ == "__main__":
    unittest.main()
