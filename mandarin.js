// Mandarin text to the reading symbols of Kokoro v1.1-zh, for the text-to-speech worker.
// Chinese readings, then word-level tone changes, then Kokoro's symbols. Keeping these
// steps separate lets a dictionary correction take part in sandhi exactly once.
import { pinyin } from "./vendor/pinyin-pro/pinyin-pro.js";
import { WORD_READINGS } from "./mandarin-lexicon.js";
// Kokoro v1.1 symbol mapping: adapted from Misaki ZHFrontend / PaddleSpeech (Apache-2.0).
// Copyright (c) 2021 PaddlePaddle Authors. See vendor/README.md.
const symbols = {
  b: "ㄅ",
  p: "ㄆ",
  m: "ㄇ",
  f: "ㄈ",
  d: "ㄉ",
  t: "ㄊ",
  n: "ㄋ",
  l: "ㄌ",
  g: "ㄍ",
  k: "ㄎ",
  h: "ㄏ",
  j: "ㄐ",
  q: "ㄑ",
  x: "ㄒ",
  zh: "ㄓ",
  ch: "ㄔ",
  sh: "ㄕ",
  r: "ㄖ",
  z: "ㄗ",
  c: "ㄘ",
  s: "ㄙ",
  a: "ㄚ",
  o: "ㄛ",
  e: "ㄜ",
  ie: "ㄝ",
  ai: "ㄞ",
  ei: "ㄟ",
  ao: "ㄠ",
  ou: "ㄡ",
  an: "ㄢ",
  en: "ㄣ",
  ang: "ㄤ",
  eng: "ㄥ",
  er: "ㄦ",
  i: "ㄧ",
  u: "ㄨ",
  v: "ㄩ",
  ii: "ㄭ",
  iii: "十",
  ve: "月",
  ia: "压",
  ian: "言",
  iang: "阳",
  iao: "要",
  in: "阴",
  ing: "应",
  iong: "用",
  iou: "又",
  ong: "中",
  ua: "穵",
  uai: "外",
  uan: "万",
  uang: "王",
  uei: "为",
  uen: "文",
  ueng: "瓮",
  uo: "我",
  van: "元",
  vn: "云",
};
const punctuation = {
  "，": ",",
  "、": ",",
  "。": ".",
  "！": "!",
  "？": "?",
  "；": ";",
  "：": ":",
  "（": "(",
  "）": ")",
  "「": "“",
  "」": "”",
  "『": "“",
  "』": "”",
  "《": "“",
  "》": "”",
};
export function syllable(py, tone) {
  let base = py.replace(/[0-5]/g, "").replaceAll("ü", "v"),
    initial = "";
  const y = {
    yi: "i",
    ya: "ia",
    ye: "ie",
    yao: "iao",
    you: "iou",
    yan: "ian",
    yin: "in",
    yang: "iang",
    ying: "ing",
    yong: "iong",
    yu: "v",
    yue: "ve",
    yuan: "van",
    yun: "vn",
  };
  const w = {
    wu: "u",
    wa: "ua",
    wo: "uo",
    wai: "uai",
    wei: "uei",
    wan: "uan",
    wen: "uen",
    wang: "uang",
    weng: "ueng",
  };
  if (y[base] || w[base]) base = y[base] || w[base];
  else {
    initial = base.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])/u)?.[0] || "";
    base = base.slice(initial.length);
    if (["j", "q", "x"].includes(initial) && base.startsWith("u"))
      base = "v" + base.slice(1);
    if (base === "iu") base = "iou";
    if (base === "ui") base = "uei";
    if (base === "un") base = "uen";
    if (base === "i" && ["z", "c", "s"].includes(initial)) base = "ii";
    if (base === "i" && ["zh", "ch", "sh", "r"].includes(initial)) base = "iii";
  }
  if ((initial && !(initial in symbols)) || !(base in symbols))
    throw Error(
      `中国語の読み「${py}」を変換できません。原稿の該当箇所を確認してください。`,
    );
  return (initial ? symbols[initial] : "") + symbols[base] + (tone || 5);
}
// pinyin-pro reads a few common characters by their dictionary reading where the grammar
// asks for another. These rules correct them using the word boundaries of
// Intl.Segmenter; anything they do not match keeps pinyin-pro's reading.
// 地 marking an adverb (高兴地笑, 慢慢地走) is "de" (neutral), not "dì" (ground).
// After these, as in 这块地, it is the noun.
const NOUN_BEFORE_DI = new Set([..."块片这那此每该种的"]);
// 得 after a verb (跑得快, 说得对) is "de"; in these words it is "dé".
const DE2_WORDS = new Set(["获得", "取得", "赢得", "难得", "求得", "博得", "心得", "所得"]);
function correctReadings(text, tokens, words) {
  const wordAt = (offset) => words.find((w) => w.start <= offset && offset < w.end);
  const isHan = (ch) => /\p{Script=Han}/u.test(ch || "");
  let offset = 0;
  tokens.forEach((t, i) => {
    const at = offset;
    offset += t.origin.length;
    if (!t.isZh) return;
    const word = wordAt(at);
    const before = text[at - 1];
    const after = text[at + 1];
    const neutral = (py) => Object.assign(t, { pinyin: py + "0", num: 0 });
    if (t.origin === "地" && word) {
      const alone = word.text === "地" && isHan(before) && !NOUN_BEFORE_DI.has(before) && isHan(after);
      const doubled = word.text.length >= 3 && word.end === at + 1 && word.text[0] === word.text[1];
      if (alone || doubled) neutral("de");
    } else if (t.origin === "得" && word && word.text.length === 2 && word.end === at + 1) {
      if (!DE2_WORDS.has(word.text) && t.num === 2) neutral("de");
      // 长得 (to look, to have grown) is zhǎng, not cháng.
      if (word.text === "长得" && tokens[i - 1]?.pinyin.startsWith("chang"))
        Object.assign(tokens[i - 1], { pinyin: "zhang3", num: 3 });
    }
  });
  return tokens;
}

function setReading(token, reading) {
  token.pinyin = reading;
  token.num = Number(reading.at(-1));
}

// Only override complete dictionary words, not matching characters inside another word.
// Contextual 得 rules are deliberately limited: 得到/获得 and 不得 are not modal děi.
function lexicalReadings(text, tokens, words) {
  for (const word of words) {
    const reading = WORD_READINGS[word.text];
    if (!reading) continue;
    const part = tokens.filter((t) => t.start >= word.start && t.end <= word.end);
    reading.split(" ").forEach((py, i) => setReading(part[i], py));
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.isZh) continue;
    const before = text.slice(0, t.start);
    const after = text.slice(t.end);
    if (t.origin === "得") {
      if (/(?:我|你|您|他|她|我们|你们|他们|她们|大家)(?:也|都|还)?$/u.test(before) &&
          /^(?:走|去|来|回|好好|赶快|赶紧|先|再|学习|工作|休息|注意|小心|想|买|吃|喝)/u.test(after))
        setReading(t, "dei3");
      else if (/[看听吃喝拿搬做写读说记认睡跑走]$/u.test(before) &&
               /^[见清懂完动住下起进出对快慢好远]/u.test(after))
        setReading(t, "de0");
    }
    // 好好 can be embedded in 请好好 by ICU. Correct this adverb before common verbs,
    // without changing 好奇/爱好 or an unrelated 好 at either side of a word boundary.
    if (t.origin === "好" && /^好(?:学习|休息|说话|想想|看看|吃饭|工作|照顾)/u.test(after) &&
        !/[爱喜嗜]$/u.test(before)) {
      setReading(t, "hao3");
      setReading(tokens[i + 1], "hao3");
    }
  }
}

// Word grouping matters: 你好/你好 is 23/23, not 22/23. For a three-syllable word,
// distinguish 1+2 (纸/老虎) from 2+1 (展览/馆), as Misaki/PaddleSpeech does. ICU is
// our browser-local segmenter, so this is a conservative subset, not the full frontend.
function thirdTones(tokens, words) {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  for (const word of words) {
    const part = tokens.filter((t) => t.isZh && t.start >= word.start && t.end <= word.end);
    if (part.length === 3 && part.every((t) => t.num === 3)) {
      const suffix = [...segmenter.segment(word.text.slice(1))];
      if (suffix.length === 1 && suffix[0].isWordLike) {
        part[1].num = 2;
        continue;
      }
    }
    // Four-syllable expressions are grouped as two pairs. Other words change only
    // adjacent thirds within the word. Work from the original tones, not changed ones.
    const tones = part.map((t) => t.num);
    for (let i = 0; i + 1 < part.length; i++)
      if (tones[i] === 3 && tones[i + 1] === 3 && !(part.length === 4 && i === 1))
        part[i].num = 2;
  }
  // Remaining adjacent thirds at word edges: the next word's internal sandhi has
  // already happened, so a preceding third stays third before a 23 word (我/很好).
  const edges = new Set(words.map((w) => w.end));
  const tones = tokens.map((t) => t.num);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i], next = tokens[i + 1];
    if (edges.has(t.end) && t.isZh && next.isZh && t.end === next.start && tones[i] === 3 && tones[i + 1] === 3)
      t.num = 2;
  }
}

// A verb and its complement are said as one (看不清, 听懂, 走过来), but the segmenter
// often splits them (我看|不清, 走过|来), and Kokoro pauses at each word boundary. These
// are the boundaries (offsets in the text) to leave out:
// - potential: verb + 不/得 + complement (看不清, 拿不动, 想不起来, 看得见)
// - result: verb + 清懂见完动到住掉错好开 (听懂, 吃完, 找到)
// - direction: verb + (过出进回起上下) + 来/去 (走过来, 拿出来, 站起来)
const RESULT = "清懂见完动到住掉错好开";
const DIRECTION = "过出进回起上下";
const COMPLEMENT = RESULT + DIRECTION + "来去";
const NOT_VERB = "我你他她它您们咱";
function complementJoins(text) {
  const han = (ch) => /\p{Script=Han}/u.test(ch || "");
  const verb = (ch) => han(ch) && !NOT_VERB.includes(ch);
  const joins = new Set();
  for (let i = 1; i < text.length; i++) {
    const [prev, ch, next] = [text[i - 1], text[i], text[i + 1]];
    if ("不得".includes(ch) && verb(prev) && next && COMPLEMENT.includes(next)) {
      joins.add(i).add(i + 1);
      if (DIRECTION.includes(next) && "来去".includes(text[i + 2] || ""))
        joins.add(i + 2);
    } else if (verb(prev) && RESULT.includes(ch)) joins.add(i);
    else if (verb(prev) && DIRECTION.includes(ch) && "来去".includes(next || ""))
      joins.add(i).add(i + 1);
  }
  return joins;
}

export function mandarinPhonemes(text) {
  if (/[A-Za-z\d\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text))
    throw Error(
      "中国語の音声生成は漢字と句読点に対応しています。英単語や数字は、意図した中国語の読み方に編集してください。自動削除はしません。",
    );
  const joins = complementJoins(text);
  const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
    .filter((w) => w.isWordLike)
    .map((w) => ({ start: w.index, end: w.index + w.segment.length, text: w.segment }));
  const boundaries = new Set(
    words.map((w) => w.end)
      .filter((offset) => !joins.has(offset)),
  );
  let at = 0;
  const tokens = pinyin(text, {
    type: "all",
    toneType: "num",
    toneSandhi: { yi: true, bu: true, thirdTone: false },
  }).map((t) => {
    const start = at;
    at += t.origin.length;
    return { ...t, start, end: at };
  });
  correctReadings(text, tokens, words);
  lexicalReadings(text, tokens, words);
  thirdTones(tokens, words);
  let offset = 0;
  return tokens
    .map((t) => {
      offset += t.origin.length;
      if (t.isZh)
        return syllable(t.pinyin, t.num) + (boundaries.has(offset) ? "/" : "");
      const mapped = punctuation[t.origin] || t.origin;
      if (!/^[\s;:,.!?/—…“”"()‘’'-]*$/u.test(mapped))
        throw Error(`読み上げに対応しない文字「${t.origin}」があります。`);
      return mapped;
    })
    .join("")
    .replace(/\/+([;:,.!?])/g, "$1");
}
