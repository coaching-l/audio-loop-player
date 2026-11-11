// MyMemory's public, keyless endpoint. No accounts, paid keys or automatic retries.
// Official free anonymous allowance: 5,000 characters/day (checked 2026-11-11).
export const TRANSLATION_PROVIDER = "mymemory-v1";
const encoder = new TextEncoder();
export const ONLINE_NOTE = "日本語翻訳機能はオンラインのときに利用できます。保存済みの訳はオフラインでも確認できます。";

// The service limits each query to 500 UTF-8 bytes, not 500 characters.
// Prefer phrase/word boundaries and never drop or split a Unicode code point.
export function translationParts(text) {
  if (encoder.encode(text).length > 5000)
    throw new Error("文が長すぎます。スクリプトを短い文に分けてから翻訳してください。");
  const parts = [];
  let rest = [...text];
  while (rest.length) {
    let bytes = 0, end = 0, boundary = 0;
    while (end < rest.length) {
      const size = encoder.encode(rest[end]).length;
      if (bytes + size > 500) break;
      bytes += size;
      if (/[\s。！？；，,;.!?]/u.test(rest[end])) boundary = end + 1;
      end++;
    }
    if (end < rest.length && boundary > end / 2) end = boundary;
    parts.push(rest.splice(0, end).join(""));
  }
  return parts;
}

export async function translateJapanese(text, language, signal) {
  if (!["en", "zh-CN"].includes(language)) throw new Error("原文の言語を選んでください。");
  if (!text.trim()) throw new Error("翻訳する文がありません。");
  if (navigator.onLine === false) throw new Error(ONLINE_NOTE);
  const result = [];
  for (const part of translationParts(text)) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const url = new URL("https://api.mymemory.translated.net/get");
      url.search = new URLSearchParams({ q: part, langpair: `${language}|ja`, mt: "1" });
      const response = await fetch(url, {
        signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      });
      if (response.status === 429) throw new Error("無料の利用上限に達しました。時間をおいてからお試しください。");
      if (!response.ok) throw new Error("翻訳サービスに接続できません。時間をおいてからお試しください。");
      const data = await response.json();
      if (data.quotaFinished || Number(data.responseStatus) === 429 ||
          /MYMEMORY WARNING|USED ALL AVAILABLE FREE|DAILY LIMIT/i.test(String(data.responseDetails) + String(data.responseData?.translatedText)))
        throw new Error("無料の利用上限に達しました。時間をおいてからお試しください。");
      const translated = data.responseData?.translatedText;
      if (Number(data.responseStatus) !== 200 || typeof translated !== "string" || !translated.trim() || translated.length > 10000)
        throw new Error("日本語訳を取得できませんでした。原文の言語を確認して、もう一度お試しください。");
      result.push(translated.trim());
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (controller.signal.aborted) throw new Error("翻訳に時間がかかっています。通信を確認し、もう一度お試しください。");
      if (error instanceof TypeError || error instanceof SyntaxError)
        throw new Error("翻訳サービスに接続できません。インターネット接続を確認して、もう一度お試しください。");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return result.join("\n");
}
