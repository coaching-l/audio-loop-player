import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(!isMobile, "Touch scenarios require a mobile browser project.");
  await page.goto("/");
});

test("touch file selection, playback, skip and speed control", async ({
  page,
}) => {
  const choosing = page.waitForEvent("filechooser");
  await page.locator('label[for="file-input"]').tap();
  await (await choosing).setFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").tap();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
  await page.locator("#play").tap();
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#forward").tap();
  expect(await page.locator("#audio").evaluate((a) => a.currentTime)).toBe(3);
  await page.locator("#back").tap();
  expect(await page.locator("#audio").evaluate((a) => a.currentTime)).toBe(0);
  const speed = page.locator("#speed");
  const bounds = await speed.boundingBox();
  await speed.tap({ position: { x: bounds.width - 12, y: bounds.height / 2 } });
  expect(
    await page.locator("#audio").evaluate((a) => a.playbackRate),
  ).toBeGreaterThanOrEqual(1.8);
  await page.locator("#normal-speed").tap();
  await expect(page.locator("#speed-value")).toHaveText("1.00×");
});

test("touch pause during silence and landscape layout", async ({
  page,
}) => {
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#advanced > summary").tap();
  await page.locator("#point-b").fill("0.3");
  await page.locator("#gap").tap(); // blur commits the interval through a touch gesture
  await page.locator("#gap").fill("1");
  await page.locator("#toggle-ab").tap();
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#play").tap();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await page.locator("#play").tap();
  await expect(page.locator("#play-status")).toHaveText("無音中に一時停止");
  await page.waitForTimeout(1100);
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
