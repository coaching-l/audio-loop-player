import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/translation/worker.js";
import { contextKey, sentenceContext } from "../context-translation.js";
const env = { ALLOWED_ORIGIN: "https://tools.coaching-l.net", ENABLED: "true", DEEPL_API_KEY: "test-secret", TRANSLATION_RATE: { limit: async () => ({ success: true }) } };
const body = { source: "How does that sit with you?", language: "en", domain: "coaching", before: "A new possibility.", after: "" };
function req(data = body, origin = env.ALLOWED_ORIGIN) {
  return new Request("https://example.test/translate", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" }, body: JSON.stringify(data) });
}
test("cache identity changes with language, adjacent text and domain", () => {
  const c = sentenceContext([{ text: "before" }, { text: "target" }, { text: "after" }], 1);
  for (const variant of [{ ...c, before: "changed" }, { ...c, after: "changed" }, { ...c, domain: "general" }])
    assert.notEqual(contextKey("target", "en", c), contextKey("target", "en", variant));
  assert.notEqual(contextKey("target", "en", c), contextKey("target", "zh-CN", c));
});
test("worker fails closed before calling upstream", async () => {
  assert.equal((await worker.fetch(req(body, "https://other.test"), env)).status, 403);
  assert.equal((await worker.fetch(req(), { ...env, ENABLED: "false" })).status, 503);
  assert.equal((await worker.fetch(req(), { ...env, TRANSLATION_RATE: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal((await worker.fetch(req({ ...body, before: "a".repeat(1501) }), env)).status, 400);
  assert.equal((await worker.fetch(req({ ...body, source: "a".repeat(25000) }), env)).status, 413);
});
test("only free endpoint receives key, context is separate, errors never leak or retry", async () => {
  const original = globalThis.fetch; let count = 0;
  try {
    globalThis.fetch = async (url, options) => {
      count++;
      assert.equal(url, "https://api-free.deepl.com/v2/translate");
      assert.equal(options.redirect, "error");
      const sent = JSON.parse(options.body);
      assert.deepEqual(sent.text, [body.source]); assert.match(sent.context, /A new possibility/);
      return Response.json({ translations: [{ text: "どう受け止めていますか？" }] });
    };
    const result = await worker.fetch(req(), env);
    assert.equal(result.status, 200); assert.equal((await result.json()).translation, "どう受け止めていますか？");
    assert.equal(count, 1);
    for (const status of [456, 429, 403]) {
      globalThis.fetch = async () => { count++; return new Response("private upstream details test-secret", { status }); };
      const result = await worker.fetch(req(), env);
      assert.equal(result.status, status === 403 ? 502 : status);
      assert.equal(await result.text(), "{}");
    }
    assert.equal(count, 4);
  } finally { globalThis.fetch = original; }
});
