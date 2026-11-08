import { VOICES, PREVIEW_TEXT } from "./voices.js";

// Only static MP3s are played here. Never start TTS or change the selected voice/draft.
export function initVoicePreviews() {
  const details = document.getElementById("voice-previews");
  const list = document.getElementById("voice-preview-list");
  const status = document.getElementById("voice-preview-status");
  const language = document.getElementById("tts-lang");
  const audio = document.getElementById("voice-preview-audio");
  let active = null;
  let generation = 0;

  function resetButtons() {
    for (const button of list.querySelectorAll("button")) {
      const voice = VOICES.find((v) => v.id === button.dataset.voice);
      const playing = active === voice.id;
      button.textContent = playing ? "■ 停止" : "▶ 試聴";
      button.setAttribute("aria-label", voice.name + (playing ? "の試聴を停止" : "を試聴"));
      button.setAttribute("aria-pressed", String(playing));
    }
  }
  function stop() {
    generation++;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    active = null;
    status.textContent = "";
    resetButtons();
  }
  async function play(voice) {
    const wasActive = active === voice.id;
    stop();
    if (wasActive) return;
    if (!window.dispatchEvent(new Event("voice-preview-start", { cancelable: true }))) {
      status.textContent = "録音を止めてから試聴してください。";
      return;
    }
    active = voice.id;
    const current = generation;
    resetButtons();
    status.textContent = "読み込み中…";
    audio.src = new URL(`./voice-previews/${voice.id}.mp3`, import.meta.url).href;
    // Call play during the tap itself, including Safari's user-gesture requirement.
    try {
      await audio.play();
      if (current === generation) status.textContent = voice.name + "を試聴中";
    } catch {
      if (current !== generation) return;
      stop();
      status.textContent = "試聴できませんでした。通信を確認して、もう一度お試しください。";
    }
  }
  function render() {
    stop();
    list.replaceChildren();
    document.getElementById("voice-preview-text").textContent = PREVIEW_TEXT[language.value];
    for (const voice of VOICES.filter((v) => v.lang === language.value)) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = voice.name;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary";
      button.dataset.voice = voice.id;
      button.addEventListener("click", () => void play(voice));
      row.append(name, button);
      list.append(row);
    }
    resetButtons();
  }
  audio.addEventListener("ended", stop);
  audio.addEventListener("error", () => {
    if (!active) return;
    stop();
    status.textContent = "試聴できませんでした。通信を確認して、もう一度お試しください。";
  });
  language.addEventListener("change", render);
  details.addEventListener("toggle", () => { if (!details.open) stop(); });
  document.addEventListener("play", (e) => { if (e.target !== audio) stop(); }, true);
  // Stop before recording, generating or moving away from the text entry.
  for (const id of ["record", "compare", "tts-make", "entry-audio"])
    document.getElementById(id).addEventListener("click", stop, true);
  window.addEventListener("pagehide", stop);
  window.addEventListener("offline-update", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  render();
}
