import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { makePhrasesWav } from "./fixtures/make-audio.mjs";
import {
  splitSentences,
  alignSentences,
  retimeSentences,
  transcriptFromWords,
  transcriptFromSegments,
} from "../transcript.js";
import { MODEL_FILES, planWindows } from "../transcriber.js";

// Tones at 0–0.5 s, 1.1–1.6 s and 2.2–2.7 s; the waveform finds phrases at
// 0–0.6, 1.05–1.7 and 2.15–2.8.
const phrasesAudio = () => ({
  name: "phrases.wav",
  mimeType: "audio/wav",
  buffer: makePhrasesWav(),
});
const word = (text, start, end) => ({ text, start, end });
// What the recognizer would hear in the tones: segments with Whisper's leading spaces.
const englishSegments = [
  word(" One two.", 0.02, 0.45),
  word(" Three four.", 1.12, 1.55),
  word(" Five six.", 2.25, 2.65),
];
const chineseSegments = [
  word("你好。", 0.02, 0.45),
  word("我是学生。", 1.12, 1.55),
];
const sentences = (page) => page.locator("#transcript-sentences .sentence");

async function load(page, file = phrasesAudio()) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}

// Stands in for the Whisper worker: answers with fixed segments after a delay per pass.
async function fakeRecognizer(page, segments, delay = 50) {
  await page.addInitScript(
    ({ segments, delay }) => {
      const Real = window.Worker;
      window.transcribeCalls = [];
      window.transcribeStopped = 0;
      window.Worker = class extends EventTarget {
        constructor(url, options) {
          if (!String(url).includes("transcribe-worker"))
            return new Real(url, options);
          super();
          this.onmessage = null;
          this.onerror = null;
          this.stopped = false;
        }
        postMessage(data) {
          window.transcribeCalls.push({
            language: data.language,
            passes: data.windows.length,
            seconds: data.audio.length / data.rate,
            base: data.base / data.rate,
          });
          // "per-pass": one sentence for each pass, timed like the real worker does.
          const answer =
            segments === "per-pass"
              ? data.windows.map((w) => ({
                  text: ` Part at ${Math.round((data.base + w.start) / data.rate)}.`,
                  start: (data.base + w.start) / data.rate,
                  end: (data.base + w.end) / data.rate,
                }))
              : segments;
          const send = (message, wait) =>
            setTimeout(() => {
              if (!this.stopped)
                this.onmessage?.(
                  new MessageEvent("message", { data: message }),
                );
            }, wait);
          data.windows.forEach((_, done) =>
            send({ type: "progress", done }, delay * done),
          );
          send(
            { type: "done", segments: answer },
            delay * (data.windows.length + 1),
          );
        }
        terminate() {
          this.stopped = true;
          window.transcribeStopped++;
        }
      };
    },
    { segments, delay },
  );
}

// Fills the model cache with placeholders, as if the model had been saved before.
async function pretendModelSaved(page) {
  await page.evaluate(async () => {
    const { MODEL_FILES, MODEL_CACHE } = await import("./transcriber.js");
    const cache = await caches.open(MODEL_CACHE);
    for (const file of MODEL_FILES)
      await cache.put(new URL(file.path, location.href), new Response("test"));
  });
}

test("recognized words become sentences that split the same way when edited", () => {
  const result = transcriptFromWords(
    [
      word(" And", 0.1, 0.3),
      word(" so,", 0.3, 0.6),
      word(" my", 0.7, 0.9),
      word(" friends.", 0.9, 1.4),
      word(" Ask", 2.0, 2.3),
      word(" not", 2.3, 2.6),
      // A long pause without punctuation still ends a sentence.
      word(" what", 3.9, 4.1),
      word(" you", 4.1, 4.3),
      word(" can", 4.3, 4.6),
      word(" do.", 4.6, 5.0),
    ],
    6,
    [
      { start: 0.05, end: 1.5 },
      { start: 1.95, end: 2.75 },
      { start: 3.85, end: 5.1 },
    ],
  );
  expect(result.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["And so, my friends.", 0.05, 1.5],
    ["Ask not", 1.95, 2.75],
    ["what you can do.", 3.85, 5.1],
  ]);
  expect(splitSentences(result.text).map((s) => s.text)).toEqual(
    result.sentences.map((s) => s.text),
  );
  // Chinese without punctuation is cut at its pauses; a very long sentence at its
  // longest pause.
  const chinese = transcriptFromWords(
    [..."我是学生你呢我很好"].map((c, i) =>
      word(
        c,
        i * 0.3 + (i >= 4 ? 1.5 : 0),
        i * 0.3 + 0.25 + (i >= 4 ? 1.5 : 0),
      ),
    ),
    5,
  );
  expect(chinese.sentences.map((s) => s.text)).toEqual([
    "我是学生",
    "你呢我很好",
  ]);
  const long = transcriptFromWords(
    Array.from({ length: 40 }, (_, i) =>
      word(" w" + i + (i === 19 ? "," : ""), i * 0.4, i * 0.4 + 0.35),
    ),
    20,
  );
  expect(long.sentences).toHaveLength(2);
  expect(long.sentences[0].text.endsWith("w19,")).toBe(true);
  expect(transcriptFromWords([word(" ", 0, 1)], 2)).toBeNull();
});

test("a segment's time is shared by its sentences, cut at the pause between them", () => {
  const phrases = [
    { start: 0.4, end: 1.3 },
    { start: 1.9, end: 4.6 },
  ];
  // Whisper times the segment as a whole; the pause sits after 你好。
  const chinese = transcriptFromSegments(
    [word("你好。我是学生，今天天气很好。", 0.5, 4.5)],
    5,
    phrases,
  );
  expect(chinese.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["你好。", 0.4, 1.3],
    ["我是学生，今天天气很好。", 1.9, 4.6],
  ]);
  // Without punctuation, a space at a long pause ends the sentence.
  const spaced = transcriptFromSegments(
    [word("我是学生 你呢 我很好", 0, 6)],
    6,
    [
      { start: 0, end: 1.5 },
      { start: 3, end: 4 },
      { start: 4.2, end: 6 },
    ],
  );
  expect(spaced.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["我是学生", 0, 1.5],
    ["你呢 我很好", 3, 6],
  ]);
  const english = transcriptFromSegments(
    [
      word(" Ask not what your country can do for you.", 0.2, 3),
      word(" Ask what you can do.", 3.8, 5.5),
    ],
    6,
  );
  expect(english.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["Ask not what your country can do for you.", 0.2, 3],
    ["Ask what you can do.", 3.8, 5.5],
  ]);
});

test("a phrase said again and again, and a long run, become separate sentences", () => {
  const texts = (result) => result.sentences.map((s) => s.text);
  // Mandarin as Whisper often writes it: four readings and no full stops between.
  const readings = transcriptFromSegments(
    [
      word(
        "我以为你会不会有什么事我以为你会不会有什么事我以为你会不会有什么事我以为你会不会有什么事在这段关于中,你希望自己一怎样的姿态与对方相处。",
        0,
        15,
      ),
    ],
    16,
    [
      [0, 2.2],
      [2.8, 5],
      [5.6, 7.8],
      [8.4, 10.6],
      [11.2, 15],
    ].map(([start, end]) => ({ start, end })),
  );
  expect(readings.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["我以为你会不会有什么事", 0, 2.2],
    ["我以为你会不会有什么事", 2.8, 5],
    ["我以为你会不会有什么事", 5.6, 7.8],
    ["我以为你会不会有什么事", 8.4, 10.6],
    ["在这段关于中,你希望自己一怎样的姿态与对方相处。", 11.2, 15],
  ]);
  expect(splitSentences(readings.text).map((s) => s.text)).toEqual(
    texts(readings),
  );
  // Case and commas between the times do not matter; short repeats stay as they are.
  expect(
    texts(
      transcriptFromSegments(
        [word(" It was very very good. Say it again, say it again.", 0, 6)],
        6,
      ),
    ),
  ).toEqual(["It was very very good.", "Say it again,", "say it again."]);
  expect(
    texts(
      transcriptFromSegments([word("一天一天过去了，谢谢谢谢。", 0, 3)], 3),
    ),
  ).toEqual(["一天一天过去了，谢谢谢谢。"]);
  // A run of over 8 seconds is also cut at a half-second pause.
  expect(
    texts(
      transcriptFromSegments(
        [word("今天我们去公园散步 天气很好 我们看到很多花", 0, 9)],
        9,
        [
          [0, 3],
          [3.6, 6],
          [6.6, 9],
        ].map(([start, end]) => ({ start, end })),
      ),
    ),
  ).toEqual(["今天我们去公园散步", "天气很好 我们看到很多花"]);
});

test("pauses inside an English segment fall between sentences, not before a last word", () => {
  // Questions read with 1.5 s pauses, timed by Whisper as one segment.
  const questions = transcriptFromSegments(
    [
      word(
        " Who could support you? What options do you see? What might you do differently? What would be your first small step? What could get in the way?",
        0,
        15.2,
      ),
    ],
    16,
    [
      [0, 1.6],
      [3.1, 4.9],
      [6.4, 8.4],
      [9.9, 12],
      [13.5, 15.2],
    ].map(([start, end]) => ({ start, end })),
  );
  expect(questions.sentences.map((s) => [s.text, s.start, s.end])).toEqual([
    ["Who could support you?", 0, 1.6],
    ["What options do you see?", 3.1, 4.9],
    ["What might you do differently?", 6.4, 8.4],
    ["What would be your first small step?", 9.9, 12],
    ["What could get in the way?", 13.5, 15.2],
  ]);
});

test("editing keeps the times of unchanged sentences", () => {
  const phrases = [
    { start: 0, end: 0.6 },
    { start: 1.05, end: 1.3 },
    { start: 1.45, end: 1.7 },
    { start: 2.15, end: 2.8 },
  ];
  const before = alignSentences(
    splitSentences("One two three. Four five six seven. Eight nine."),
    3,
    phrases,
  );
  before[2] = { ...before[2], start: 2.2, end: 2.6, edited: true };
  // A typo fix keeps the sentence's time; untouched sentences keep theirs.
  const fixed = retimeSentences(
    before,
    splitSentences("One two three. Four five six sevn. Eight nine."),
    3,
    phrases,
  );
  expect(fixed.map((s) => [s.start, s.end])).toEqual(
    before.map((s) => [s.start, s.end]),
  );
  expect(fixed[2].edited).toBe(true);
  // A split sentence shares its time, cut at the pause inside it.
  const split = retimeSentences(
    before,
    splitSentences("One two three. Four five. Six seven. Eight nine."),
    3,
    phrases,
  );
  expect(split.map((s) => [s.text, s.start, s.end])).toEqual([
    ["One two three.", before[0].start, before[0].end],
    ["Four five.", before[1].start, 1.3],
    ["Six seven.", 1.45, before[1].end],
    ["Eight nine.", 2.2, 2.6],
  ]);
});

test("long audio is heard in passes cut at pauses, skipping silence", () => {
  const rate = 16000;
  const samples = new Float32Array(95 * rate);
  // Sound for 0–20 s and 80–95 s, silence between.
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    if (t < 20 || t >= 80) samples[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  const passes = planWindows(samples, rate).map((w) => [
    w.start / rate,
    w.end / rate,
  ]);
  expect(passes).toHaveLength(2);
  expect(passes[0][0]).toBe(0);
  expect(passes[0][1]).toBeGreaterThan(20);
  expect(passes[0][1]).toBeLessThanOrEqual(28);
  expect(passes[1][0]).toBeGreaterThan(75);
  expect(passes[1][0]).toBeLessThanOrEqual(80);
  expect(passes[1][1]).toBe(95);
});

test("the model files on disk match their recorded sizes and hashes", async () => {
  for (const file of MODEL_FILES) {
    const bytes = await readFile(file.path);
    expect(bytes.length, file.path).toBe(file.size);
    expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(
      file.sha256,
    );
  }
});

test("speech is transcribed into sentences timed to the waveform's pauses", async ({
  page,
}) => {
  await fakeRecognizer(page, englishSegments);
  await page.goto("/");
  await load(page);
  await expect(page.locator("#waveform")).toBeVisible();
  await pretendModelSaved(page);
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(sentences(page)).toHaveText([
    "One two.",
    "Three four.",
    "Five six.",
  ]);
  await expect(page.locator("#transcript-status")).toHaveText("3文");
  await expect(page.locator("#notice")).toContainText("3文を書き起こしました");
  const calls = await page.evaluate(() => window.transcribeCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].language).toBe("en");
  expect(calls[0].passes).toBe(1);
  expect(calls[0].seconds).toBeCloseTo(2.7, 1);
  await sentences(page).nth(1).click();
  await expect(page.locator("#point-a")).toHaveValue("0:01.050");
  await expect(page.locator("#point-b")).toHaveValue("0:01.700");
  // Fixing a word keeps the times.
  await page.getByRole("button", { name: "原文を直す" }).click();
  await expect(page.locator("#transcript-input")).toHaveValue(
    "One two. Three four. Five six.",
  );
  await page.locator("#transcript-input").fill("One two. Three for. Five six.");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await page.locator("#repeat-mode").selectOption("off");
  await sentences(page).nth(1).click();
  await expect(sentences(page).nth(1)).toHaveText("Three for.");
  await expect(page.locator("#point-a")).toHaveValue("0:01.050");
  await expect(page.locator("#point-b")).toHaveValue("0:01.700");
  // Saved with the audio file.
  await page.reload();
  await page
    .getByRole("button", { name: "phrases.wavを開く", exact: true })
    .click();
  await expect(sentences(page)).toHaveCount(3);
});

test("Chinese is transcribed on opening when that is switched on", async ({
  page,
}) => {
  await fakeRecognizer(page, chineseSegments);
  await page.goto("/");
  await load(page, "tests/fixtures/tone.wav");
  await pretendModelSaved(page);
  await page.getByLabel("話している言語").selectOption("zh");
  await page
    .getByLabel("原文のない音声は、開いたときに自動で文字起こしする")
    .check();
  await load(page);
  await expect(sentences(page)).toHaveText(["你好。", "我是学生。"]);
  await expect(page.locator("#transcript-sentences")).toHaveAttribute(
    "lang",
    "zh-CN",
  );
  const calls = await page.evaluate(() => window.transcribeCalls);
  expect(calls.map((call) => call.language)).toEqual(["zh"]);
  // The choices are remembered.
  await page.reload();
  await expect(
    page.getByLabel("原文のない音声は、開いたときに自動で文字起こしする"),
  ).toBeChecked();
  await expect(page.getByLabel("話している言語")).toHaveValue("zh");
});

test("without much memory, each pass runs in a fresh worker and the times add up", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "deviceMemory", {
      get: () => 4,
    }),
  );
  await fakeRecognizer(page, "per-pass");
  await page.goto("/");
  // About 70 seconds of short phrases with pauses: three passes.
  await load(page, {
    name: "long.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(Array.from({ length: 140 }, () => 0.5)),
  });
  await pretendModelSaved(page);
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(page.locator("#notice")).toContainText("書き起こしました");
  const calls = await page.evaluate(() => window.transcribeCalls);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every((call) => call.passes === 1)).toBe(true);
  expect(calls[0].base).toBe(0);
  // Each worker gets only its part of the audio, and its times are in the whole audio.
  for (let i = 1; i < calls.length; i++)
    expect(calls[i].base).toBeCloseTo(
      calls[i - 1].base + calls[i - 1].seconds,
      2,
    );
  expect(await page.evaluate(() => window.transcribeStopped)).toBe(
    calls.length,
  );
  // (Each made-up pass is one long sentence, so it may be cut further at pauses.)
  const heard = (await sentences(page).allTextContents()).join(" ");
  expect(heard.replace(/\s+/g, " ")).toBe(
    calls.map((call) => `Part at ${Math.round(call.base)}.`).join(" "),
  );
});

test("a transcription can be stopped, and opening another file stops it", async ({
  page,
}) => {
  await fakeRecognizer(page, englishSegments, 60000);
  await page.goto("/");
  await load(page);
  await pretendModelSaved(page);
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(page.locator("#transcript-status")).toHaveText("文字起こし中");
  await expect(page.locator("#transcribe-status")).toContainText(
    "英語の文字を起こしています… 0 / 1",
  );
  await expect(page.locator("#transcript-manual")).toBeHidden();
  await page.getByRole("button", { name: "文字起こしを中止" }).click();
  await expect(page.locator("#notice")).toHaveText(
    "文字起こしを中止しました。",
  );
  await expect(page.locator("#transcript-status")).toHaveText("原文なし");
  await expect(
    page.getByRole("button", { name: "音声から文字起こし" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(page.locator("#transcribe-status")).toContainText("0 / 1");
  await load(page, "tests/fixtures/tone.wav");
  await expect(page.locator("#transcript-status")).toHaveText("原文なし");
  expect(await page.evaluate(() => window.transcribeStopped)).toBe(2);
});

test("the model is saved once after checking each file, and can be deleted", async ({
  page,
}) => {
  test.setTimeout(120000);
  await fakeRecognizer(page, englishSegments);
  await page.goto("/");
  await load(page);
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(page.locator("#transcribe-status")).toContainText(
    "文字起こし用のデータを保存しています",
  );
  await expect(sentences(page)).toHaveCount(3, { timeout: 90000 });
  await page.locator("summary", { hasText: "ご利用にあたって" }).click();
  await expect(page.locator("#model-status")).toContainText("保存しています");
  const saved = await page.evaluate(async () => {
    const { MODEL_FILES, MODEL_CACHE } = await import("./transcriber.js");
    const cache = await caches.open(MODEL_CACHE);
    const sizes = [];
    for (const file of MODEL_FILES) {
      const response = await cache.match(new URL(file.path, location.href));
      sizes.push((await response.arrayBuffer()).byteLength === file.size);
    }
    return sizes;
  });
  expect(saved.every(Boolean)).toBe(true);
  await page
    .getByRole("button", { name: "文字起こし用のデータを削除" })
    .click();
  await expect(page.locator("#model-status")).toContainText(
    "まだ保存していません",
  );
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).filter((key) => key.includes("model")),
    ),
  ).toEqual([]);
});

// tests/fixtures/jfk.wav: 11 seconds of President Kennedy's inaugural address (1961), a
// work of the U.S. government in the public domain; the sample whisper.cpp ships with.
test("Whisper itself transcribes real speech, also offline once saved", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Same engine as the desktop run; once per engine is enough.",
  );
  test.setTimeout(300000);
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/");
  await load(page, "tests/fixtures/jfk.wav");
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  await expect(sentences(page).first()).toBeVisible({ timeout: 240000 });
  const heard = (await sentences(page).allTextContents()).join(" ");
  expect(heard.toLowerCase().replace(/[^a-z ]/g, "")).toContain(
    "ask not what your country can do for you",
  );
  // The saved model works without a connection.
  await page.getByRole("button", { name: "原文を消す" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "音声から文字起こし" }).click();
  try {
    await expect(page.locator("#notice")).toContainText("書き起こしました", {
      timeout: 240000,
    });
  } catch (error) {
    // Name what went wrong inside the page, not only the message it showed.
    error.message += "\nConsole errors:\n" + problems.join("\n");
    throw error;
  }
  await expect(sentences(page).first()).toBeVisible();
  await context.setOffline(false);
});
