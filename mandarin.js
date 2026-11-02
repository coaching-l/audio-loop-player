// Mandarin text to the reading symbols of Kokoro v1.1-zh, for the text-to-speech worker.
// Ported unchanged in behavior from COACHING-L Shadowing (src/mandarin.ts).
// pinyin-pro turns each character into pinyin (it already changes a third tone before a
// third tone inside a two-syllable word); the rule below handles longer runs of third
// tones, only where pinyin-pro left a third tone, so no syllable is changed twice.
import { pinyin } from "./vendor/pinyin-pro/pinyin-pro.js";
// Kokoro v1.1 symbol mapping: adapted from Misaki ZHFrontend / PaddleSpeech (Apache-2.0).
// Copyright (c) 2021 PaddlePaddle Authors. See docs/ATTRIBUTIONS.md.
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
function correctReadings(text, tokens) {
  const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
    .filter((w) => w.isWordLike)
    .map((w) => ({ start: w.index, end: w.index + w.segment.length, text: w.segment }));
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
  const boundaries = new Set(
    [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
      .filter((w) => w.isWordLike)
      .map((w) => w.index + w.segment.length)
      .filter((offset) => !joins.has(offset)),
  );
  const tokens = correctReadings(
    text,
    pinyin(text, {
      type: "all",
      toneType: "num",
      toneSandhi: { yi: true, bu: true, thirdTone: true },
    }),
  );
  let offset = 0;
  return tokens
    .map((t, i) => {
      offset += t.origin.length;
      if (t.isZh)
        return (
          syllable(
            t.pinyin,
            t.num === 3 && tokens[i + 1]?.num === 3 ? 2 : t.num,
          ) + (boundaries.has(offset) ? "/" : "")
        );
      const mapped = punctuation[t.origin] || t.origin;
      if (!/^[\s;:,.!?/—…“”"()‘’'-]*$/u.test(mapped))
        throw Error(`読み上げに対応しない文字「${t.origin}」があります。`);
      return mapped;
    })
    .join("")
    .replace(/\/+([;:,.!?])/g, "$1");
}
