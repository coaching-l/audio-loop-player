import { CONTEXT_TRANSLATION_URL } from "../translation-config.js";
import { test, expect } from "@playwright/test";
import { makeWav } from "./fixtures/make-audio.mjs";

test("context translation sends adjacent sentences, separates cached contexts and works offline", async ({ page, context }) => {
  const requests = [];
  await page.route(CONTEXT_TRANSLATION_URL, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { provider: "deepl-context-v1", translation: "今、どう受け止めていますか？" } });
  });
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({ name: "context.wav", mimeType: "audio/wav", buffer: makeWav(4) });
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#transcript-paste").click();
  await page.locator("#transcript-input").fill("A new possibility. How does that sit with you? Tell me more.");
  await page.locator('#transcript-editor button[type="submit"]').click();
  await page.locator(".sentence").nth(1).click();
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-result")).toContainText("受け止め");
  expect(requests).toEqual([{ source: "How does that sit with you?", language: "en", domain: "coaching", before: "A new possibility.", after: "Tell me more." }]);
  await expect(page.locator("#translation-dialog")).toContainText("Cloudflare");
  await expect(page.locator("#translation-provider-note")).toContainText("DeepL");
  await page.locator("#translation-domain").selectOption("general");
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator("#translation-status")).toContainText("保存しました");
  expect(requests[1].domain).toBe("general");
  await page.locator("#translation-close").click();
  await page.reload();
  await page.locator("#audio-list .audio-open").first().click();
  await expect(page.locator(".sentence").first()).toBeVisible();
  await page.locator(".sentence").nth(1).click();
  await context.setOffline(true);
  await page.locator("#transcript-translate").click();
  await expect(page.locator("#translation-status")).toHaveText("保存済みの日本語訳");
  expect(requests).toHaveLength(2);
  await page.locator("#translation-domain").selectOption("coaching");
  await expect(page.locator("#translation-status")).toContainText("オンライン");
  expect(requests).toHaveLength(2);
});
