import { test, expect } from "@playwright/test";
import { makeWav } from "./fixtures/make-audio.mjs";
import { openAdvanced, setRepeat } from "./helpers.mjs";

const short = { name: "whole.wav", mimeType: "audio/wav", buffer: makeWav(0.65) };
async function load(page, file = short) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function trace(page) {
  await page.locator("#audio").evaluate((audio) => {
    window.starts = [];
    audio.addEventListener("play", () => window.starts.push(audio.currentTime));
  });
}
const starts = (page) => page.evaluate(() => window.starts);
test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("one-tap whole repeat loops real audio from zero; pause and OFF stop repetition", async ({ page }) => {
  await load(page);
  await trace(page);
  await page.locator("#toggle-whole").click();
  await expect(page.locator("#advanced")).not.toHaveAttribute("open", "");
  expect(await page.locator("#audio").evaluate(a => a.paused)).toBe(true);
  await page.locator("#play").click();
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThanOrEqual(3);
  await page.locator("#play").click();
  const pausedCount = (await starts(page)).length;
  await page.waitForTimeout(800);
  expect((await starts(page)).length).toBe(pausedCount);
  expect((await starts(page)).every(t => t < 0.15)).toBe(true);
  await page.locator("#toggle-whole").click();
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了");
  const endedCount = (await starts(page)).length;
  await page.waitForTimeout(800);
  expect((await starts(page)).length).toBe(endedCount);
});

test("completed shadowing offers replay, and enabling whole repeat after completion starts immediately", async ({ page }) => {
  await load(page);
  await trace(page);
  await expect(page.locator("#replay-whole")).toBeHidden();
  await page.locator("#play").click();
  await expect(page.locator("#replay-whole")).toBeVisible();
  await page.locator("#replay-whole").click();
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  await expect(page.locator("#replay-whole")).toBeVisible();
  await page.locator("#toggle-whole").click();
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThanOrEqual(4);
  expect((await starts(page)).every(t => t < 0.15)).toBe(true);
});

test("whole MP3 playback stops at the chosen count and replay resets the count", async ({ page }) => {
  await load(page, "tests/fixtures/tone.mp3");
  await openAdvanced(page);
  await page.locator("#repeat-count").selectOption("2");
  await trace(page);
  await page.locator("#toggle-whole").click();
  await expect(page.locator("#whole-repeat-help")).toContainText("2回");
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了", { timeout: 12000 });
  expect((await starts(page)).length).toBe(2);
  await expect(page.locator("#repeat-progress")).toHaveText("完了 2 / 2 回");
  await page.locator("#replay-whole").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了", { timeout: 12000 });
  expect((await starts(page)).length).toBe(4);
});

test("whole and A–B are exclusive without losing the saved interval", async ({ page }) => {
  await load(page);
  await openAdvanced(page);
  await page.locator("#point-a").fill("0.1");
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill("0.3");
  await page.locator("#point-b").press("Tab");
  await page.locator("#repeat-count").selectOption("2");
  await setRepeat(page, true);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了");
  await trace(page);
  await page.locator("#toggle-whole").click();
  await expect(page.locator("#toggle-ab")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#point-a")).toHaveValue("0:00.100");
  await expect(page.locator("#point-b")).toHaveValue("0:00.300");
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThanOrEqual(1);
  expect((await starts(page))[0]).toBeLessThan(0.1);
  await expect.poll(() => page.locator("#audio").evaluate(a => a.currentTime)).toBeGreaterThan(0.35);
  await expect.poll(async () => (await starts(page)).length).toBeGreaterThanOrEqual(2);
  await setRepeat(page, true);
  await expect(page.locator("#toggle-whole")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#point-b")).toHaveValue("0:00.300");
});

test("switching practice mode or choosing a silence exits whole shadowing", async ({ page }) => {
  await load(page);
  await page.locator("#toggle-whole").click();
  await page.locator('[data-mode="repeating"]').click();
  await expect(page.locator("#whole-repeat-controls")).toBeHidden();
  await page.locator('[data-mode="shadowing"]').click();
  await expect(page.locator("#toggle-whole")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#toggle-whole").click();
  await openAdvanced(page);
  await page.locator("#gap-mode").selectOption("2");
  await expect(page.locator('[data-mode="repeating"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#toggle-whole")).toHaveAttribute("aria-pressed", "false");
});

test("whole repeat is saved per material, and changing files cancels the old loop", async ({ page }) => {
  await load(page);
  await page.locator("#toggle-whole").click();
  await page.locator("#play").click();
  await load(page, { ...short, name: "other.wav", buffer: makeWav(1) });
  await expect(page.locator("#toggle-whole")).toHaveAttribute("aria-pressed", "false");
  await trace(page);
  await page.waitForTimeout(1500);
  expect(await starts(page)).toEqual([]);
  expect(await page.locator("#audio").evaluate(a => a.paused)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "whole.wavを開く", exact: true }).click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#toggle-whole")).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator("#audio").evaluate(a => a.paused)).toBe(true);
});
