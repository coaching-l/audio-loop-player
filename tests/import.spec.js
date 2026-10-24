import { test, expect } from "@playwright/test";
import { makeWav } from "./fixtures/make-audio.mjs";
test("read file bytes once, normalize provider MIME, and persist owned Blob bytes", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(
    async (bytes) => {
      const { readableAudio } = await import("/audio-import.js");
      const { addAudio, listAudio, storedFile } =
        await import("/audio-library.js");
      const file = new File([new Uint8Array(bytes)], "provider.wav", {
        type: "application/octet-stream",
        lastModified: 123,
      });
      let reads = 0;
      const original = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => {
        reads++;
        return original();
      };
      const [a, b] = await Promise.all([
        readableAudio(file),
        readableAudio(file),
      ]);
      await addAudio(a);
      const record = (await listAudio())[0];
      const copy = storedFile(record);
      return {
        reads,
        same: a === b,
        mime: a.type,
        stored: record.blob instanceof Blob,
        name: copy.name,
        size: copy.size,
        stamp: copy.lastModified,
        bytes: Array.from(new Uint8Array(await copy.arrayBuffer())).slice(
          0,
          12,
        ),
      };
    },
    [...makeWav()],
  );
  expect(result).toMatchObject({
    reads: 1,
    same: true,
    mime: "audio/wav",
    stored: true,
    name: "provider.wav",
    size: makeWav().length,
    stamp: 123,
  });
  expect(result.bytes).toEqual([...makeWav()].slice(0, 12));
});
test("unreadable provider file reports the read failure without registering it", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { readableAudio } = await import("/audio-import.js");
    const file = new File(["x"], "cloud.mp3");
    file.arrayBuffer = () =>
      Promise.reject(
        new DOMException("provider unavailable", "NotReadableError"),
      );
    try {
      await readableAudio(file);
      return null;
    } catch (e) {
      return { name: e.name, message: e.message };
    }
  });
  expect(result.name).toBe("AudioReadError");
  expect(result.message).toContain("ダウンロード");
  await expect(page.locator(".audio-item")).toHaveCount(0);
});
test("metadata deferred until an explicit play gesture still saves and reopens audio", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const src = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "src",
    );
    const load = HTMLMediaElement.prototype.load;
    const play = HTMLMediaElement.prototype.play;
    const pending = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      ...src,
      set(value) {
        pending.set(this, value);
      },
      get() {
        return pending.get(this) || src.get.call(this);
      },
    });
    HTMLMediaElement.prototype.load = function () {
      if (!pending.has(this)) return load.call(this);
    };
    HTMLMediaElement.prototype.play = function () {
      if (pending.has(this)) {
        src.set.call(this, pending.get(this));
        pending.delete(this);
        load.call(this);
      }
      return play.call(this);
    };
  });
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "mobile.wav",
      mimeType: "application/octet-stream",
      buffer: makeWav(),
    });
  await expect(page.locator(".audio-item")).toHaveCount(1, { timeout: 12000 });
  await expect(page.locator("#library-status")).toContainText("再生確認");
  await expect(page.locator("#load-audio")).toBeVisible();
  await page.locator("#load-audio").click();
  await expect(page.locator("#play")).toBeEnabled();
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
  await page.reload();
  await page
    .getByRole("button", { name: "mobile.wavを開く", exact: true })
    .click();
  await page.locator("#load-audio").click();
  await expect(page.locator("#play")).toBeEnabled();
});
