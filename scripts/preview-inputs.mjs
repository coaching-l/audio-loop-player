// Prepare preview phonemes using exactly the app's current language frontends.
import { writeFileSync } from "node:fs";
import { VOICES, PREVIEW_TEXT } from "../voices.js";
import { englishPhonemes } from "../english.js";
import { mandarinPhonemes } from "../mandarin.js";
const inputs = [];
for (const voice of VOICES) {
  const text = PREVIEW_TEXT[voice.lang];
  inputs.push({ ...voice, text, phonemes: voice.lang === "zh"
    ? mandarinPhonemes(text) : await englishPhonemes(text, voice.id[0]) });
}
writeFileSync(process.argv[2] || "/tmp/voice-preview-inputs.json", JSON.stringify(inputs, null, 2));
