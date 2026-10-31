import { test, expect } from "@playwright/test";
import { makePhrasesWav } from "./fixtures/make-audio.mjs";
import { openAdvanced, setRepeat } from "./helpers.mjs";
const fixture = "tests/fixtures/tone.wav";
async function load(page, file = fixture) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function setPoints(page, a, b) {
  await openAdvanced(page);
  await page.locator("#point-a").fill(a);
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill(b);
  await page.locator("#point-b").press("Tab");
  await setRepeat(page, true);
}
const playing = (page) =>
  page.locator("#audio").evaluate((audio) => !audio.paused);
const currentTime = (page) =>
  page.locator("#audio").evaluate((audio) => audio.currentTime);

test("the page loads nothing outside its own files", async ({ page }) => {
  await page.addInitScript(() => {
    window.violations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.violations.push(event.violatedDirective + " " + event.blockedURI),
    );
  });
  await page.goto("/");
  await load(page);
  await page.locator("#play").click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0.2);
  await expect(page.locator("#waveform")).toBeVisible();
  expect(await page.evaluate(() => window.violations)).toEqual([]);
  // An inline script, as an injected one would be, is refused.
  const ran = await page.evaluate(() => {
    window.injected = false;
    const script = document.createElement("script");
    script.textContent = "window.injected = true";
    document.head.append(script);
    return window.injected;
  });
  expect(ran).toBe(false);
});

test("lock screen and headset buttons control the player", async ({ page }) => {
  await page.addInitScript(() => {
    window.mediaHandlers = {};
    if (navigator.mediaSession)
      navigator.mediaSession.setActionHandler = (action, handler) => {
        window.mediaHandlers[action] = handler;
      };
  });
  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "mediaSession" in navigator)),
    "This engine has no Media Session API.",
  );
  await load(page);
  expect(
    await page.evaluate(() => navigator.mediaSession.metadata?.title),
  ).toBe("tone.wav");
  await page.evaluate(() => window.mediaHandlers.play());
  await expect.poll(() => playing(page)).toBe(true);
  await page.evaluate(() => window.mediaHandlers.pause());
  await expect.poll(() => playing(page)).toBe(false);
  await page.evaluate(() => window.mediaHandlers.seekto({ seekTime: 2 }));
  await expect.poll(() => currentTime(page)).toBeCloseTo(2, 1);
  await page.evaluate(() => window.mediaHandlers.seekbackward({}));
  await expect.poll(() => currentTime(page)).toBeCloseTo(0, 1);
});

test("keyboard shortcuts work, except while typing", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Keyboard shortcuts are for computers.");
  await page.goto("/");
  await load(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await expect.poll(() => playing(page)).toBe(true);
  await page.keyboard.press("k");
  await expect.poll(() => playing(page)).toBe(false);
  await page.locator("#seek").evaluate((el) => {
    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("a");
  await expect(page.locator("#point-a")).toHaveValue("0:01.000");
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("r");
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.keyboard.press("]");
  await expect(page.locator("#speed-value")).toHaveText("1.05×");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => currentTime(page)).toBeCloseTo(0, 1);
  await page.getByRole("button", { name: "スクリプトを貼り付ける" }).click();
  await page.locator("#transcript-input").pressSequentially("ab");
  await expect(page.locator("#transcript-input")).toHaveValue("ab");
  await expect(page.locator("#point-a")).toHaveValue("0:01.000");
  await expect(page.locator("#speed-value")).toHaveText("1.05×");
});

test("the waveform finds phrases and steps through them as A–B intervals", async ({
  page,
}) => {
  await page.goto("/");
  await load(page, {
    name: "phrases.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(),
  });
  await expect(page.locator("#waveform")).toBeVisible();
  await expect(page.locator("#interval-gauge")).toHaveClass(/has-waveform/);
  await expect(page.locator("#phrase-actions")).toBeVisible();
  const interval = async () => [
    await page.locator("#point-a").inputValue(),
    await page.locator("#point-b").inputValue(),
  ];
  const seconds = (text) => {
    const [m, s] = text.split(":");
    return Number(m) * 60 + Number(s);
  };
  // Phrases sit at 0–0.5, 1.1–1.6 and 2.2–2.7 seconds.
  await page.locator("#next-phrase").click();
  let [a, b] = await interval();
  expect(seconds(a)).toBeGreaterThan(0.95);
  expect(seconds(a)).toBeLessThan(1.15);
  expect(seconds(b)).toBeGreaterThan(1.55);
  expect(seconds(b)).toBeLessThan(1.8);
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#next-phrase").click();
  [a] = await interval();
  expect(seconds(a)).toBeGreaterThan(2.05);
  await page.locator("#next-phrase").click();
  await expect(page.locator("#notice")).toContainText("最後の文");
  await page.locator("#prev-phrase").click();
  [a] = await interval();
  expect(seconds(a)).toBeGreaterThan(0.95);
  expect(seconds(a)).toBeLessThan(1.15);
  await page.locator("#prev-phrase").click();
  [a] = await interval();
  expect(seconds(a)).toBeLessThan(0.05);
});

test("with a script, the previous and next buttons step through its sentences", async ({
  page,
}) => {
  await page.goto("/");
  await load(page, {
    name: "phrases.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(),
  });
  await expect(page.locator("#waveform")).toBeVisible();
  await page.getByRole("button", { name: "スクリプトを貼り付ける" }).click();
  await page.locator("#transcript-input").fill("First. Second. Third.");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(page.locator(".sentence")).toHaveCount(3);
  // The same sentences as in the script: the buttons select them there too.
  await page.locator("#next-phrase").click();
  await expect(page.locator(".sentence.is-selected")).toHaveText("Second.");
  await page.locator("#next-phrase").click();
  await expect(page.locator(".sentence.is-selected")).toHaveText("Third.");
  await page.locator("#next-phrase").click();
  await expect(page.locator("#notice")).toContainText("最後の文");
  await page.locator("#prev-phrase").click();
  await expect(page.locator(".sentence.is-selected")).toHaveText("Second.");
  const a = Number(await page.locator("#marker-a").getAttribute("aria-valuenow"));
  expect(a).toBeGreaterThan(0.95);
  expect(a).toBeLessThan(1.15);
});

test("zooming the gauge spreads a short interval out for finer A and B", async ({
  page,
}) => {
  const seconds = (text) => {
    const [m, s] = text.split(":");
    return Number(m) * 60 + Number(s);
  };
  const seekRange = async () => [
    Number(await page.locator("#seek").getAttribute("min")),
    Number(await page.locator("#seek").getAttribute("max")),
  ];
  await page.goto("/");
  // 2.7 seconds long.
  await load(page, {
    name: "phrases.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(),
  });
  await setPoints(page, "1.1", "1.6");
  await expect(page.locator("#zoom-out")).toBeDisabled();
  await page.locator("#zoom-fit").click();
  // 0.2 s of margin on each side of A–B.
  let [min, max] = await seekRange();
  expect(min).toBeCloseTo(0.9, 2);
  expect(max).toBeCloseTo(1.8, 2);
  await expect(page.locator("#zoom-range")).toContainText("0:00.90–0:01.80");
  await expect(page.locator("#zoom-out")).toBeEnabled();
  // Half the gauge is now 0.45 s instead of 1.35 s.
  await page.locator("#marker-a").scrollIntoViewIfNeeded();
  const box = await page.locator("#marker-a").boundingBox();
  const rail = await page.locator(".interval-markers").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  expect(seconds(await page.locator("#point-a").inputValue())).toBeCloseTo(
    1.35,
    1,
  );
  await page.locator("#zoom-out").click();
  await page.locator("#zoom-out").click();
  await expect(page.locator("#zoom-range")).toHaveText("全体を表示中");
  await expect(page.locator("#zoom-out")).toBeDisabled();
  [min, max] = await seekRange();
  expect(min).toBe(0);
  expect(max).toBeCloseTo(2.7, 1);
});

test("a zoomed gauge follows playback past its edge", async ({ page }) => {
  await page.goto("/");
  await load(page, {
    name: "phrases.wav",
    mimeType: "audio/wav",
    buffer: makePhrasesWav(),
  });
  await openAdvanced(page);
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  expect(Number(await page.locator("#seek").getAttribute("min"))).toBe(0);
  await page.locator("#play").click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1);
  await expect
    .poll(async () => Number(await page.locator("#seek").getAttribute("min")))
    .toBeGreaterThan(0.3);
});
