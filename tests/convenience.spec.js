import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const fixture = "tests/fixtures/tone.wav";
async function load(page) {
  await page.locator("#file-input").setInputFiles(fixture);
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
async function saveSegment(page, name) {
  await page.locator("#point-a").fill("0.5");
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill("1.5");
  await page.locator("#point-b").press("Tab");
  await page.locator("#segment-name").fill(name);
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await expect(page.locator(".segment-name")).toContainText([name]);
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

test("a deleted segment can be restored with the undo bar", async ({
  page,
}) => {
  await load(page);
  await saveSegment(page, "残したい区間");
  await page
    .getByRole("button", { name: "残したい区間を削除", exact: true })
    .click();
  await expect(page.locator(".segment")).toHaveCount(0);
  await expect(page.locator("#undo-message")).toContainText("残したい区間");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator("#undo-bar")).toBeHidden();
  await expect(page.locator(".segment-name")).toHaveText("残したい区間");
  await page.reload();
  await page
    .getByRole("button", { name: "tone.wavを開く", exact: true })
    .click();
  await expect(page.locator(".segment-name")).toHaveText("残したい区間");
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
  await saveSegment(page, "一つ目");
  await saveSegment(page, "二つ目");
  await page.getByRole("button", { name: "一つ目を削除", exact: true }).click();
  await page.getByRole("button", { name: "二つ目を削除", exact: true }).click();
  await expect(page.locator("#undo-message")).toContainText("二つ目");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(".segment-name")).toHaveText(["二つ目"]);
});

test("a backup of segments moves them to another browser", async ({
  page,
  browser,
}) => {
  await load(page);
  await saveSegment(page, "持ち運ぶ区間");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "バックアップを保存", exact: true })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^coachingl-audio-loop_data_\d{4}-\d{2}-\d{2}\.json$/,
  );
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(backup.app).toBe("coachingl-audio-loop");
  await expect(page.locator("#backup-status")).toContainText("1件");

  const other = await browser.newContext();
  const fresh = await other.newPage();
  await fresh.goto("/");
  await fresh.locator("#import-backup").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(fresh.locator("#backup-status")).toContainText(
    "1件読み込みました",
  );
  await fresh.locator("#import-backup").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(fresh.locator("#backup-status")).toContainText(
    "足すものはありません",
  );
  // The same audio file (name, size and date) picks the segments up.
  await fresh.locator("#file-input").setInputFiles(fixture);
  await expect(fresh.locator("#play")).toBeEnabled();
  await expect(fresh.locator(".segment-name")).toHaveText("持ち運ぶ区間");
  await other.close();
});

test("a file that is not a backup is rejected without changing anything", async ({
  page,
}) => {
  await page.locator("#import-backup").setInputFiles({
    name: "other.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"records": []}'),
  });
  await expect(page.locator("#backup-status")).toContainText(
    "このアプリのバックアップではない",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("kotonoha.audio.v1")),
  ).toBeNull();
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
