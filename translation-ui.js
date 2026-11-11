import { CONTEXT_TRANSLATION_URL } from "./translation-config.js";
import { CONTEXT_PROVIDER, sentenceContext, contextKey, translateContext } from "./context-translation.js";
import { translateJapanese, TRANSLATION_PROVIDER } from "./translation.js";

// Keep translation gestures separate from sentence playback and scrolling.
export function setupTranslation({ context, save }) {
  const $ = (id) => document.getElementById(id);
  const list = $("transcript-sentences");
  const dialog = $("translation-dialog");
  const language = $("translation-language");
  const domain = $("translation-domain");
  $("translation-domain-field").hidden = !CONTEXT_TRANSLATION_URL;
  if (CONTEXT_TRANSLATION_URL) {
    for (const note of document.querySelectorAll(".translation-service-note"))
      note.textContent = "翻訳する文と前後各1文・文脈の指定を、Cloudflareを経由してDeepLへ送信します。個人情報や機密情報を含む文は翻訳しないでください。翻訳には誤りが含まれる場合があります。";
    $("translation-provider-note").textContent = "翻訳：DeepL（運営者の無料クレジットの範囲内。上限に達すると新しい翻訳は停止します）";
  }
  const status = $("translation-status");
  const output = $("translation-result");
  const retry = $("translation-retry");
  let active = null, request = null, press = null, suppress = null;
  function cancelPress() {
    clearTimeout(press?.timer);
    press = null;
  }
  function cancelRequest() {
    request?.abort();
    request = null;
  }
  function close() {
    cancelPress();
    cancelRequest();
    active = null;
    if (dialog.open) dialog.close();
  }
  function sync() {
    cancelPress();
    const now = context();
    if (active && (!now || now.key !== active.key || now.transcript.text !== active.script)) close();
  }
  async function translate() {
    cancelRequest();
    const target = active;
    if (!target) return;
    const sourceLanguage = language.value;
    $("translation-original").lang = sourceLanguage;
    output.textContent = "";
    retry.hidden = true;
    const now = context();
    const saved = Array.isArray(now?.transcript.translations) ? now.transcript.translations : [];
    const translationContext = { ...target.context, domain: domain.value };
    const cacheKey = contextKey(target.source, sourceLanguage, translationContext);
    const provider = CONTEXT_TRANSLATION_URL ? CONTEXT_PROVIDER : TRANSLATION_PROVIDER;
    const cached = saved.find((item) => item?.provider === provider && (!CONTEXT_TRANSLATION_URL || item.contextKey === cacheKey) &&
      item.source === target.source && item.language === sourceLanguage && typeof item.text === "string" && item.text);
    if (cached) {
      output.textContent = cached.text;
      status.textContent = "保存済みの日本語訳";
      return;
    }
    const controller = new AbortController();
    request = controller;
    status.textContent = "日本語に翻訳しています…";
    try {
      const text = CONTEXT_TRANSLATION_URL
        ? await translateContext(CONTEXT_TRANSLATION_URL, target.source, sourceLanguage, translationContext, controller.signal)
        : await translateJapanese(target.source, sourceLanguage, controller.signal);
      if (controller.signal.aborted || request !== controller || active !== target) return;
      const current = context();
      if (!current || current.key !== target.key || current.transcript.text !== target.script) return;
      output.textContent = text;
      const entries = Array.isArray(current.transcript.translations) ? current.transcript.translations : [];
      current.transcript.translations = [...entries.filter((entry) =>
        entry?.source !== target.source || entry?.language !== sourceLanguage), {
        provider, contextKey: cacheKey, source: target.source, language: sourceLanguage, text,
      }].slice(-200);
      const persisted = save(current.key, current.transcript);
      status.textContent = persisted ? "この端末に日本語訳を保存しました。" : "日本語訳を表示しましたが、端末に保存できませんでした。";
    } catch (error) {
      if (controller.signal.aborted || request !== controller || active !== target) return;
      status.textContent = error.message;
      retry.hidden = false;
    } finally {
      if (request === controller) request = null;
    }
  }
  function open(button) {
    const now = context();
    const sentence = now?.transcript.sentences[Number(button?.dataset.index)];
    if (!sentence) return;
    cancelRequest();
    active = { key: now.key, script: now.transcript.text, source: sentence.text, context: sentenceContext(now.transcript.sentences, Number(button.dataset.index)) };
    domain.value = now.transcript.translationDomain || "coaching";
    language.value = list.lang === "zh-CN" ? "zh-CN" : "en";
    $("translation-original").textContent = sentence.text;
    if (!dialog.open) dialog.showModal();
    void translate();
  }
  list.addEventListener("pointerdown", (event) => {
    cancelPress();
    if (!event.isPrimary || event.button !== 0) return;
    const button = event.target.closest(".sentence");
    if (!button) return;
    const item = { button, x: event.clientX, y: event.clientY, id: event.pointerId };
    press = item;
    item.timer = setTimeout(() => {
      if (press !== item) return;
      suppress = { button, until: performance.now() + 1500 };
      cancelPress();
      open(button);
    }, 550);
  });
  list.addEventListener("pointermove", (event) => {
    if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancelPress();
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave", "scroll"])
    list.addEventListener(name, cancelPress);
  list.addEventListener("click", (event) => {
    if (suppress?.button === event.target.closest(".sentence") && performance.now() < suppress.until) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppress = null;
  }, true);
  list.addEventListener("contextmenu", (event) => {
    const button = event.target.closest(".sentence");
    if (!button) return;
    event.preventDefault();
    cancelPress();
    suppress = { button, until: performance.now() + 1500 };
    if (!dialog.open) open(button);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      open(event.target.closest(".sentence"));
    }
  });
  $("transcript-translate").addEventListener("click", () =>
    open(list.querySelector(".is-selected") || list.querySelector(".is-current") || list.querySelector(".sentence")));
  $("translation-close").addEventListener("click", close);
  dialog.addEventListener("cancel", close);
  dialog.addEventListener("close", () => { if (!dialog.open) { cancelRequest(); active = null; } });
  language.addEventListener("change", () => void translate());
  domain.addEventListener("change", () => {
    const now = context();
    if (now) { now.transcript.translationDomain = domain.value; save(now.key, now.transcript); }
    void translate();
  });
  retry.addEventListener("click", () => void translate());
  document.addEventListener("visibilitychange", () => { if (document.hidden) close(); });
  return { sync };
}
