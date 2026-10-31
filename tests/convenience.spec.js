import { test, expect } from "@playwright/test";
const fixture = "tests/fixtures/tone.wav";
async function load(page) {
  await page.locator("#file-input").setInputFiles(fixture);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
const playing = (page) =>
  page.locator("#audio").evaluate((audio) => !audio.paused);
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("dragging the position slider holds playback and resumes on release", async ({
  page,
}) => {
  await load(page);
  await page.locator("#play").click();
  await expect.poll(() => playing(page)).toBe(true);
  await page.locator("#seek").dispatchEvent("pointerdown");
  for (const value of ["0.5", "1", "1.5"])
    await page.locator("#seek").evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  expect(await playing(page)).toBe(false);
  await page.locator("#seek").dispatchEvent("pointerup");
  await expect.poll(() => playing(page)).toBe(true);
  expect(
    await page.locator("#audio").evaluate((a) => a.currentTime),
  ).toBeGreaterThanOrEqual(1.5);
});

test("hiding the page saves the playback position", async ({ page }) => {
  await load(page);
  // Keyboard-style seek: input only, no change event and no pause.
  await page.locator("#seek").evaluate((el) => {
    el.value = "1.7";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const saved = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem("kotonoha.audio.v1"))),
  );
  expect(saved[0].position).toBeCloseTo(1.7, 1);
});

test("deleted audio can be restored and still plays after reload", async ({
  page,
}) => {
  await load(page);
  await page
    .getByRole("button", { name: "tone.wavの音声を削除", exact: true })
    .click();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(0);
  await expect(page.locator("#play")).toBeDisabled();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await expect(page.locator("#library-status")).toContainText("元に戻しました");
  await page.reload();
  await page
    .getByRole("button", { name: "tone.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
});

test("a new deletion replaces the older undo, which then stays deleted", async ({
  page,
}) => {
  await load(page);
  await page.getByRole("button", { name: "スクリプトを貼り付ける" }).click();
  await page.locator("#transcript-input").fill("One. Two.");
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await page.getByRole("button", { name: "スクリプトを消す" }).click();
  await expect(page.locator("#undo-message")).toContainText("スクリプト");
  await page
    .getByRole("button", { name: "tone.wavの音声を削除", exact: true })
    .click();
  await expect(page.locator("#undo-message")).toContainText("tone.wav");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await page
    .getByRole("button", { name: "tone.wavを開く", exact: true })
    .click();
  await expect(page.locator("#transcript-status")).toHaveText("スクリプトなし");
});

test("settings saved by earlier versions still open", async ({ page }) => {
  await load(page);
  // Reopen the page with no audio open, so leaving it saves nothing over the old settings.
  await page.reload();
  // Earlier versions could repeat the whole audio, speed up each time and name segments.
  await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem("kotonoha.audio.v1"));
    const key = Object.keys(library)[0];
    library[key] = {
      settings: {
        mode: "all",
        a: 0.5,
        b: 1.5,
        limit: 3,
        gap: 0.2,
        gapRatio: 0,
        rampStep: 0.1,
        rate: 0.8,
      },
      segments: [{ id: "x", name: "以前の区間", mode: "ab", a: 0.5, b: 1 }],
      position: 0.7,
    };
    localStorage.setItem("kotonoha.audio.v1", JSON.stringify(library));
  });
  await page.reload();
  await page
    .getByRole("button", { name: "tone.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#speed-value")).toHaveText("0.80×");
  await expect(page.locator("#repeat-count")).toHaveValue("3");
  await expect(page.locator("#point-a")).toHaveValue("0:00.500");
  // What the screen no longer shows is kept as it was saved.
  const saved = await page.evaluate(
    () => Object.values(JSON.parse(localStorage.getItem("kotonoha.audio.v1")))[0],
  );
  expect(saved.segments[0].name).toBe("以前の区間");
  expect(saved.settings.mode).toBe("off");
});

test("the mini player appears when the main controls scroll away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await load(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("#mini-player")).toBeHidden();
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(page.locator("#mini-player")).toBeVisible();
  await expect(page.locator("#mini-name")).toHaveText("tone.wav");
  await page
    .getByRole("button", { name: "下のバー：再生", exact: true })
    .click();
  await expect.poll(() => playing(page)).toBe(true);
  await expect(page.locator("#mini-play")).toHaveAttribute(
    "data-state",
    "playing",
  );
  await page
    .getByRole("button", { name: "下のバー：一時停止", exact: true })
    .click();
  await expect.poll(() => playing(page)).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator("#play").scrollIntoViewIfNeeded();
  await expect(page.locator("#mini-player")).toBeHidden();
});
