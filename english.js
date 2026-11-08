// English text to the phonemes Kokoro v1.0 reads, for the text-to-speech worker.
// Ported from kokoro-js 1.2.1 (Apache-2.0, Copyright hexgrad; see vendor/phonemizer and
// the kokoro-js notice in vendor/README.md): its text normalization and phonemize()
// with narrowly scoped number/context corrections. eSpeak NG is loaded locally.
// Before phonemizer: older Safari cannot iterate the stream it unpacks its data from.
import "./stream-iterator.js";
import { phonemize as espeak } from "./vendor/phonemizer/phonemizer.js";

// "1990" → "19 90", "4:30" → "4 30", "2:00" → "2 o'clock".
function splitNumber(text) {
  if (text.includes(".")) return text;
  if (text.includes(":")) {
    const [hours, minutes] = text.split(":").map(Number);
    if (minutes === 0) return `${hours} o'clock`;
    if (minutes < 10) return `${hours} oh ${minutes}`;
    return `${hours} ${minutes}`;
  }
  const year = parseInt(text.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return text;
  const left = text.slice(0, 2);
  const right = parseInt(text.slice(2, 4), 10);
  const suffix = text.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

// "$3.50" → "3 dollars and 50 cents".
function flipMoney(text) {
  const unit = text[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(text.slice(1)))) return `${text.slice(1)} ${unit}s`;
  if (!text.includes(".")) {
    const plural = text.slice(1) === "1" ? "" : "s";
    return `${text.slice(1)} ${unit}${plural}`;
  }
  const [whole, fraction] = text.slice(1).split(".");
  const cents = parseInt(fraction.padEnd(2, "0"), 10);
  const small =
    text[0] === "$"
      ? cents === 1
        ? "cent"
        : "cents"
      : cents === 1
        ? "penny"
        : "pence";
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${small}`;
}

// "3.14" → "3 point 1 4".
function pointNumber(text) {
  const [whole, fraction] = text.split(".");
  return `${whole} point ${fraction.split("").join(" ")}`;
}

// Match amounts as a whole before considering years. Replacement text is never
// processed again: "$1234" must not become "$12 34" or "12 dollars 34".
function normalizeNumbers(text) {
  return text.replace(
    /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|\d*\.\d+|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)|\b\d{4}s?\b/gi,
    (value, offset, source) => {
      if (/^[$£]/.test(value)) return flipMoney(value);
      if (value.includes(".")) return pointNumber(value);
      if (value.includes(":")) return splitNumber(value);
      // Keep year-style reading only for clear dates/decades. Quantities and
      // identifiers go to eSpeak intact (e.g. "2024 books", not "20 24 books").
      const before = source.slice(0, offset);
      const after = source.slice(offset + value.length);
      return /s$/i.test(value) ||
        (/\b(?:in|since|during|until|before|after|by|year|from|around)\s+$/i.test(before) &&
         /^\s*(?:[.,;:!?]|$)/.test(after))
        ? splitNumber(value) : value;
    },
  );
}

// Pronunciation aliases affect only the phonemizer input, never the user's text.
// Keep the whole phrase in eSpeak so surrounding words retain their context.
// These deliberately cover clear constructions, not arbitrary English grammar.
function contextualReadings(text) {
  return text.replace(/\b(?:read|record)\b/gi, (word, offset, source) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + word.length);
    if (word.toLowerCase() === "read") {
      const time = "(?:yesterday|last (?:night|week|month|year))";
      const subject = "(?:I|you|he|she|we|they)";
      const object = "(?:it|them|(?:a|an|the|this|that|my|your|his|her|our|their) (?:book|article|letter|email|message|report|story|chapter|page|text|sentence|novel|paper|document))";
      const pastBefore = new RegExp(`\\b${time},?\\s+${subject}\\s+$`, "i");
      const pastAfter = new RegExp(`^\\s+(?:${object}\\s+)?${time}(?=[,.!?;:]|$)`, "i");
      if (pastBefore.test(before) ||
          (new RegExp(`\\b${subject}\\s+$`, "i").test(before) && pastAfter.test(after)))
        return "red";
    } else {
      const verbCue = /\b(?:please,?|I|you|we|they|to|can|could|will|would|should|must|may|might|shall|don't|didn't)\s+(?:(?:not|also|just|never)\s+)?$/i;
      const atStart = /(?:^|[.!?]\s*)$/.test(before);
      const objectFollows = /^\s+(?:a|an|the|this|that|these|those|my|your|our|his|her|their|it|them|me|us|you|him|audio|video|music)\b|^\s*(?:[.!?]|$)/i;
      // The accent forces the verb's second-syllable stress in en-us and en.
      // "record sales" and "to record stores" remain untouched.
      if ((verbCue.test(before) || atStart) && objectFollows.test(after)) return "recórd";
    }
    return word;
  });
}

function normalize(text) {
  text = text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, '"')
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/  +/, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/(?<=\d),(?=\d)/g, "")
    .trim();
  return contextualReadings(normalizeNumbers(text))
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_RUN = new RegExp(
  `(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g",
);

// Punctuation is kept as it is; only the words between are sent to eSpeak NG.
function splitKeeping(text, pattern) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (last < match.index)
      parts.push({ match: false, text: text.slice(last, match.index) });
    if (match[0].length) parts.push({ match: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ match: false, text: text.slice(last) });
  return parts;
}

// accent: "a" for American English voices (af_, am_), "b" for British (bf_, bm_).
export async function englishPhonemes(text, accent = "a") {
  const language = accent === "a" ? "en-us" : "en";
  const pieces = await Promise.all(
    splitKeeping(normalize(text), PUNCTUATION_RUN).map(async (part) =>
      part.match ? part.text : (await espeak(part.text, language)).join(" "),
    ),
  );
  let phonemes = pieces
    .join("")
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (accent === "a") phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return phonemes.trim();
}
