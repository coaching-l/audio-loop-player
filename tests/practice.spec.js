import { test, expect } from "@playwright/test";
import { makePhrasesWav } from "./fixtures/make-audio.mjs";
const fixture = "tests/fixtures/tone.wav";
async function load(page, file = fixture) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function setPoints(page, a, b) {
  await page.locator("#point-a").fill(a);
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill(b);
  await page.locator("#point-b").press("Tab");
  await page.locator("#repeat-mode").selectOption("ab");
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
  await expect(page.locator("#repeat-mode")).toHaveValue("ab");
  await page.keyboard.press("r");
  await expect(page.locator("#repeat-mode")).toHaveValue("off");
  await page.keyboard.press("]");
  await expect(page.locator("#speed-value")).toHaveText("1.05×");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => currentTime(page)).toBeCloseTo(0, 1);
  await page.locator("#segment-name").fill("");
  await page.locator("#segment-name").pressSequentially("ab");
  await expect(page.locator("#segment-name")).toHaveValue("ab");
  await expect(page.locator("#point-a")).toHaveValue("0:01.000");
  await expect(page.locator("#speed-value")).toHaveText("1.05×");
});

test("the speed ramp raises the rate each repeat up to 1.0x and keeps the base rate", async ({
  page,
}) => {
  await page.goto("/");
  await load(page);
  await setPoints(page, "0.2", "0.5");
  await page.locator("#repeat-count").selectOption("3");
  await page.locator("#speed").evaluate((el) => {
    el.value = "0.9";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#ramp-step").selectOption("0.05");
  await page.locator("#audio").evaluate((audio) => {
    window.rates = [];
    audio.addEventListener("play", () => window.rates.push(audio.playbackRate));
  });
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了", {
    timeout: 10000,
  });
  expect(await page.evaluate(() => window.rates)).toEqual([0.9, 0.95, 1]);
  await expect(page.locator("#speed-value")).toHaveText("0.90×");
  await page.locator("#segment-name").fill("加速");
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await expect(page.locator(".segment .small")).toContainText("0.05倍ずつ速く");
  await page.reload();
  await page
    .getByRole("button", { name: "tone.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#ramp-step")).toHaveValue("0.05");
  await expect(page.locator("#speed-value")).toHaveText("0.90×");
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
  await expect(page.locator("#repeat-mode")).toHaveValue("ab");
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

test("a recording can be played back and compared with the model", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Only Chromium has a fake microphone in these tests.",
  );
  await page.goto("/");
  await load(page);
  await setPoints(page, "0.2", "0.6");
  await page.getByRole("button", { name: "録音する", exact: true }).click();
  await expect(page.locator("#record-status")).toContainText("録音中");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "録音を止める", exact: true }).click();
  await expect(page.locator("#record-status")).toHaveText("録音あり");
  await expect(page.locator("#play-recording")).toBeEnabled();
  await page.locator("#compare").click();
  await expect(page.locator("#record-status")).toHaveText("お手本を再生中");
  await expect(page.locator("#record-status")).toHaveText("自分の声を再生中", {
    timeout: 5000,
  });
  // The model stopped at B before the recording started.
  expect(await currentTime(page)).toBeGreaterThanOrEqual(0.55);
  expect(await playing(page)).toBe(false);
  await expect(page.locator("#record-status")).toHaveText("録音あり", {
    timeout: 5000,
  });
  // Opening other audio discards the recording; it was never stored.
  await load(page, "tests/fixtures/tone.mp3");
  await expect(page.locator("#record-status")).toHaveText("録音なし");
  await expect(page.locator("#compare")).toBeDisabled();
});
