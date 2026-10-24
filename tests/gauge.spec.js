import { test, expect } from "@playwright/test";
async function open(page) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#play")).toBeEnabled();
}
async function drag(page, point, fraction) {
  await page.locator("#marker-" + point).scrollIntoViewIfNeeded();
  const marker = await page.locator("#marker-" + point).boundingBox();
  const rail = await page.locator(".interval-markers").boundingBox();
  await page.mouse.move(
    marker.x + marker.width / 2,
    marker.y + marker.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rail.x + rail.width * fraction,
    marker.y + marker.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
}
test("drag A and B on the audio gauge, persist, and replay the selected interval", async ({
  page,
}) => {
  await open(page);
  await drag(page, "b", 0.6);
  await drag(page, "a", 0.2);
  await expect(page.locator("#repeat-mode")).toHaveValue("ab");
  expect(
    Number(await page.locator("#marker-a").getAttribute("aria-valuenow")),
  ).toBeCloseTo(0.6, 1);
  expect(
    Number(await page.locator("#marker-b").getAttribute("aria-valuenow")),
  ).toBeCloseTo(1.8, 1);
  const a = await page.locator("#point-a").inputValue();
  const b = await page.locator("#point-b").inputValue();
  await page.reload();
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.wav");
  await expect(page.locator("#point-a")).toHaveValue(a);
  await expect(page.locator("#point-b")).toHaveValue(b);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了", {
    timeout: 10000,
  });
  await expect(page.locator("#repeat-progress")).toHaveText("完了 2 / 2 回");
  await page.locator("#toggle-ab").click();
  await expect(page.locator("#repeat-mode")).toHaveValue("off");
});
test("gauge handles cannot cross, support keyboard, and follow direct time input", async ({
  page,
}) => {
  await open(page);
  await drag(page, "b", 0.5);
  await drag(page, "a", 1);
  const a = Number(
    await page.locator("#marker-a").getAttribute("aria-valuenow"),
  );
  const b = Number(
    await page.locator("#marker-b").getAttribute("aria-valuenow"),
  );
  expect(a).toBeLessThan(b);
  await page.locator("#marker-a").press("Home");
  await expect(page.locator("#point-a")).toHaveValue("0:00.000");
  await page.locator("#marker-a").press("ArrowRight");
  await expect(page.locator("#point-a")).toHaveValue("0:00.100");
  await page.locator("#point-b").fill("2");
  await page.locator("#point-b").press("Tab");
  await expect(page.locator("#marker-b")).toHaveAttribute("aria-valuenow", "2");
  await page.locator("#marker-b").press("Home");
  expect(
    Number(await page.locator("#marker-b").getAttribute("aria-valuenow")),
  ).toBeGreaterThan(0.1);
});
test("touch dragging changes the interval without scrolling the page", async ({
  page,
  isMobile,
  browserName,
}) => {
  test.skip(
    !isMobile || browserName !== "chromium",
    "Real touch injection via Chromium CDP for mobile project",
  );
  await open(page);
  await page.locator("#marker-b").scrollIntoViewIfNeeded();
  const marker = await page.locator("#marker-b").boundingBox();
  const rail = await page.locator(".interval-markers").boundingBox();
  const before = await page.evaluate(() => scrollY);
  const session = await page.context().newCDPSession(page);
  const touch = (x) => [
    { x, y: marker.y + marker.height / 2, id: 1, radiusX: 3, radiusY: 3 },
  ];
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touch(marker.x + marker.width / 2),
  });
  for (let i = 1; i <= 8; i++)
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touch(rail.x + rail.width * (1 - i * 0.06)),
    });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  expect(
    Number(await page.locator("#marker-b").getAttribute("aria-valuenow")),
  ).toBeCloseTo(1.56, 1);
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await expect(page.locator("#range-error")).toBeHidden();
  await session.detach();
});
test("dragging pauses playback, resumes on release, and cannot restart a switched file", async ({
  page,
}) => {
  await open(page);
  await page.locator("#play").click();
  await page.locator("#marker-a").scrollIntoViewIfNeeded();
  let box = await page.locator("#marker-a").boundingBox();
  let rail = await page.locator(".interval-markers").boundingBox();
  await page.mouse.move(box.x + 22, box.y + 22);
  await page.mouse.down();
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  await page.mouse.move(rail.x + rail.width * 0.1, box.y + 22, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#play-status")).toHaveText("再生中");
  box = await page.locator("#marker-a").boundingBox();
  await page.mouse.move(box.x + 22, box.y + 22);
  await page.mouse.down();
  await page.locator("#file-input").setInputFiles("tests/fixtures/tone.mp3");
  await expect(page.locator("#play")).toBeEnabled();
  await page.mouse.move(box.x + 30, box.y + 22);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(
    await page
      .locator("#audio")
      .evaluate((a) => a.paused && a.currentTime === 0),
  ).toBe(true);
});
