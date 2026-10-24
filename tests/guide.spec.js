import { test, expect } from "@playwright/test";
test("usage guide is collapsed at the bottom and explains storage and practice", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#usage-guide")).not.toHaveAttribute("open", "");
  expect(
    await page.evaluate(
      () =>
        document
          .querySelector("#usage-guide")
          .compareDocumentPosition(document.querySelector(".workspace")) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ),
  ).toBeTruthy();
  await expect(page.locator("#offline-status")).not.toBeVisible();
  await page.locator("#usage-guide > summary").click();
  await expect(page.locator(".usage-body")).toBeVisible();
  await expect(page.locator(".usage-body")).toContainText("端末・ブラウザ内");
  await expect(page.locator(".usage-body")).toContainText("通信なしで起動");
  await expect(page.locator(".usage-body")).toContainText("A・B");
  await expect(page.locator(".usage-body")).not.toContainText("iPhone");
  await expect(page.locator(".usage-body")).not.toContainText("Safari");
  await page.locator("#usage-guide > summary").click();
  await expect(page.locator(".usage-body")).not.toBeVisible();
  await expect(page.locator('label[for="file-input"]')).toHaveText(
    "ファイルを選択",
  );
  expect(
    await page.locator("#file-input").getAttribute("accept"),
  ).not.toContain("audio/*");
});
test("manual load action has spacing and is centered on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // Surface the conditional action to inspect layout, independently of decoder speed.
  await page
    .locator("#load-audio")
    .evaluate((button) => (button.hidden = false));
  const box = await page.locator("#load-audio").boundingBox();
  const library = await page.locator(".audio-library").boundingBox();
  expect(box.y - (library.y + library.height)).toBeGreaterThanOrEqual(20);
  expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(2);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator("body")).not.toContainText("iPhoneで選べない");
});
