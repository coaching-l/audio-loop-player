import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mandarinPhonemes, syllable } from "../mandarin.js";
import { englishPhonemes } from "../english.js";
import { clipKey, READING_VERSION } from "../tts.js";

// The service worker would answer for tts-worker.js before the stand-in below can.
test.use({ serviceWorkers: "block" });

// Kokoro cannot be downloaded in tests: tests/fixtures/fake-tts-worker.js stands in for
// tts-worker.js and answers each sentence with a tone (0.04 s per character). The
// sentences sent to it are recorded on the page as window.ttsCalls.
async function fakeVoices(page) {
  // Kept for the message when made audio does not become playable (see ready()).
  page.log = [];
  page.on("console", (m) => page.log.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => page.log.push(`pageerror: ${e.message}`));
  await page.route("**/tts-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: readFileSync("tests/fixtures/fake-tts-worker.js"),
    }),
  );
  await page.addInitScript(() => {
    window.ttsCalls = [];
    window.ttsVoices = [];
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        this.speaks = String(url).includes("tts-worker");
      }
      postMessage(message, ...rest) {
        if (this.speaks) {
          window.ttsCalls.push(message.text);
          window.ttsVoices.push(message.voice);
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
}
async function make(page, text) {
  await page.locator("#tts-text").fill(text);
  await page.getByRole("button", { name: "音声を作る" }).click();
}
// Waits until the audio can be played and logs how long that took; if it cannot, says
// what the page and its audio element showed. (Linux WebKit in CI can take seconds.)
async function ready(page, label = "made") {
  const started = Date.now();
  try {
    await expect(page.locator("#play")).toBeEnabled({ timeout: 25000 });
    console.log(`[ready] ${test.info().project.name} ${label}: ${Date.now() - started} ms`);
  } catch (error) {
    const shown = await page.evaluate(() => {
      const audio = document.getElementById("audio");
      return [
        ...["tts-status", "tts-failed", "error", "notice", "play-status", "file-name"].map(
          (id) => `${id}: ${document.getElementById(id)?.textContent.trim()}`,
        ),
        audio
          ? `audio: readyState ${audio.readyState}, networkState ${audio.networkState}, ` +
            `error ${audio.error?.code ?? "none"} ${audio.error?.message ?? ""}, duration ${audio.duration}`
          : "audio: none",
      ].join("\n");
    });
    const log = (page.log || []).join("\n");
    throw new Error(
      `${error.message}\n--- page ---\n${shown}\n--- console ---\n${log}`,
    );
  }
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
  // Makes audio and loads it twice; WebKit in CI needs more than the usual 30 s.
  test.setTimeout(60000);
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "Hello there. This is a test.\nLast one!");
  await ready(page);
  await expect(page.locator("#file-name")).toHaveText("Hello there.mp3");
  await expect(sentences(page)).toHaveText([
    "Hello there.",
    "This is a test.",
    "Last one!",
  ]);
  // Times come from the audio of each sentence, not from guessing, moved by the
  // MP3's delay (1105 samples at 24 kHz, 0.046 s), with 0.3 s between sentences.
  await sentences(page).nth(1).click();
  await expect(page.locator("#point-a")).toHaveValue("0:00.826");
  await expect(page.locator("#point-b")).toHaveValue("0:01.426");
  // Kept as MP3, a fraction of the WAV's size, and its sound starts where the script
  // says the first sentence does.
  const kept = await page.evaluate(async () => {
    const { listAudio, storedFile } = await import("./audio-library.js");
    const { decodeMono } = await import("./audio-tools.js");
    const [record] = await listAudio();
    const file = storedFile(record);
    const { samples, rate } = await decodeMono(file, 24000);
    const script = JSON.parse(
      localStorage.getItem("kotonoha.transcript.v1:" + record.id),
    );
    return {
      type: file.type,
      bytes: file.size,
      seconds: samples.length / rate,
      onset: samples.findIndex((v) => Math.abs(v) > 0.05) / rate,
      start: script.sentences[0].start,
    };
  });
  expect(kept.type).toBe("audio/mpeg");
  // 2.34 s with its pauses: about 112 KB as 16-bit WAV.
  // 128 kbps, about 37 KB: no longer the old 64 kbps (~19 KB) copy.
  expect(kept.bytes).toBeGreaterThan(30000);
  expect(kept.bytes).toBeLessThan(45000);
  expect(Math.abs(kept.onset - kept.start)).toBeLessThan(0.01);
  expect(await calls(page)).toEqual([
    "Hello there.",
    "This is a test.",
    "Last one!",
  ]);
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  // Kept with its script: it opens from the saved list after a reload.
  await page.reload();
  await page.getByRole("button", { name: "Hello there.mp3を開く" }).click();
  await ready(page, "reopened");
  await expect(sentences(page)).toHaveCount(3);
  await expect(page.locator("#tts-text")).toHaveValue(
    "Hello there. This is a test.\nLast one!",
  );
});

test("the text can be cleared with one button, and switching language clears it, with undo", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#entry-text").click();
  const clear = page.getByRole("button", { name: "テキストを消す" });
  await expect(clear).toBeHidden();
  await page.locator("#tts-text").fill("Hello there.");
  await clear.click();
  await expect(page.locator("#tts-text")).toHaveValue("");
  await expect(clear).toBeHidden();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator("#tts-text")).toHaveValue("Hello there.");
  // Pretend this text has made audio: clearing must forget it, so the next audio made
  // is new material instead of replacing that one; undo brings it back.
  await page.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("kotonoha.textdraft.v1"));
    localStorage.setItem(
      "kotonoha.textdraft.v1",
      JSON.stringify({ ...draft, audioId: "made" }),
    );
  });
  const draft = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("kotonoha.textdraft.v1")));
  await page.locator("#tts-lang").selectOption("zh");
  await expect(page.locator("#tts-text")).toHaveValue("");
  await expect(page.locator("#undo-message")).toContainText("言語を切り替えた");
  expect(await draft()).toMatchObject({ text: "", audioId: null });
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator("#tts-text")).toHaveValue("Hello there.");
  expect(await draft()).toMatchObject({ text: "Hello there.", audioId: "made" });
  // Switching with an empty box leaves nothing to undo.
  await clear.click();
  await page.locator("#tts-lang").selectOption("en");
  await expect(page.locator("#undo-message")).not.toContainText("言語を切り替えた");
});

test("if the MP3 encoder never loads, the audio is kept as WAV instead of waiting forever", async ({
  page,
}) => {
  test.setTimeout(60000);
  await fakeVoices(page);
  // A module worker that loads nothing: it neither answers nor reports an error.
  await page.route("**/mp3-worker.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "First line. Second line.");
  await expect(page.locator("#tts-status")).toHaveText("MP3にしています…");
  await ready(page);
  await expect(page.locator("#file-name")).toHaveText("First line.wav");
  await expect(sentences(page)).toHaveCount(2);
  // Without the MP3's delay, the times are the sentences' own.
  await sentences(page).nth(1).click();
  // The first sentence, then 0.3 s of pause: the second starts at 0.74 s.
  await expect(page.locator("#point-a")).toHaveValue("0:00.740");
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
  await ready(page);
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
  // Makes audio and loads it twice; WebKit in CI needs more than the usual 30 s.
  test.setTimeout(60000);
  await fakeVoices(page);
  await page.goto("/");
  await page.locator("#entry-text").click();
  await make(page, "First line. Second line.");
  await ready(page);
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
  await page.waitForFunction(() => window.ttsCalls.length === 2);
  await make(page, "First line. Second line, changed.");
  // Until making ends, the button still belongs to the previous audio.
  await expect(page.locator("#tts-progress")).toBeHidden({ timeout: 25000 });
  await ready(page, "made again");
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
  // English: three American and three British voices.
  await expect(page.locator("#tts-voice option")).toHaveText([
    "Heart（米国英語・女性）",
    "Bella（米国英語・女性）",
    "Michael（米国英語・男性）",
    "Emma（英国英語・女性）",
    "Isabella（英国英語・女性）",
    "George（英国英語・男性）",
  ]);
  await page.locator("#tts-lang").selectOption("zh");
  await expect(page.locator("#tts-voice option")).toHaveText([
    "普通話 001（女性）", "普通話 002（女性）",
    "普通話 010（男性）", "普通話 011（男性）",
  ]);
  await expect(page.locator("#tts-voice")).toHaveValue("zf_001");
  await page.locator("#tts-lang").selectOption("en");
  await make(page, "你好。");
  await expect(page.locator("#tts-failed")).toContainText("英語の声では", {
    timeout: 30000,
  });
  expect(await calls(page)).toEqual([]);
  await page.locator("#tts-lang").selectOption("zh");
  await page.locator("#tts-voice").selectOption("zm_011");
  await make(page, "你好。");
  await ready(page, "new male voice selected (test tone worker)");
  expect(await page.evaluate(() => window.ttsVoices)).toEqual(["zm_011"]);
  await page.reload();
  await page.locator("#entry-text").click();
  await expect(page.locator("#tts-voice")).toHaveValue("zm_011");
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
  // A 1+2 grouping: the first third stays third before the word 很好 (23).
  expect(mandarinPhonemes("我很好。")).toBe("我3/ㄏㄣ2ㄏㄠ3.");
  // Nothing is dropped silently.
  expect(() => mandarinPhonemes("今天练习AI。")).toThrow();
  expect(() => mandarinPhonemes("2026年")).toThrow();
  expect(() => mandarinPhonemes("你好😊")).toThrow();
});

test("地, 得 and 长 are read as the grammar asks, where pinyin-pro reads them wrongly", () => {
  const de = "ㄉㄜ5";
  // 地 marking an adverb is "de", alone after a word or after a doubled one.
  for (const text of ["他高兴地笑了。", "他慢慢地走过来。", "天气渐渐地变冷了。"])
    expect(mandarinPhonemes(text)).toContain(de);
  // As a noun, or in words, it stays "dì".
  for (const text of ["这块土地很大。", "这块地很大。", "他特地来看我。", "飞机落地了。"]) {
    expect(mandarinPhonemes(text)).toContain("ㄉㄧ4");
    expect(mandarinPhonemes(text)).not.toContain(de);
  }
  // 得 after a verb is "de"; in 获得 and 得到 it stays "dé".
  expect(mandarinPhonemes("我跑得很快。")).toContain(de);
  expect(mandarinPhonemes("他说得对。")).toContain(de);
  expect(mandarinPhonemes("他获得了冠军。")).toContain("ㄉㄜ2");
  expect(mandarinPhonemes("我想得到它。")).toContain("ㄉㄜ2");
  // 长得 is "zhǎng de"; 长 elsewhere keeps pinyin-pro's reading.
  expect(mandarinPhonemes("他长得很高。")).toContain("ㄓㄤ3" + "ㄉㄜ5");
  expect(mandarinPhonemes("这条河很长。")).toContain("ㄔㄤ2");
});

test("a verb and its complement are read as one word, without a pause between them", () => {
  // The characters of each stretch between word boundaries ("/") in the reading.
  const stretches = (text) => {
    let at = 0;
    return mandarinPhonemes(text)
      .replace(/[.,!?]/g, "")
      .split("/")
      .filter(Boolean)
      .map((part) => {
        const count = part.match(/[0-5]/g).length;
        return text.slice(at, (at += count));
      });
  };
  expect(stretches("我看不清黑板。")).toContain("我看不清");
  expect(stretches("这个箱子我拿不动。")).toContain("拿不动");
  expect(stretches("你看得见吗？")).toContain("看得见");
  expect(stretches("我想不起来他的名字。")).toContain("我想不起来");
  expect(stretches("我听懂了。")).toContain("听懂了");
  expect(stretches("他走过来了。")).toContain("走过来");
  expect(stretches("请把书拿出来。")).toContain("拿出来");
  // Other boundaries stay: a pronoun is not a verb, and nouns stay apart.
  expect(stretches("我到了。")).toEqual(["我", "到了"]);
  expect(stretches("我找到了钥匙。")).toEqual(["我", "找到", "了", "钥匙"]);
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

test("a sentence's audio is told apart by its text, voice, pinned model and reading rules", () => {
  expect(clipKey("Hi.", "af_heart")).not.toBe(clipKey("Hi!", "af_heart"));
  // Made under older reading rules, a sentence is made again.
  expect(JSON.parse(clipKey("Hi.", "af_heart")).at(-1)).toBe(READING_VERSION);
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
