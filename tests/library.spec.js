import { test, expect } from "@playwright/test";
import { openAdvanced, setRepeat } from "./helpers.mjs";
import { makeWav } from "./fixtures/make-audio.mjs";
const files = (count) =>
  Array.from({ length: count }, (_, i) => ({
    name: `lesson-${i + 1}.wav`,
    mimeType: "audio/wav",
    buffer: makeWav(3, 440 + i * 20),
  }));
async function add(page, count = 3) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(files(count));
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(
    Math.min(count, 10),
  );
  await expect(page.locator("#library-status")).not.toContainText("保存中");
}
test("ten real audio files persist and reopen without selecting local files again", async ({
  page,
}) => {
  await add(page, 10);
  await expect(page.locator("#audio-count")).toHaveText("10 / 10件");
  await page
    .getByRole("button", { name: "lesson-4.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await openAdvanced(page);
  await page.locator("#point-b").fill("1.5");
  await page.locator("#point-b").press("Tab");
  await page.locator("#seek").evaluate((el) => {
    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page
    .getByRole("button", { name: "lesson-5.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#point-b")).toHaveValue("0:03.000");
  await page.reload();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(10);
  await page
    .getByRole("button", { name: "lesson-4.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#point-b")).toHaveValue("0:01.500");
  expect(
    await page.locator("#audio").evaluate((a) => a.currentTime),
  ).toBeCloseTo(1, 1);
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(1.1);
});
test("batch cap does not overwrite files, duplicate files are reused, and deleting releases a slot", async ({
  page,
}) => {
  await add(page, 11);
  await expect(page.locator("#library-status")).toContainText("10件まで");
  await page.reload();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(10);
  // Reopen the persisted File with its original metadata to test exact deduplication.
  await page.evaluate(async () => {
    const m = await import("/audio-library.js");
    const saved = await m.listAudio();
    await m.addAudio(m.storedFile(saved[0]));
  });
  await page.reload();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(10);
  await page
    .getByRole("button", { name: "lesson-1.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await page
    .getByRole("button", { name: "lesson-1.wavの音声を削除", exact: true })
    .click();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(9);
  await expect(page.locator("#play")).toBeDisabled();
  await page.locator("#file-input").setInputFiles({
    name: "replacement.wav",
    mimeType: "audio/wav",
    buffer: makeWav(),
  });
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(10);
  await expect(page.locator("#library-status")).not.toContainText("保存中");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "lesson-1.wavを開く", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "replacement.wavを開く", exact: true }),
  ).toBeVisible();
});
test("switching registered audio cancels pending silence and keeps per-file settings", async ({
  page,
}) => {
  await add(page, 2);
  await openAdvanced(page);
  await page.locator("#point-b").fill(".3");
  await page.locator("#point-b").press("Tab");
  await page.locator("#gap").fill("1");
  await page.locator("#gap").press("Tab");
  await setRepeat(page, true);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await page
    .getByRole("button", { name: "lesson-2.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await page.waitForTimeout(1200);
  expect(
    await page
      .locator("#audio")
      .evaluate((a) => a.paused && a.currentTime === 0),
  ).toBe(true);
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page
    .getByRole("button", { name: "lesson-1.wavを開く", exact: true })
    .click();
  await expect(page.locator("#toggle-ab")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#gap")).toHaveValue("1");
});
test("invalid files do not prevent valid batch items from being saved", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    {
      name: "broken.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("broken"),
    },
    ...files(2),
  ]);
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(2);
  await expect(page.locator("#library-status")).toContainText("broken.mp3");
  await page
    .getByRole("button", { name: "lesson-2.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
});
test("unavailable IndexedDB gives a warning but still plays the selected file", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      value: {
        open() {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    }),
  );
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(files(1));
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#library-status")).toContainText("保存できません");
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(0);
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
});
test("quota failure keeps registered audio and reports that the new audio was not saved", async ({
  page,
}) => {
  await add(page, 1);
  await page.evaluate(() => {
    IDBObjectStore.prototype.add = function () {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await page.locator("#file-input").setInputFiles({
    name: "quota.wav",
    mimeType: "audio/wav",
    buffer: makeWav(),
  });
  await expect(page.locator("#library-status")).toContainText("保存容量が不足");
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await expect(page.locator("#play")).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "lesson-1.wavを開く", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "quota.wavを開く", exact: true }),
  ).toHaveCount(0);
});
test("saving audio requests persistent storage once and shows the space used", async ({
  page,
}) => {
  // A full stub keeps the check independent of each engine's Storage API support.
  await page.addInitScript(() => {
    window.persistCalls = 0;
    let granted = false;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: async () => granted,
        persist: async () => {
          window.persistCalls++;
          granted = true;
          return true;
        },
        estimate: async () => ({ usage: 600 * 1024, quota: 2 * 1024 ** 3 }),
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#storage-info")).toBeHidden();
  await add(page, 1);
  await expect(page.locator("#storage-info")).toContainText("使用中の容量");
  await expect(page.locator("#storage-info")).toContainText("自動で消さない");
  // Injected files get a fresh lastModified, so both count as new audio.
  await page.locator("#file-input").setInputFiles(files(2));
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(3);
  await expect(page.locator("#library-status")).not.toContainText("保存中");
  expect(await page.evaluate(() => window.persistCalls)).toBe(1);
});
test("audio is saved as bytes where the browser cannot store Blobs, and reopens after reload", async ({
  page,
}) => {
  // Safari private browsing rejects Blob values in IndexedDB with UnknownError.
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...rest) {
      if (value?.blob instanceof Blob)
        throw new DOMException(
          "Error preparing Blob/File data to be stored in object store",
          "UnknownError",
        );
      return add.call(this, value, ...rest);
    };
  });
  await add(page, 1);
  await expect(page.locator("#library-status")).toContainText("保存しました");
  await page.reload();
  await page
    .getByRole("button", { name: "lesson-1.wavを開く", exact: true })
    .click();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
});
