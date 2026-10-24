import { test, expect } from "@playwright/test";
import { makeWav } from "./fixtures/make-audio.mjs";
const fixture = "tests/fixtures/tone.wav";
async function load(page, file = fixture) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#play")).toBeEnabled();
}
async function configure(
  page,
  { a = "0.2", b = "0.5", mode = "ab", count = "2", gap = "0" } = {},
) {
  await page.locator("#point-a").fill(a);
  await page.locator("#point-a").press("Tab");
  await page.locator("#point-b").fill(b);
  await page.locator("#point-b").press("Tab");
  await page.locator("#repeat-count").selectOption(count);
  await page.locator("#gap").fill(gap);
  await page.locator("#gap").press("Tab");
  await page.locator("#repeat-mode").selectOption(mode);
  await expect(page.locator("#range-error")).toBeHidden();
}
async function setRate(page, rate) {
  await page.locator("#speed").evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, String(rate));
}
async function traceStatus(page) {
  await page.evaluate(() => {
    window.statusTrace = [];
    let previous = "";
    new MutationObserver(() => {
      const text = document.querySelector("#play-status").textContent;
      if (text !== previous) {
        window.statusTrace.push({ text, at: performance.now() });
        previous = text;
      }
    }).observe(document.querySelector("#play-status"), { childList: true });
  });
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});
test("initial state, real WAV playback, seek, skip and pause", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "再生", exact: true }),
  ).toBeDisabled();
  await load(page);
  await expect(page.locator("#duration")).toHaveText("0:03.0");
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#seek").evaluate((el) => {
    el.value = "1.5";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeCloseTo(1.5, 1);
  await page.getByRole("button", { name: "5秒戻る" }).click();
  expect(await page.locator("#audio").evaluate((a) => a.currentTime)).toBe(0);
  await page.getByRole("button", { name: "5秒進む" }).click();
  expect(await page.locator("#audio").evaluate((a) => a.currentTime)).toBe(3);
});
for (const rate of [0.5, 2])
  test(`actual media advances at ${rate}× and retains pitch flag`, async ({
    page,
  }) => {
    await load(page);
    await setRate(page, rate);
    await page.locator("#play").click();
    const elapsed = await page.evaluate(async () => {
      const audio = document.querySelector("#audio");
      await audio.play();
      const start = audio.currentTime;
      const wall = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 650));
      audio.pause();
      return {
        media: audio.currentTime - start,
        wall: (performance.now() - wall) / 1000,
        pitch: audio.preservesPitch,
        rate: audio.playbackRate,
      };
    });
    expect(elapsed.rate).toBe(rate);
    expect(elapsed.pitch).toBe(true);
    expect(elapsed.media / elapsed.wall).toBeGreaterThan(rate * 0.65);
    expect(elapsed.media / elapsed.wall).toBeLessThan(rate * 1.25);
  });
for (const count of ["2", "3", "5", "10"])
  test(`A–B stops after exactly ${count} total plays`, async ({ page }) => {
    await load(page);
    await configure(page, { a: ".2", b: ".35", count });
    await traceStatus(page);
    await page.locator("#play").click();
    await expect(page.locator("#play-status")).toHaveText("再生完了", {
      timeout: 10000,
    });
    await expect(page.locator("#repeat-progress")).toHaveText(
      `完了 ${count} / ${count} 回`,
    );
    expect(
      await page
        .locator("#audio")
        .evaluate((a) => a.paused && Math.abs(a.currentTime - 0.35) < 0.02),
    ).toBe(true);
    const trace = await page.evaluate(() => window.statusTrace);
    expect(trace.filter((x) => x.text === "再生中")).toHaveLength(
      Number(count),
    );
    await page.waitForTimeout(250);
    await expect(page.locator("#play-status")).toHaveText("再生完了");
  });
for (const rate of [0.5, 2])
  test(`silence stays 0.4 real seconds at ${rate}×`, async ({ page }) => {
    await load(page);
    await configure(page, { gap: ".4" });
    await setRate(page, rate);
    await traceStatus(page);
    await page.locator("#play").click();
    await expect(page.locator("#play-status")).toHaveText("再生完了", {
      timeout: 10000,
    });
    const trace = await page.evaluate(() => window.statusTrace);
    const waitIndex = trace.findIndex((x) => x.text === "無音中");
    expect(waitIndex).toBeGreaterThan(-1);
    const next = trace.slice(waitIndex + 1).find((x) => x.text === "再生中");
    expect(next.at - trace[waitIndex].at).toBeGreaterThanOrEqual(380);
    expect(next.at - trace[waitIndex].at).toBeLessThan(800);
  });
for (const [rate, expected] of [
  [1, 600],
  [2, 300],
])
  test(`relative silence matches the interval's real playing time at ${rate}×`, async ({
    page,
  }) => {
    await load(page);
    await configure(page, { a: "0.2", b: "0.8" });
    await page.locator("#gap-mode").selectOption("1");
    await expect(page.locator("#gap")).toBeHidden();
    await setRate(page, rate);
    await traceStatus(page);
    await page.locator("#play").click();
    await expect(page.locator("#play-status")).toHaveText("再生完了", {
      timeout: 10000,
    });
    const trace = await page.evaluate(() => window.statusTrace);
    const waitIndex = trace.findIndex((x) => x.text === "無音中");
    const next = trace.slice(waitIndex + 1).find((x) => x.text === "再生中");
    expect(next.at - trace[waitIndex].at).toBeGreaterThanOrEqual(expected - 20);
    expect(next.at - trace[waitIndex].at).toBeLessThan(expected + 400);
  });
test("relative silence is saved with segments and restored after reload", async ({
  page,
}) => {
  await load(page);
  await configure(page, { a: "0.2", b: "0.8" });
  await page.locator("#gap-mode").selectOption("1.5");
  await page.locator("#segment-name").fill("相対");
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await expect(page.locator(".segment .small")).toContainText(
    "無音 区間の1.5倍",
  );
  await page.reload();
  await load(page);
  await expect(page.locator("#gap-mode")).toHaveValue("1.5");
  await expect(page.locator("#gap")).toBeHidden();
  await page.locator("#gap-mode").selectOption("0");
  await expect(page.locator("#gap")).toBeVisible();
  await page
    .getByRole("button", { name: "相対を呼び出す", exact: true })
    .click();
  await expect(page.locator("#gap-mode")).toHaveValue("1.5");
});
test("pause during silence retains the remaining silence and never auto-resumes", async ({
  page,
}) => {
  await load(page);
  await configure(page, { gap: "1" });
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中に一時停止");
  await page.waitForTimeout(1150);
  await expect(page.locator("#play-status")).toHaveText("無音中に一時停止");
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await page.waitForTimeout(200);
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await expect(page.locator("#play-status")).toHaveText("再生完了", {
    timeout: 5000,
  });
});
test("switching files cancels old repeat timers and revokes old object URLs", async ({
  page,
}) => {
  await load(page);
  await configure(page, { gap: ".8" });
  const oldURL = await page.locator("#audio").getAttribute("src");
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await load(page, {
    name: "other.wav",
    mimeType: "audio/wav",
    buffer: makeWav(2, 660),
  });
  await page.waitForTimeout(1100);
  await expect(page.locator("#file-name")).toHaveText("other.wav");
  await expect(page.locator("#play-status")).toHaveText("一時停止");
  expect(
    await page
      .locator("#audio")
      .evaluate((a) => a.paused && a.currentTime === 0),
  ).toBe(true);
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, oldURL),
  ).toBe(true);
});
test("whole-file finite repeat and unlimited repeat", async ({ page }) => {
  await load(page, {
    name: "short.wav",
    mimeType: "audio/wav",
    buffer: makeWav(0.35),
  });
  await configure(page, {
    a: "0",
    b: ".3",
    mode: "all",
    count: "3",
    gap: ".1",
  });
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了");
  await expect(page.locator("#repeat-progress")).toHaveText("完了 3 / 3 回");
  await page.locator("#repeat-count").selectOption("0");
  await page.locator("#play").click();
  await expect
    .poll(async () =>
      Number(
        (await page.locator("#repeat-progress").textContent()).match(
          /完了 (\d+)/,
        )[1],
      ),
    )
    .toBeGreaterThanOrEqual(4);
  await page.locator("#play").click();
  expect(await page.locator("#audio").evaluate((a) => a.paused)).toBe(true);
});
test("invalid A–B and gap inputs are rejected without changing valid configuration", async ({
  page,
}) => {
  await load(page);
  await configure(page);
  for (const value of [".5", ".8", "-1", "invalid", "1:99"]) {
    await page.locator("#point-a").fill(value);
    await page.locator("#point-a").press("Tab");
    await expect(page.locator("#range-error")).toBeVisible();
    await page.locator("#point-a").fill(".2");
    await page.locator("#point-a").press("Tab");
  }
  await page.locator("#point-b").fill("9");
  await page.locator("#point-b").press("Tab");
  await expect(page.locator("#range-error")).toBeVisible();
  await page.locator("#point-b").fill(".5");
  await page.locator("#point-b").press("Tab");
  for (const value of ["-1", "11", ""]) {
    await page.locator("#gap").fill(value);
    await page.locator("#gap").press("Tab");
    await expect(page.locator("#range-error")).toContainText("0〜10");
  }
});
test("multiple named segments persist per file, load and delete safely", async ({
  page,
}) => {
  await load(page);
  await configure(page, { gap: ".3", count: "5" });
  await setRate(page, 0.75);
  await page.locator("#segment-name").fill("<b>フレーズ1</b>");
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await page.locator("#point-b").fill("1.5");
  await page.locator("#point-b").press("Tab");
  await page.locator("#segment-name").fill("フレーズ2");
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await expect(page.locator(".segment")).toHaveCount(2);
  await expect(page.locator(".segment-name b")).toHaveCount(0);
  await page.reload();
  await load(page);
  await expect(page.locator(".segment")).toHaveCount(2);
  await page
    .getByRole("button", { name: "<b>フレーズ1</b>を呼び出す", exact: true })
    .click();
  await expect(page.locator("#point-b")).toHaveValue("0:00.500");
  await expect(page.locator("#speed-value")).toHaveText("0.75×");
  await expect(page.locator("#gap")).toHaveValue("0.3");
  await load(page, {
    name: "different.wav",
    mimeType: "audio/wav",
    buffer: makeWav(),
  });
  await expect(page.locator(".segment")).toHaveCount(0);
  await load(page);
  await expect(page.locator(".segment")).toHaveCount(2);
  await page
    .getByRole("button", { name: "フレーズ2を削除", exact: true })
    .click();
  await page.reload();
  await load(page);
  await expect(page.locator(".segment")).toHaveCount(1);
});
for (const extension of ["mp3", "m4a"])
  test(`real ${extension.toUpperCase()} decoding and playback`, async ({
    page,
  }) => {
    await load(page, `tests/fixtures/tone.${extension}`);
    await page.locator("#play").click();
    await expect
      .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
      .toBeGreaterThan(0.15);
    await expect(page.locator("#error")).toBeHidden();
  });
test("corrupt audio produces a useful error and recovers on a valid file", async ({
  page,
}) => {
  await page.locator("#file-input").setInputFiles({
    name: "broken.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("not an audio file"),
  });
  await expect(page.locator("#error")).toContainText(
    "形式がブラウザに対応していないか",
  );
  await expect(page.locator("#play")).toBeDisabled();
  await load(page);
  await expect(page.locator("#error")).toBeHidden();
});
test("desktop drag and drop loads a local file without uploading", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Desktop-only drag and drop; mobile uses file selection.",
  );
  const remote = [];
  page.on("request", (request) => {
    if (
      !request.url().startsWith("http://127.0.0.1:4173") &&
      !request.url().startsWith("blob:")
    )
      remote.push(request.url());
  });
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array(bytes)], "drop.wav", { type: "audio/wav" }),
      );
      return dt;
    },
    [...makeWav()],
  );
  await page
    .locator("#drop-zone")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#file-name")).toHaveText("drop.wav");
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
  expect(remote).toEqual([]);
});
test("iPhone-sized viewport has no horizontal overflow and usable controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生中");
  await page.locator("#play").click();
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
});
test("storage unavailable still allows local playback and segment use", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "QuotaExceededError");
    };
  });
  await page.reload();
  await load(page);
  await configure(page);
  await page.locator("#segment-name").fill("一時的な区間");
  await page.getByRole("button", { name: "区間を保存", exact: true }).click();
  await expect(page.locator(".segment")).toHaveCount(1);
  await expect(page.locator("#notice")).toContainText("保存できません");
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("再生完了");
});
test("capture A and B during playback, disable repeat, and restore settings", async ({
  page,
}) => {
  await load(page);
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.2);
  await page.locator("#set-a").click();
  const a = await page.locator("#point-a").inputValue();
  expect(Number(a.split(":")[1])).toBeGreaterThan(0.1);
  await expect
    .poll(() => page.locator("#audio").evaluate((el) => el.currentTime))
    .toBeGreaterThan(Number(a.split(":")[1]) + 0.2);
  await page.locator("#set-b").click();
  const b = await page.locator("#point-b").inputValue();
  expect(Number(b.split(":")[1])).toBeGreaterThan(Number(a.split(":")[1]));
  await page.locator("#repeat-mode").selectOption("ab");
  await expect(page.locator("#range-error")).toBeHidden();
  await page.locator("#play").click();
  await page.locator("#repeat-mode").selectOption("off");
  await page.locator("#seek").evaluate((el) => {
    el.value = "2.5";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(
    await page.locator("#audio").evaluate((el) => el.currentTime),
  ).toBeCloseTo(2.5, 1);
  await page.reload();
  await load(page);
  await expect(page.locator("#point-a")).toHaveValue(a);
  await expect(page.locator("#point-b")).toHaveValue(b);
  await expect(page.locator("#repeat-mode")).toHaveValue("off");
});
test("changing speed during silence preserves the existing wall-clock deadline", async ({
  page,
}) => {
  await load(page);
  await configure(page, { gap: ".8" });
  await traceStatus(page);
  await page.locator("#play").click();
  await expect(page.locator("#play-status")).toHaveText("無音中");
  await setRate(page, 2);
  await expect(page.locator("#play-status")).toHaveText("再生完了");
  const trace = await page.evaluate(() => window.statusTrace);
  const index = trace.findIndex((x) => x.text === "無音中");
  const next = trace.slice(index + 1).find((x) => x.text === "再生中");
  expect(next.at - trace[index].at).toBeGreaterThan(770);
  expect(next.at - trace[index].at).toBeLessThan(1100);
});
test("switching while playing stops and releases the previous media element", async ({
  page,
}) => {
  await load(page);
  await page.locator("#play").click();
  await expect
    .poll(() => page.locator("#audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0.1);
  const previous = await page.locator("#audio").elementHandle();
  await load(page, {
    name: "replacement.wav",
    mimeType: "audio/wav",
    buffer: makeWav(1),
  });
  expect(
    await previous.evaluate((a) => a.paused && !a.hasAttribute("src")),
  ).toBe(true);
  await page.waitForTimeout(400);
  expect(
    await page
      .locator("#audio")
      .evaluate((a) => a.paused && a.currentTime === 0),
  ).toBe(true);
});
