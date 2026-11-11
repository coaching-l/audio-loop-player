import { translateJapanese, TRANSLATION_PROVIDER } from "./translation.js";

// Keep translation gestures separate from sentence playback and scrolling.
export function setupTranslation({ context, save }) {
  const $ = (id) => document.getElementById(id);
  const list = $("transcript-sentences");
  const dialog = $("translation-dialog");
  const language = $("translation-language");
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
    const cached = saved.find((item) => item?.provider === TRANSLATION_PROVIDER &&
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
      const text = await translateJapanese(target.source, sourceLanguage, controller.signal);
      if (controller.signal.aborted || request !== controller || active !== target) return;
      const current = context();
      if (!current || current.key !== target.key || current.transcript.text !== target.script) return;
      output.textContent = text;
      const entries = Array.isArray(current.transcript.translations) ? current.transcript.translations : [];
      current.transcript.translations = [...entries.filter((entry) =>
        entry?.source !== target.source || entry?.language !== sourceLanguage), {
        provider: TRANSLATION_PROVIDER, source: target.source, language: sourceLanguage, text,
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
    active = { key: now.key, script: now.transcript.text, source: sentence.text };
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
  retry.addEventListener("click", () => void translate());
  document.addEventListener("visibilitychange", () => { if (document.hidden) close(); });
  return { sync };
}
