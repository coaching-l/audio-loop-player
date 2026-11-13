import { CONTEXT_TRANSLATION_URL } from "../translation-config.js";
import { test, expect } from "@playwright/test";
import { makeWav } from "./fixtures/make-audio.mjs";

// Requests a service worker answers are not routed; this test checks the page's own cache.
test.use({ serviceWorkers: "block" });

test("context translation sends adjacent sentences, separates cached contexts and works offline", async ({ page, context }) => {
  // The page posts JSON, so a request to the Worker's own origin would first send a CORS
  // preflight. WebKit sent that preflight to the real Worker, which refuses this origin,
  // so no translation arrived. The test endpoint is on the page's own origin instead:
  // no preflight in any browser, and nothing reaches the production Worker.
  const TEST_PATH = "/__test-context-translation";
  await page.route("**/translation-config.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `export const CONTEXT_TRANSLATION_URL = new URL(${JSON.stringify(TEST_PATH)}, location.href).href;`,
  }));
  const production = [];
  await page.route(CONTEXT_TRANSLATION_URL, route => {
    production.push(route.request().method());
    return route.abort();
  });
  const requests = [];
  await page.route(`**${TEST_PATH}`, route => {
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
  expect(production).toEqual([]);
});
