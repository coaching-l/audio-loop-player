// Server only. The key is a Worker secret, never sent to the browser or logged.
const PROVIDER = "deepl-context-v1";
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
    const headers = { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Cache-Control": "no-store" };
    const reply = (status, data = {}) => Response.json(data, { status, headers });
    if (new URL(request.url).pathname !== "/translate") return reply(404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type",
    } });
    if (request.method !== "POST") return reply(405);
    if (!env.DEEPL_API_KEY || !env.TRANSLATION_RATE || env.ENABLED !== "true") return reply(503);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply(415);
    // Enforce limits before calling the paid-capable upstream. Free endpoint only.
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || !(await env.TRANSLATION_RATE.limit({ key: ip })).success) return reply(429);
    const reader = request.body?.getReader();
    if (!reader) return reply(400);
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24000) { await reader.cancel(); return reply(413); }
      chunks.push(value);
    }
    let data;
    try { data = JSON.parse(await new Blob(chunks).text()); } catch { return reply(400); }
    if (!data || typeof data !== "object") return reply(400);
    const { source, language, before = "", after = "", domain } = data;
    if (!["en", "zh-CN"].includes(language) || !["general", "coaching"].includes(domain) ||
      typeof source !== "string" || !source.trim() || [...source].length > 1500 ||
      typeof before !== "string" || [...before].length > 1500 ||
      typeof after !== "string" || [...after].length > 1500) return reply(400);
    const context = `${domain === "coaching" ? "This is a coaching dialogue." : ""}\n${before}\n${after}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Authorization": `DeepL-Auth-Key ${env.DEEPL_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: [source], source_lang: language === "en" ? "EN" : "ZH", target_lang: "JA", context }),
      });
      if ([429, 456].includes(response.status)) return reply(response.status);
      if (!response.ok) return reply(502);
      const result = await response.json();
      const text = result.translations?.[0]?.text;
      if (typeof text !== "string" || !text.trim() || text.length > 10000) return reply(502);
      return reply(200, { provider: PROVIDER, translation: text });
    } catch { return reply(502); }
    finally { clearTimeout(timer); }
  },
};
