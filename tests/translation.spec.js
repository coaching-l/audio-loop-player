import { test, expect } from "@playwright/test";
import { translationParts } from "../translation.js";
import { makeWav } from "./fixtures/make-audio.mjs";

test.use({ serviceWorkers: "block" });

// Legacy provider coverage remains explicit while production uses DeepL.
test.beforeEach(async ({ page }) => {
  await page.route("**/translation-config.js", route => route.fulfill({ contentType: "text/javascript", body: 'export const CONTEXT_TRANSLATION_URL = "";' }));
  await page.route("**/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("connect-src 'self'", "connect-src 'self' https://api.mymemory.translated.net") });
  });
});
const endpoint = "https://api.mymemory.translated.net/get**";
async function prepare(page, text = "Hello there. How are you?") {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({ name: "translation.wav", mimeType: "audio/wav", buffer: makeWav(4) });
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
  await page.locator("#transcript-paste").click();
  await page.locator("#transcript-input").fill(text);
  await page.locator('#transcript-editor button[type="submit"]').click();
  await expect(page.locator(".sentence").first()).toBeVisible();
}
async function fake(page, requests, handler) {
  await page.route(endpoint, async (route) => {
    const url = new URL(route.request().url());
    requests.push({ text: url.searchParams.get("q"), pair: url.searchParams.get("langpair") });
    if (handler) return handler(route);
    await route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: "こんにちは。" } } });
  });
}
async function hold(page, index = 0) {
  const sentence = page.locator(".sentence").nth(index);
  await sentence.scrollIntoViewIfNeeded();
  const box = await sentence.boundingBox();
  if (page.context().browser().browserType().name() === "chromium" &&
      await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 25, y: box.y + box.height / 2 }] });
    await expect(page.locator("#translation-dialog")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(box.x + 25, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.locator("#translation-dialog")).toBeVisible();
    await page.mouse.up();
  }
}

test("translation chunks respect UTF-8 limits without dropping text", () => {
  for (const text of ["Hello! ".repeat(170), "今天我们学习中文。😀".repeat(90), "𠮷".repeat(400)]) {
    const parts = translationParts(text);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(500);
  }
  expect(() => translationParts("a".repeat(5001))).toThrow("文が長すぎます");
});

test("a tap still selects a sentence; long press translates only that sentence without changing A-B", async ({ page }) => {
  const requests = [];
  await fake(page, requests);
  await prepare(page);
  await page.locator(".sentence").nth(1).click();
  await expect(page.locator(".sentence").nth(1)).toHaveClass(/is-selected/);
  expect(requests).toHaveLength(0);
  await hold(page);
  await expect(page.locator("#translation-result")).toHaveText("こんにちは。");
  await expect(page.locator(".sentence").nth(1)).toHaveClass(/is-selected/);
  expect(requests).toEqual([{ text: "Hello there.", pair: "en|ja" }]);
  await expect(page.locator("#translation-dialog")).toContainText("オンライン");
  await expect(page.locator("#translation-dialog")).toContainText("無料");
});

test("moving a touch to scroll cancels translation; keyboard and button can open it", async ({ page }) => {
  const requests = [];
  await fake(page, requests);
  await prepare(page);
  const sentence = page.locator(".sentence").first();
  await sentence.dispatchEvent("pointerdown", { isPrimary: true, pointerId: 2, button: 0, clientX: 40, clientY: 40, pointerType: "touch" });
  await sentence.dispatchEvent("pointermove", { isPrimary: true, pointerId: 2, clientX: 40, clientY: 85, pointerType: "touch" });
  await page.waitForTimeout(650);
  expect(requests).toHaveLength(0);
  await expect(page.locator("#translation-dialog")).not.toBeVisible();
  await sentence.focus();
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator("#translation-result")).toHaveText("こんにちは。");
  await page.locator("#translation-close").click();
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-status")).toHaveText("保存済みの日本語訳");
  expect(requests).toHaveLength(1);
});

test("Chinese uses the Chinese-Japanese pair and output is displayed as text", async ({ page }) => {
  const requests = [];
  await fake(page, requests, (route) => route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: "<img src=x onerror=alert(1)>こんにちは。" } } }));
  await prepare(page, "你好。今天过得怎么样？");
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-result")).toContainText("<img");
  await expect(page.locator("#translation-result img")).toHaveCount(0);
  expect(requests[0]).toEqual({ text: "你好。", pair: "zh-CN|ja" });
  await page.locator("#translation-language").selectOption("en");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].pair).toBe("en|ja");
});

test("saved translations survive reopening offline; new sentences explain that a connection is needed", async ({ page, context }) => {
  const requests = [];
  await fake(page, requests);
  await prepare(page);
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-status")).toContainText("保存しました");
  await page.reload();
  await page.locator("#audio-list .audio-open").first().click();
  await expect(page.locator(".sentence").first()).toBeVisible();
  await context.setOffline(true);
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-result")).toHaveText("こんにちは。");
  await expect(page.locator("#translation-status")).toHaveText("保存済みの日本語訳");
  await page.locator("#translation-close").click();
  await hold(page, 1);
  await expect(page.locator("#translation-status")).toContainText("オンライン");
  expect(requests).toHaveLength(1);
});

test("quota errors are explained without automatic retries or caching the error", async ({ page }) => {
  const requests = [];
  await fake(page, requests, (route) => route.fulfill({ json: { responseStatus: 403, quotaFinished: true, responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY" } } }));
  await prepare(page);
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-status")).toContainText("無料の利用上限");
  await expect(page.locator("#translation-result")).toBeEmpty();
  await expect(page.locator("#translation-retry")).toBeVisible();
  await page.locator("#translation-close").click();
  await page.locator("#transcript-translate").click();
  await expect.poll(() => requests.length).toBe(2);
});

test("closing or switching material cancels pending translation and never saves stale results", async ({ page }) => {
  const requests = [], pending = [];
  await fake(page, requests, (route) => { pending.push(route); });
  await prepare(page);
  await page.locator("#transcript-translate").click();
  await expect.poll(() => pending.length).toBe(1);
  await page.locator("#translation-close").click();
  await page.locator("#file-input").setInputFiles({ name: "other.wav", mimeType: "audio/wav", buffer: makeWav(3) });
  await expect(page.locator("#play")).toBeEnabled();
  await pending[0].fulfill({ json: { responseStatus: 200, responseData: { translatedText: "古い応答" } } }).catch(() => {});
  await expect(page.locator("#translation-dialog")).not.toBeVisible();
  const transcripts = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("kotonoha.transcript.v1:")).map((key) => localStorage.getItem(key)));
  expect(transcripts.join("")).not.toContain("古い応答");
});

test("editing source text does not reuse a previous translation", async ({ page }) => {
  const requests = [];
  await fake(page, requests);
  await prepare(page);
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-result")).toHaveText("こんにちは。");
  await page.locator("#translation-close").click();
  await page.locator("#transcript-edit").click();
  await page.locator("#transcript-input").fill("Good evening.");
  await page.locator('#transcript-editor button[type="submit"]').click();
  await page.locator("#transcript-translate").click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].text).toBe("Good evening.");
});

test("a late response cannot appear on a different material even when the dialog was open", async ({ page }) => {
  const requests = [], pending = [];
  await fake(page, requests, (route) => { pending.push(route); });
  await prepare(page);
  await page.locator("#transcript-translate").click();
  await expect.poll(() => pending.length).toBe(1);
  await page.locator("#file-input").setInputFiles({ name: "switched.wav", mimeType: "audio/wav", buffer: makeWav(3) });
  await expect(page.locator("#translation-dialog")).not.toBeVisible();
  await pending[0].fulfill({ json: { responseStatus: 200, responseData: { translatedText: "前の教材の訳" } } }).catch(() => {});
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#transcript-empty")).toBeVisible();
});

test("partial translations are not saved when a later chunk fails", async ({ page }) => {
  const requests = [];
  await fake(page, requests, (route) => requests.length === 1
    ? route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: "途中までの訳" } } })
    : route.fulfill({ status: 503, body: "Unavailable" }));
  await prepare(page, "This is a longer phrase without punctuation ".repeat(20));
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-status")).toContainText("接続できません");
  await expect(page.locator("#translation-result")).toBeEmpty();
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith("kotonoha.transcript.v1:"))
    .map((key) => localStorage.getItem(key)).join(""))).not.toContain("途中までの訳");
});

test("requests time out with a retry action and no retry is sent automatically", async ({ page }) => {
  const requests = [];
  await fake(page, requests, () => {});
  await prepare(page);
  await page.clock.install();
  await page.locator("#transcript-translate").click();
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(16000);
  await expect(page.locator("#translation-status")).toContainText("翻訳に時間がかかっています");
  await expect(page.locator("#translation-retry")).toBeVisible();
  expect(requests).toHaveLength(1);
});
