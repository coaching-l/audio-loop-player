import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "../vendor/fflate/fflate.js";
import { planExport } from "../export.js";
import { pauseAfter } from "../audio-tools.js";
import { makePhrasesWav } from "./fixtures/make-audio.mjs";
import { openAdvanced, setRepeat } from "./helpers.mjs";

async function load(page, file) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function paste(page, text) {
  await page.getByRole("button", { name: "スクリプトを貼り付ける" }).click();
  await page.locator("#transcript-input").fill(text);
  await page.getByRole("button", { name: "保存する", exact: true }).click();
}
async function exported(page, kind, pauses = false) {
  await page.locator("#export-kind").selectOption(kind);
  await page.locator("#export-pauses").setChecked(pauses);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "MP3で書き出す" }).click(),
  ]);
  return {
    name: download.suggestedFilename(),
    bytes: await readFile(await download.path()),
  };
}
const isMp3 = (bytes) => bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;

test("the silence after a sentence is as long as the sentence, from 1 to 8 seconds", () => {
  expect(pauseAfter(0.3)).toBe(1);
  expect(pauseAfter(2.5)).toBe(2.5);
  expect(pauseAfter(12)).toBe(8);
});

test("export plans cut at sentence ends and add silences only between sentences", () => {
  const sentences = [
    { start: 0.2, end: 1 },
    { start: 1.5, end: 4 },
    { start: 4.5, end: 6 },
  ];
  expect(planExport({ kind: "all", duration: 7, sentences })).toEqual([
    { suffix: "", pieces: [{ from: 0, to: 7, pause: 0 }] },
  ]);
  expect(
    planExport({ kind: "all", duration: 7, sentences, withPauses: true }),
  ).toEqual([
    {
      suffix: "",
      pieces: [
        { from: 0, to: 1, pause: 1 },
        { from: 1, to: 4, pause: 2.5 },
        // The last sentence takes the rest of the audio, with nothing after it.
        { from: 4, to: 7, pause: 0 },
      ],
    },
  ]);
  expect(planExport({ kind: "2", duration: 7, sentences })).toEqual([
    { suffix: "_01", pieces: [{ from: 0, to: 4, pause: 0 }] },
    { suffix: "_02", pieces: [{ from: 4, to: 7, pause: 0 }] },
  ]);
  expect(
    planExport({ kind: "ab", duration: 7, sentences, a: 1.5, b: 2 }),
  ).toEqual([{ suffix: "_A-B", pieces: [{ from: 1.5, to: 2, pause: 0 }] }]);
  expect(() => planExport({ kind: "5", duration: 7, sentences: [] })).toThrow();
});

test("the audio is written out as MP3: whole, A–B, and a few sentences per file in a ZIP", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await load(page, "tests/fixtures/tone.wav");
  await openAdvanced(page);
  // Without a script, only the whole audio and A–B can be written out.
  await expect(page.locator('#export-kind option[value="5"]')).toBeDisabled();
  await expect(page.locator("#export-pauses")).toBeDisabled();
  let file = await exported(page, "all");
  expect(file.name).toBe("tone.mp3");
  expect(isMp3(file.bytes)).toBe(true);
  const plain = file.bytes.length;
  await paste(page, "One. Two. Three. Four. Five. Six. Seven.");
  await expect(page.locator('#export-kind option[value="5"]')).toBeEnabled();
  file = await exported(page, "all", true);
  // Six silences of at least 1 second make it much longer.
  expect(file.bytes.length).toBeGreaterThan(plain * 2);
  file = await exported(page, "5");
  // (Headless Chromium here drops non-ASCII download names; the page names it.)
  await expect(page.locator("#export-status")).toContainText("tone_5文ごと.zip");
  const zip = unzipSync(new Uint8Array(file.bytes));
  expect(Object.keys(zip).sort()).toEqual(["tone_01.mp3", "tone_02.mp3"]);
  expect(Object.values(zip).every(isMp3)).toBe(true);
  await page.locator("#point-a").fill("0.5");
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill("1");
  await page.locator("#point-b").press("Tab");
  await page.locator("#export-kind").selectOption("ab");
  await expect(page.locator("#export-pauses")).toBeDisabled();
  file = await exported(page, "ab");
  expect(file.name).toBe("tone_A-B.mp3");
  expect(file.bytes.length).toBeLessThan(plain / 3);
  await expect(page.locator("#export-status")).toContainText("書き出しました");
});

// Times the media element's pause and the play that follows it.
async function traceStop(page) {
  await page.locator("#audio").evaluate((audio) => {
    window.mediaTrace = [];
    for (const type of ["play", "pause"])
      audio.addEventListener(type, () =>
        window.mediaTrace.push({
          type,
          at: performance.now(),
          time: audio.currentTime,
        }),
      );
  });
}
async function firstSilence(page) {
  const trace = await page.evaluate(() => window.mediaTrace);
  const stop = trace.find((x) => x.type === "pause");
  const resume = trace.find((x) => x.type === "play" && x.at > stop.at);
  return { stop, resume, ms: resume.at - stop.at };
}
const mode = (page, name) => page.getByRole("button", { name, exact: true });

test("repeating stops after each sentence, even without a script, and is kept", async ({
  page,
}) => {
  await page.goto("/");
  // Tones at 0–0.5, 1.1–1.6 and 2.2–2.7 seconds.
  await load(page, {
    name: "phrases.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(),
  });
  await expect(page.locator("#waveform")).toBeVisible();
  // New material starts with shadowing: no silences.
  await expect(mode(page, "シャドーイング")).toHaveAttribute("aria-pressed", "true");
  await setRepeat(page, false);
  await mode(page, "リピーティング").click();
  await expect(mode(page, "リピーティング")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#practice-mode-help")).toContainText("1.5倍");
  // No script: the waveform's phrases are the sentences.
  await traceStop(page);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await expect(page.locator("#play-status")).toHaveText("再生中", {
    timeout: 3000,
  });
  const { stop, resume, ms } = await firstSilence(page);
  // The first phrase is short, so 1.5 times it is about the 1-second minimum.
  expect(ms).toBeGreaterThanOrEqual(950);
  expect(ms).toBeLessThan(2000);
  // It goes on from where it stopped, not from the start.
  expect(resume.time).toBeGreaterThan(0.4);
  expect(Math.abs(resume.time - stop.time)).toBeLessThan(0.1);
  await page.locator("#play").click();
  // The choice is kept with the audio.
  await page.reload();
  await page.getByRole("button", { name: "phrases.wavを開く" }).click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(mode(page, "リピーティング")).toHaveAttribute("aria-pressed", "true");
  // Shadowing plays straight through the same place.
  await mode(page, "シャドーイング").click();
  await page.locator("#audio").evaluate((audio) => (audio.currentTime = 0));
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(1.2);
  await expect(page.locator("#play-status")).toHaveText("再生中");
});

test("repeating an interval leaves a silence 1.5 times as long, changeable in the settings", async ({
  page,
}) => {
  await page.goto("/");
  await load(page, "tests/fixtures/tone.wav");
  await mode(page, "リピーティング").click();
  await openAdvanced(page);
  await expect(page.locator("#gap-mode")).toHaveValue("1.5");
  await page.locator("#point-b").fill("0.8");
  await page.locator("#point-b").press("Tab");
  await setRepeat(page, true);
  await traceStop(page);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await expect(page.locator("#play-status")).toHaveText("再生中", {
    timeout: 3000,
  });
  // 0.8 seconds of interval, then 1.2 seconds of silence.
  const { ms } = await firstSilence(page);
  expect(ms).toBeGreaterThanOrEqual(1100);
  expect(ms).toBeLessThan(1700);
  await page.locator("#play").click();
  // Back to shadowing, the interval repeats with no silence, and the length is kept.
  await mode(page, "シャドーイング").click();
  await expect(page.locator("#gap-mode")).toHaveValue("1.5");
  // Choosing a silence in the settings is choosing to repeat.
  await page.locator("#gap-mode").selectOption("2");
  await expect(mode(page, "リピーティング")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#practice-mode-help")).toContainText("2倍");
});
