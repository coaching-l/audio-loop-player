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
export function mandarinPhonemes(text) {
  if (/[A-Za-z\d\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text))
    throw Error(
      "中国語の音声生成は漢字と句読点に対応しています。英単語や数字は、意図した中国語の読み方に編集してください。自動削除はしません。",
    );
  const boundaries = new Set(
    [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
      .filter((w) => w.isWordLike)
      .map((w) => w.index + w.segment.length),
  );
  const tokens = pinyin(text, {
    type: "all",
    toneType: "num",
    toneSandhi: { yi: true, bu: true, thirdTone: true },
  });
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
