export const CONTEXT_PROVIDER = "deepl-context-v1";
export function sentenceContext(sentences, index, domain = "coaching") {
  const clip = (text) => [...String(text || "")].slice(0, 1500).join("");
  return { domain, before: clip(sentences[index - 1]?.text), after: clip(sentences[index + 1]?.text) };
}
export function contextKey(source, language, context) {
  return JSON.stringify([CONTEXT_PROVIDER, source, language, context.domain, context.before, context.after]);
}
export async function translateContext(endpoint, source, language, context, signal) {
  if (navigator.onLine === false) throw new Error("日本語翻訳機能はオンラインのときに利用できます。保存済みの訳はオフラインでも確認できます。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, language, ...context }),
      signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (response.status === 429 || response.status === 456)
      throw new Error("翻訳の利用上限に達しました。保存済みの訳は引き続き確認できます。");
    if (!response.ok) throw new Error("翻訳サービスに接続できません。時間をおいてからお試しください。");
    const result = await response.json();
    if (result.provider !== CONTEXT_PROVIDER || typeof result.translation !== "string" || !result.translation.trim() || result.translation.length > 10000)
      throw new Error("日本語訳を取得できませんでした。");
    return result.translation;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (controller.signal.aborted) throw new Error("翻訳に時間がかかっています。もう一度お試しください。");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
