// English text to the phonemes Kokoro v1.0 reads, for the text-to-speech worker.
// Ported from kokoro-js 1.2.1 (Apache-2.0, Copyright hexgrad; see vendor/phonemizer and
// the kokoro-js notice in vendor/README.md): its text normalization and phonemize()
// unchanged in behavior, with phonemizer (eSpeak NG) loaded from this site.
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

function normalize(text) {
  return text
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
    .replace(
      /\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,
      splitNumber,
    )
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
      flipMoney,
    )
    .replace(/\d*\.\d+/g, pointNumber)
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
