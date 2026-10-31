import { test, expect } from "@playwright/test";
import { makePhrasesWav, makeWav } from "./fixtures/make-audio.mjs";
import { openAdvanced, setRepeat } from "./helpers.mjs";
import {
  splitSentences,
  alignSentences,
  sentenceAt,
  decodeText,
} from "../transcript.js";

// Tones at 0–0.5 s, 1.1–1.6 s and 2.2–2.7 s, like three spoken sentences.
const phrasesAudio = () => ({
  name: "phrases.wav",
  mimeType: "audio/wav",
  buffer: makePhrasesWav(),
});
const english = "One two three. Four five six seven. Eight nine.";
async function load(page, file = phrasesAudio()) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function paste(page, text) {
  await page.getByRole("button", { name: "スクリプトを貼り付ける" }).click();
  await page.locator("#transcript-input").fill(text);
  await page.getByRole("button", { name: "保存する", exact: true }).click();
}
const seconds = (text) => {
  const [m, s] = text.split(":");
  return Number(m) * 60 + Number(s);
};
const sentences = (page) => page.locator("#transcript-sentences .sentence");

test("English and Chinese text splits into sentences", () => {
  expect(
    splitSentences('Hello there. Mr. Smith is here! He said "Stop!" Ok.').map(
      (s) => s.text,
    ),
  ).toEqual(["Hello there.", "Mr. Smith is here!", 'He said "Stop!"', "Ok."]);
  expect(
    splitSentences("你好。我是学生！“你呢？”他问。\n第二行").map((s) => s.text),
  ).toEqual(["你好。", "我是学生！", "“你呢？”", "他问。", "第二行"]);
  // GB18030 bytes for 你好。, as Chinese text files are often saved.
  expect(decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xa1, 0xa3]))).toBe(
    "你好。",
  );
});

test("sentence times move to the pauses nearest their length-based estimate", () => {
  const phrases = [
    { start: 0, end: 0.6 },
    { start: 1.05, end: 1.7 },
    { start: 2.15, end: 2.8 },
  ];
  const timed = alignSentences(splitSentences(english), 3, phrases);
  expect(timed.map((s) => [s.start, s.end])).toEqual([
    [0, 0.6],
    [1.05, 1.7],
    [2.15, 2.8],
  ]);
  expect([0.2, 1.3, 2.5, 2.9].map((t) => sentenceAt(timed, t))).toEqual([
    0, 1, 2, 2,
  ]);
  // Without pauses, time is shared by length and still covers the whole audio.
  const estimated = alignSentences(splitSentences(english), 3);
  expect(estimated[0].start).toBe(0);
  expect(estimated[2].end).toBe(3);
  expect(estimated[1].start).toBeGreaterThan(0.5);
});

test("pasted text follows playback and a sentence becomes the A–B interval", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await expect(page.locator("#transcript-status")).toHaveText("スクリプトなし");
  await paste(page, english);
  await expect(sentences(page)).toHaveText([
    "One two three.",
    "Four five six seven.",
    "Eight nine.",
  ]);
  await expect(page.locator("#transcript-status")).toHaveText("3文");
  await expect(page.locator("#transcript-sentences")).toHaveAttribute(
    "lang",
    "en",
  );
  // Times come from the pauses once the waveform is ready.
  await expect(page.locator("#waveform")).toBeVisible();
  await sentences(page).nth(1).click();
  const a = seconds(await page.locator("#point-a").inputValue());
  const b = seconds(await page.locator("#point-b").inputValue());
  expect(a).toBeGreaterThan(0.95);
  expect(a).toBeLessThan(1.15);
  expect(b).toBeGreaterThan(1.55);
  expect(b).toBeLessThan(1.8);
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sentences(page).nth(1)).toHaveClass(/is-selected/);
  await setRepeat(page, false);
  await page.locator("#seek").evaluate((el) => {
    el.value = "0";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#play").click();
  await expect(sentences(page).nth(0)).toHaveClass(/is-current/);
  await expect(sentences(page).nth(1)).toHaveClass(/is-current/, {
    timeout: 3000,
  });
  await expect(sentences(page).nth(2)).toHaveClass(/is-current/, {
    timeout: 3000,
  });
  await expect(sentences(page).nth(1)).not.toHaveClass(/is-current/);
  // Saved with the audio file.
  await page.reload();
  await page
    .getByRole("button", { name: "phrases.wavを開く", exact: true })
    .click();
  await expect(sentences(page)).toHaveCount(3);
});

test("a sentence's timing can be corrected from the A–B interval", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await expect(page.locator("#waveform")).toBeVisible();
  await paste(page, english);
  await sentences(page).nth(2).click();
  await openAdvanced(page);
  await page.locator("#point-b").fill("2.6");
  await page.locator("#point-b").press("Tab");
  await page
    .getByRole("button", { name: "選んだ文の時刻を今のA–Bにする" })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "phrases.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await setRepeat(page, false);
  await sentences(page).nth(2).click();
  await expect(page.locator("#point-b")).toHaveValue("0:02.600");
});

test("a Chinese text file is checked, saved and shown with Chinese glyphs", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await page.locator("#transcript-file").setInputFiles({
    name: "lesson.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("你好。我是学生！\n今天天气很好。"),
  });
  await expect(page.locator("#transcript-input")).toHaveValue(
    "你好。我是学生！\n今天天气很好。",
  );
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(sentences(page)).toHaveText([
    "你好。",
    "我是学生！",
    "今天天气很好。",
  ]);
  await expect(page.locator("#transcript-sentences")).toHaveAttribute(
    "lang",
    "zh-CN",
  );
});

test("the script can be edited and deleted with undo", async ({ page }) => {
  await page.goto("/");
  await load(page);
  await paste(page, english);
  await page.reload();
  await page
    .getByRole("button", { name: "phrases.wavを開く", exact: true })
    .click();
  await expect(sentences(page)).toHaveCount(3);
  await page.getByRole("button", { name: "スクリプトを直す" }).click();
  await expect(page.locator("#transcript-input")).toHaveValue(english);
  await page.locator("#transcript-input").fill("Only one sentence");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(sentences(page)).toHaveText(["Only one sentence"]);
  await page.getByRole("button", { name: "スクリプトを消す" }).click();
  await expect(page.locator("#transcript-status")).toHaveText("スクリプトなし");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(sentences(page)).toHaveText(["Only one sentence"]);
});

// The way in from text will hand over audio together with its script and times.
test("material can bring its own script, which the learner's edits then replace", async ({
  page,
}) => {
  await page.goto("/");
  const open = (script) =>
    page.evaluate(
      async ({ bytes, script }) => {
        const { openPractice } = await import("/practice.js");
        const file = new File([new Uint8Array(bytes)], "made.wav", {
          type: "audio/wav",
        });
        await openPractice({ file, key: "text:lesson-1", name: "教材1", script });
      },
      { bytes: [...makePhrasesWav()], script },
    );
  const given = {
    text: "First. Second. Third.",
    sentences: [
      { text: "First.", start: 0, end: 0.5 },
      { text: "Second.", start: 1.1, end: 1.6 },
      { text: "Third.", start: 2.2, end: 2.7 },
    ],
  };
  await open(given);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#file-name")).toHaveText("教材1");
  await expect(sentences(page)).toHaveText(["First.", "Second.", "Third."]);
  await sentences(page).nth(1).click();
  await expect(page.locator("#point-a")).toHaveValue("0:01.100");
  await expect(page.locator("#point-b")).toHaveValue("0:01.600");
  // Saved under the material's own key, so the learner's edit is what comes back.
  await page.getByRole("button", { name: "スクリプトを直す" }).click();
  await page.locator("#transcript-input").fill("First. Second, changed. Third.");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await open(given);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(sentences(page).nth(1)).toHaveText("Second, changed.");
  // A script without times is timed like a pasted one.
  await page.evaluate(
    async ({ bytes }) => {
      const { openPractice } = await import("/practice.js");
      const file = new File([new Uint8Array(bytes)], "plain.wav", {
        type: "audio/wav",
      });
      await openPractice({ file, script: { text: "Just one line." } });
    },
    { bytes: [...makeWav(1)] },
  );
  await expect(page.locator("#file-name")).toHaveText("plain.wav");
  await expect(sentences(page)).toHaveText(["Just one line."]);
});
