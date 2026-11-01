import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mandarinPhonemes, syllable } from "../mandarin.js";
import { englishPhonemes } from "../english.js";
import { clipKey } from "../tts.js";

// The service worker would answer for tts-worker.js before the stand-in below can.
test.use({ serviceWorkers: "block" });

// Kokoro cannot be downloaded in tests: tests/fixtures/fake-tts-worker.js stands in for
// tts-worker.js and answers each sentence with a tone (0.04 s per character). The
// sentences sent to it are recorded on the page as window.ttsCalls.
async function fakeVoices(page) {
  await page.route("**/tts-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: readFileSync("tests/fixtures/fake-tts-worker.js"),
    }),
  );
  await page.addInitScript(() => {
    window.ttsCalls = [];
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        this.speaks = String(url).includes("tts-worker");
      }
      postMessage(message, ...rest) {
        if (this.speaks) window.ttsCalls.push(message.text);
        return super.postMessage(message, ...rest);
      }
    };
  });
}
async function make(page, text) {
  await page.locator("#tts-text").fill(text);
  await page.getByRole("button", { name: "音声を作る" }).click();
}
const sentences = (page) => page.locator("#transcript-sentences .sentence");
const calls = (page) => page.evaluate(() => window.ttsCalls);

test("the first screen offers both ways in and remembers the one chosen", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#text-entry")).toBeHidden();
  await expect(page.locator("#drop-zone")).toBeHidden();
  await page.getByRole("button", { name: /テキストから始める/ }).click();
  await expect(page.locator("#text-entry")).toBeVisible();
  await expect(page.locator("#entry-text")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /音源から始める/ }).click();
  await expect(page.locator("#drop-zone")).toBeVisible();
  await expect(page.locator("#text-entry")).toBeHidden();
  await page.reload();
  await expect(page.locator("#drop-zone")).toBeVisible();
  await expect(page.locator("#entry-audio")).toHaveAttribute("aria-pressed", "true");
});

test("text becomes audio whose sentences, with their times, are the script", async ({
  page,
}) => {
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "Hello there. This is a test.\nLast one!");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#file-name")).toHaveText("Hello there.wav");
  await expect(sentences(page)).toHaveText([
    "Hello there.",
    "This is a test.",
    "Last one!",
  ]);
  // Times come from the audio of each sentence, not from guessing.
  await sentences(page).nth(1).click();
  await expect(page.locator("#point-a")).toHaveValue("0:00.480");
  await expect(page.locator("#point-b")).toHaveValue("0:01.080");
  expect(await calls(page)).toEqual([
    "Hello there.",
    "This is a test.",
    "Last one!",
  ]);
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  // Kept with its script: it opens from the saved list after a reload.
  await page.reload();
  await page.getByRole("button", { name: "Hello there.wavを開く" }).click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(sentences(page)).toHaveCount(3);
  await expect(page.locator("#tts-text")).toHaveValue(
    "Hello there. This is a test.\nLast one!",
  );
});

test("a sentence that fails is named, and making again goes on from it", async ({
  page,
}) => {
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "One here. Two FAIL here. Three here.");
  await expect(page.locator("#tts-failed")).toContainText(
    "2文目「Two FAIL here.」で止まりました",
    { timeout: 30000 },
  );
  await expect(page.locator("#play")).toBeDisabled();
  await make(page, "One here. Two is fine. Three here.");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#tts-failed")).toBeHidden();
  // The first sentence was made once; only the fixed one and the rest were made now.
  expect(await calls(page)).toEqual([
    "One here.",
    "Two FAIL here.",
    "Two is fine.",
    "Three here.",
  ]);
});

test("changing one sentence makes only that one again and replaces the saved audio", async ({
  page,
}) => {
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "First line. Second line.");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await page.waitForFunction(() => window.ttsCalls.length === 2);
  await make(page, "First line. Second line, changed.");
  await expect(sentences(page)).toHaveText(["First line.", "Second line, changed."], {
    timeout: 30000,
  });
  expect(await calls(page)).toEqual([
    "First line.",
    "Second line.",
    "Second line, changed.",
  ]);
  // The older version of the same text is replaced, not kept beside it.
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await expect(page.locator("#library-status")).toContainText("保存しました");
});

test("each language offers its own voices, and an English voice refuses Chinese text", async ({
  page,
}) => {
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await expect(page.locator("#tts-voice option")).toHaveCount(5);
  await page.locator("#tts-lang").selectOption("zh");
  await expect(page.locator("#tts-voice option")).toHaveCount(3);
  await expect(page.locator("#tts-voice")).toHaveValue("zf_001");
  await page.locator("#tts-lang").selectOption("en");
  await make(page, "你好。");
  await expect(page.locator("#tts-failed")).toContainText("英語の声では", {
    timeout: 30000,
  });
  expect(await calls(page)).toEqual([]);
});

test("an attempt the page did not finish is pointed out next time", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "coaching-l-tts-attempt-v1",
      JSON.stringify({ lang: "zh", startedAt: Date.now() }),
    ),
  );
  await page.reload();
  await page.locator("#entry-text").click();
  await expect(page.locator("#tts-failed")).toContainText("途中で止まりました");
  await expect(page.locator("#tts-failed")).toContainText("中国語");
  await page.reload();
  await page.locator("#entry-text").click();
  await expect(page.locator("#tts-failed")).toBeHidden();
});

// The readings, ported from Shadowing (its tests/mandarin.test.ts).
test("Mandarin becomes Kokoro v1.1 reading symbols, with tone changes and punctuation", () => {
  expect(syllable("zhi4", 4)).toBe("ㄓ十4");
  expect(syllable("zi3", 3)).toBe("ㄗㄭ3");
  expect(syllable("jue2", 2)).toBe("ㄐ月2");
  expect(syllable("yun2", 2)).toBe("云2");
  const phones = mandarinPhonemes("你好，今天你想做什么？");
  expect(phones).toContain("ㄋㄧ2ㄏㄠ3");
  expect(phones).toContain(",");
  expect(phones.endsWith("?")).toBe(true);
  expect(mandarinPhonemes("今天的进步。")).toContain("ㄐ阴1ㄊ言1");
  // A run of third tones: pinyin-pro leaves it, the port's own rule changes all but the last.
  expect(mandarinPhonemes("我很好。")).toBe("我2/ㄏㄣ2ㄏㄠ3.");
  // Nothing is dropped silently.
  expect(() => mandarinPhonemes("今天练习AI。")).toThrow();
  expect(() => mandarinPhonemes("2026年")).toThrow();
  expect(() => mandarinPhonemes("你好😊")).toThrow();
});

test("English is read by eSpeak NG after Kokoro's normalization", async () => {
  expect(await englishPhonemes("Dr. Smith paid $3.50.")).toBe(
    "dˈɑːktɚ smˈɪθ pˈeɪd θɹˈiː dˈɑːlɚz ænd fˈɪfti sˈɛnts.",
  );
  // British voices read with British English.
  expect(await englishPhonemes("Tomato.", "b")).not.toBe(
    await englishPhonemes("Tomato.", "a"),
  );
});

test("a sentence's audio is told apart by its text, voice and pinned model", () => {
  expect(clipKey("Hi.", "af_heart")).not.toBe(clipKey("Hi!", "af_heart"));
  expect(clipKey("Hi.", "af_heart")).not.toBe(clipKey("Hi.", "af_bella"));
  expect(clipKey("Hi.", "af_heart")).toContain(
    "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
  );
});

test("the real worker loads in the browser, and its runtime is saved once", async ({
  page,
}) => {
  await page.goto("/");
  // The real worker: its modules load, and it answers (here, refusing an unknown voice)
  // without reaching any model.
  const answer = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new Worker("./tts-worker.js", { type: "module" });
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => resolve({ type: "crash", error: event.message });
        worker.postMessage({ type: "generate", text: "Hi.", voice: "nobody" });
      }),
  );
  expect(answer).toEqual({ type: "error", error: "この声は使えません。" });
  // Saving the runtime checks each file against its recorded size and SHA-256.
  const saved = await page.evaluate(async () => {
    const { prepareRuntime, RUNTIME_CACHE, RUNTIME_FILES } = await import("./tts.js");
    await prepareRuntime(() => {});
    const cache = await caches.open(RUNTIME_CACHE);
    return (await cache.keys()).length === RUNTIME_FILES.length;
  });
  expect(saved).toBe(true);
});

// The readers run where the app runs them: in a module worker, as tts-worker.js does.
// (eSpeak NG takes a while to start, so these get more time than other tests.)
for (const [language, source, text, expected] of [
  [
    "English",
    'import { englishPhonemes } from "/english.js"; self.postMessage(await englishPhonemes(TEXT));',
    "Hello world.",
    "həlˈoʊ wˈɜːld.",
  ],
  [
    "Mandarin",
    'import { mandarinPhonemes } from "/mandarin.js"; self.postMessage(mandarinPhonemes(TEXT));',
    "你好。",
    "ㄋㄧ2ㄏㄠ3.",
  ],
])
  test(`the ${language} reader works in a worker in the browser`, async ({ page }) => {
    test.setTimeout(150000);
    await page.route("**/reader-test-worker.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: source.replace("TEXT", JSON.stringify(text)),
      }),
    );
    await page.goto("/");
    const reading = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const worker = new Worker("./reader-test-worker.js", { type: "module" });
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = (event) => resolve("error: " + event.message);
        }),
    );
    expect(reading).toBe(expected);
  });

// Older Safari cannot iterate a ReadableStream with for await, and phonemizer then hung
// forever (CI WebKit). Without that iteration, English is still read (stream-iterator.js).
test("English is read in a worker even where streams cannot be iterated", async ({
  page,
}) => {
  await page.route("**/reader-test-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `delete ReadableStream.prototype[Symbol.asyncIterator];
        const { englishPhonemes } = await import("/english.js");
        self.postMessage(await englishPhonemes("Hello world."));`,
    }),
  );
  await page.goto("/");
  const reading = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new Worker("./reader-test-worker.js", { type: "module" });
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => resolve("error: " + event.message);
      }),
  );
  expect(reading).toBe("həlˈoʊ wˈɜːld.");
});

test("the runtime files on disk match their recorded sizes and hashes", async () => {
  const { createHash } = await import("node:crypto");
  const { RUNTIME_FILES } = await import("../tts.js");
  for (const file of RUNTIME_FILES) {
    const bytes = readFileSync(file.path);
    expect(bytes.length, file.path).toBe(file.size);
    expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(
      file.sha256,
    );
  }
});
