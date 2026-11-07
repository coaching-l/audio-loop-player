import { test, expect } from "@playwright/test";
import { mandarinPhonemes, syllable } from "../mandarin.js";

const reading = (pinyin) => pinyin.split(" ").map((p) => syllable(p, Number(p.at(-1)))).join("");
const continuous = (text) => mandarinPhonemes(text).replaceAll("/", "");

test("modal and complement 得 have different readings; lexical dé is preserved", () => {
  expect(continuous("我得走了。")).toContain(reading("dei2 zou3"));
  expect(continuous("你得好好休息。")).toContain(reading("dei3 hao2 hao3"));
  expect(continuous("你看得见吗？")).toContain(reading("kan4 de0 jian4"));
  for (const text of ["他获得了冠军。", "我想得到它。", "这是他的心得。", "难得有空。"])
    expect(continuous(text)).toContain(reading("de2"));
});

test("common light syllables and polyphones are corrected without changing nearby words", () => {
  expect(continuous("请好好学习。")).toContain(reading("hao2 hao3 xue2 xi2"));
  expect(continuous("他舍不得离开。")).toContain(reading("she3 bu0 de0"));
  expect(continuous("朋友们都来了。")).toContain(reading("peng2 you0 men0"));
  expect(continuous("这件事情很重要。")).toContain(reading("shi4 qing0"));
  expect(continuous("她的爱好很多。")).toContain(reading("ai4 hao4"));
  expect(continuous("他很好奇。")).toContain(reading("hao4 qi2"));
  expect(continuous("儿子和女儿都来了。")).toContain(reading("er2"));
});

test("third-tone changes respect words, punctuation and corrected base readings", () => {
  expect(continuous("你好你好。")).toBe(reading("ni2 hao3 ni2 hao3") + ".");
  expect(continuous("我很好。")).toBe(reading("wo3 hen2 hao3") + ".");
  expect(continuous("你好，你好。")).toBe(reading("ni2 hao3") + "," + reading("ni2 hao3") + ".");
  expect(continuous("我，你。")).toBe(reading("wo3") + "," + reading("ni3") + ".");
  expect(continuous("一段。")).toContain(reading("yi2 duan4"));
  expect(continuous("不怕。")).toContain(reading("bu2 pa4"));
  expect(() => mandarinPhonemes("学习AI和2026。" )).toThrow();
});

test("the browser uses the same Mandarin readings", async ({ page }) => {
  await page.goto("/");
  const texts = ["我得走了。", "你看得见吗？", "请好好学习。", "你好你好。", "他舍不得离开。"];
  const actual = await page.evaluate(async (texts) => {
    const { mandarinPhonemes } = await import("./mandarin.js");
    return texts.map(mandarinPhonemes);
  }, texts);
  expect(actual).toEqual(texts.map(mandarinPhonemes));
});
