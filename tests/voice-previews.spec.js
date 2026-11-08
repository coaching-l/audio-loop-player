import { test, expect } from "@playwright/test";
import { VOICES } from "../voices.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openAdvanced } from "./helpers.mjs";

test.use({ serviceWorkers: "block" });

test("every real voice MP3 plays with one tap, without TTS or changing the draft", async ({ page }) => {
  await page.addInitScript(() => {
    window.previewWorkers = 0;
    const Worker = window.Worker;
    window.Worker = class extends Worker { constructor(...args) { super(...args); window.previewWorkers++; } };
  });
  const modelRequests = [];
  page.on("request", (r) => { if (/huggingface|tts-worker|onnxruntime|pinyin-pro/.test(r.url())) modelRequests.push(r.url()); });
  await page.goto("/");
  await page.locator("#entry-text").click();
  await page.locator("#voice-previews summary").click();
  const manifest = JSON.parse(readFileSync("voice-previews/manifest.json", "utf8"));
  for (const lang of ["en", "zh"]) {
    await page.locator("#tts-lang").selectOption(lang);
    await page.locator("#tts-text").fill("Keep this draft unchanged.");
    const selected = await page.locator("#tts-voice").inputValue();
    for (const voice of VOICES.filter((v) => v.lang === lang)) {
      const start = Date.now();
      await page.locator(`[data-voice="${voice.id}"]`).click();
      await expect.poll(() => page.locator("#voice-preview-audio").evaluate((a) => a.currentTime), { timeout: 2000 }).toBeGreaterThan(0);
      console.log(`${voice.id}: first playback within ${Date.now() - start}ms (local server)`);
      await expect(page.locator("#tts-voice")).toHaveValue(selected);
      await expect(page.locator("#tts-text")).toHaveValue("Keep this draft unchanged.");
      const clip = manifest.clips.find((c) => c.id === voice.id);
      const bytes = readFileSync("voice-previews/" + clip.file);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(clip.sha256);
    }
  }
  expect(modelRequests).toEqual([]);
  expect(await page.evaluate(() => window.previewWorkers)).toBe(0);
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(0);
});

test("preview stops on another voice, stop, collapse, language change and leaving the entry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#entry-text").click();
  await page.locator("#voice-previews summary").click();
  const first = page.locator('[data-voice="af_heart"]');
  const second = page.locator('[data-voice="af_bella"]');
  const paused = () => page.locator("#voice-preview-audio").evaluate((a) => a.paused);
  await first.click();
  await second.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await second.click();
  expect(await paused()).toBe(true);
  await first.click();
  await page.locator("#voice-previews summary").click();
  // Native details dispatches toggle asynchronously after changing open.
  await expect.poll(paused).toBe(true);
  await page.locator("#voice-previews summary").click();
  await first.click();
  await page.locator("#tts-lang").selectOption("zh");
  expect(await paused()).toBe(true);
  await page.locator('[data-voice="zm_011"]').click();
  await page.locator("#entry-audio").click();
  expect(await paused()).toBe(true);
});

test("failed sample gives a useful retry, and a successful sample ends cleanly", async ({ page }) => {
  await page.route("**/voice-previews/af_heart.mp3", (r) => r.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await page.locator("#entry-text").click();
  await page.locator("#voice-previews summary").click();
  const play = page.locator('[data-voice="af_heart"]');
  await play.click();
  await expect(page.locator("#voice-preview-status")).toContainText("試聴できませんでした");
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await page.unroute("**/voice-previews/af_heart.mp3");
  await play.click();
  await expect(page.locator("#voice-preview-status")).toContainText("試聴中");
  // Let the real five-second MP3 finish, without seeking on the simple test server.
  await expect(play).toHaveAttribute("aria-pressed", "false", { timeout: 10000 });
});

test("preview and practice do not overlap, and recording blocks preview", async ({ page, browserName }) => {
  await page.goto("/");
  await page.locator("#entry-audio").click();
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await page.locator("#entry-text").click();
  await page.locator("#voice-previews summary").click();
  await page.locator('[data-voice="af_heart"]').click();
  await expect(page.locator("#voice-preview-status")).toContainText("試聴中");
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#play").click();
  await expect.poll(() => page.locator("#voice-preview-audio").evaluate((a) => a.paused)).toBe(true);
  // The project's fake microphone is available only in Chromium. The playback
  // interaction above still runs in WebKit; real microphone access is a device check.
  if (browserName !== "chromium") return;
  await openAdvanced(page);
  await page.locator("#record").click();
  await expect(page.locator("#record-status")).toContainText("録音中");
  await page.locator('[data-voice="af_heart"]').click();
  await expect(page.locator("#voice-preview-status")).toContainText("録音を止めてから");
  expect(await page.locator("#voice-preview-audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#record").click();
});
