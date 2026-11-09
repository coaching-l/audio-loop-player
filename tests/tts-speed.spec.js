import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ serviceWorkers: "block" });

test("streaming MP3 preserves every sample, pause and frame of whole-file encoding", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { Mp3StreamEncoder, encodeMp3 } = await import("./export.js");
    const { joinClips } = await import("./audio-tools.js");
    const rate = 24000;
    const clips = [5501, 17459, 2931].map((length) => ({ rate,
      samples: Float32Array.from({ length }, (_, i) => 0.2 * Math.sin(i * 0.12)),
    }));
    const pauses = [0.3, 0.6];
    const joined = joinClips(clips, pauses).samples;
    const expected = new Uint8Array(await (await encodeMp3(joined, rate)).arrayBuffer());
    const encoder = new Mp3StreamEncoder(rate);
    clips.forEach((clip, i) => {
      if (i) encoder.append(new Float32Array(Math.round(pauses[i - 1] * rate)));
      encoder.append(clip.samples);
    });
    const actual = new Uint8Array(await (await encoder.finish()).arrayBuffer());
    return { equal: expected.length === actual.length && expected.every((b, i) => b === actual[i]),
      bytes: actual.length, retained: clips[0].samples.length };
  });
  expect(result.equal).toBe(true);
  expect(result.bytes).toBeGreaterThan(1000);
  expect(result.retained).toBe(5501);
});

test("recent sentences survive voice/text changes, reload and cache deletion", async ({ page }) => {
  await page.goto("/");
  async function generate(voice, sentences) {
    return page.evaluate(async ({ voice, sentences }) => {
      const { synthesize } = await import("./tts.js");
      const calls = [];
      const completed = [];
      const engine = { generate: async (text, id) => {
        calls.push([text, id]);
        return { samples: new Float32Array(2400).fill(0.2), rate: 24000 };
      } };
      const result = await synthesize(sentences, voice, { engine,
        onClip: (clip, i) => completed.push([i, clip.samples.length]),
      });
      return { calls, completed, failed: !!result.failed };
    }, { voice, sentences });
  }
  expect((await generate("af_heart", ["One.", "Two."])).calls).toHaveLength(2);
  expect((await generate("af_bella", ["One.", "Two."])).calls).toHaveLength(2);
  expect((await generate("zf_001", ["你好。"])).calls).toHaveLength(1);
  await page.reload();
  const reused = await generate("af_heart", ["One.", "Two."]);
  expect(reused).toEqual({ calls: [], completed: [[0, 2400], [1, 2400]], failed: false });
  expect((await generate("af_heart", ["One.", "Changed."])).calls).toEqual([["Changed.", "af_heart"]]);
  await page.evaluate(async () => (await import("./tts.js")).deleteTtsData());
  expect((await generate("af_heart", ["One."])).calls).toHaveLength(1);
});

test("old sentence storage migrates without losing interrupted work", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { clipKey, synthesize } = await import("./tts.js");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("coaching-l-tts-clips", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("clips", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("clips", "readwrite");
        tx.objectStore("clips").put({ key: clipKey("Saved.", "af_heart"), samples: new Int16Array(2400).fill(500), rate: 24000 });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });
    let generated = 0;
    const result = await synthesize(["Saved."], "af_heart", { engine: { generate() { generated++; throw new Error("Should reuse"); } } });
    return { generated, count: result.clips.length, value: result.clips[0]?.samples[0] };
  });
  expect(result.generated).toBe(0);
  expect(result.count).toBe(1);
  expect(result.value).toBeCloseTo(500 / 32767, 6);
});

test("recent sentence cache evicts oldest entries at its size and count limits", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { synthesize, clipKey, CLIP_CACHE_BYTES, CLIP_CACHE_COUNT } = await import("./tts.js");
    const engine = { generate: async () => ({ rate: 24000, samples: new Float32Array(24) }) };
    await synthesize(["Recent."], "af_heart", { engine });
    // Metadata is intentionally large to test eviction without allocating 48 MB.
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("coaching-l-tts-clips", 2); r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction(["clips", "usage"], "readwrite");
      for (let i = 0; i < CLIP_CACHE_COUNT; i++) {
        const key = `old-${i}`;
        tx.objectStore("clips").put({ key, samples: new Int16Array(24), rate: 24000 });
        tx.objectStore("usage").put({ key, used: i, bytes: CLIP_CACHE_BYTES / CLIP_CACHE_COUNT });
      }
      tx.oncomplete = resolve;
    });
    await synthesize(["New."], "af_heart", { engine });
    const entries = await new Promise((resolve) => {
      const request = db.transaction("usage").objectStore("usage").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return { size: entries.reduce((sum, e) => sum + e.bytes, 0), count: entries.length,
      maxBytes: CLIP_CACHE_BYTES, maxCount: CLIP_CACHE_COUNT,
      recent: entries.some((e) => e.key === clipKey("Recent.", "af_heart")),
      newest: entries.some((e) => e.key === clipKey("New.", "af_heart")),
      oldest: entries.some((e) => e.key === "old-0") };
  });
  expect(result.size).toBeLessThanOrEqual(result.maxBytes);
  expect(result.count).toBeLessThanOrEqual(result.maxCount);
  expect(result.recent).toBe(true);
  expect(result.newest).toBe(true);
  expect(result.oldest).toBe(false);
});

async function slowVoices(page) {
  let source = readFileSync("tests/fixtures/fake-tts-worker.js", "utf8");
  source = source.replace("}, 30);", '}, data.text.includes("Slow") ? 8000 : 30);');
  await page.route("**/tts-worker.js", (route) => route.fulfill({ contentType: "text/javascript", body: source }));
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.encoding = [];
    window.Worker = class extends Native {
      constructor(url, options) { super(url, options); this.encoder = String(url).includes("mp3-worker"); }
      postMessage(data, ...args) {
        if (this.encoder) window.encoding.push(data.type);
        return super.postMessage(data, ...args);
      }
    };
  });
  await page.goto("/");
  await page.locator("#entry-text").click();
}

test("first sentence plays and MP3 encoding starts before the rest; cancel discards the run", async ({ page }) => {
  await slowVoices(page);
  await page.locator("#tts-text").fill("A completed opening sentence. Slow second sentence.");
  await page.locator("#tts-make").click();
  const preview = page.locator("#tts-preview");
  await expect(preview).toBeVisible({ timeout: 25000 });
  await expect(page.locator("#tts-progress")).toBeVisible();
  expect(await page.evaluate(() => window.encoding)).toContain("append");
  expect(await page.evaluate(() => window.encoding)).not.toContain("finish");
  await preview.click();
  await expect.poll(() => page.locator("#tts-preview-audio").evaluate((a) => !a.paused)).toBe(true);
  await page.locator("#tts-cancel").click();
  await expect(preview).toBeHidden();
  await expect(page.locator("#tts-progress")).toBeHidden();
  expect(await page.locator("#tts-preview-audio").getAttribute("src")).toBeNull();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(0);
  await page.locator("#tts-text").fill("A completed opening sentence. New ending.");
  await page.locator("#tts-make").click();
  await expect(page.locator("#tts-progress")).toBeHidden({ timeout: 25000 });
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#transcript-sentences .sentence")).toHaveText(["A completed opening sentence.", "New ending."]);
});

test("preview stops on entry change and completion, and does not start automatically", async ({ page }) => {
  await slowVoices(page);
  await page.locator("#tts-text").fill("A completed opening sentence. Slow sentence.");
  await page.locator("#tts-make").click();
  await expect(page.locator("#tts-preview")).toBeVisible({ timeout: 25000 });
  expect(await page.locator("#tts-preview-audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#tts-preview").click();
  await page.locator("#entry-audio").click();
  expect(await page.locator("#tts-preview-audio").evaluate((a) => a.paused)).toBe(true);
  await page.locator("#entry-text").click();
  await expect(page.locator("#tts-progress")).toBeHidden({ timeout: 25000 });
  await expect(page.locator("#tts-preview")).toBeHidden();
  await expect(page.locator("#audio-list .audio-item")).toHaveCount(1);
});

test("an old tab blocking cache upgrade cannot stall speech generation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("coaching-l-tts-clips", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("clips", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
    });
    const { synthesize } = await import("./tts.js");
    let calls = 0;
    try {
      const result = await synthesize(["Hello."], "af_heart", { engine: {
        generate: async () => { calls++; return { samples: new Float32Array(24), rate: 24000 }; },
      } });
      return { calls, clips: result.clips.length };
    } finally { db.close(); }
  });
  expect(result).toEqual({ calls: 1, clips: 1 });
});

test("streaming encoder errors fall back to WAV and retain sentence timings", async ({ page }) => {
  await page.route("**/tts-worker.js", (route) => route.fulfill({
    contentType: "text/javascript", body: readFileSync("tests/fixtures/fake-tts-worker.js"),
  }));
  await page.route("**/mp3-worker.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: 'self.postMessage({ready:true}); self.onmessage=()=>self.postMessage({error:"Encoder failed"});',
  }));
  await page.goto("/");
  await page.locator("#entry-text").click();
  await page.locator("#tts-text").fill("First line. Second line.");
  await page.locator("#tts-make").click();
  await expect(page.locator("#play")).toBeEnabled({ timeout: 25000 });
  await expect(page.locator("#file-name")).toHaveText("First line.wav");
  await page.locator("#transcript-sentences .sentence").nth(1).click();
  await expect(page.locator("#point-a")).toHaveValue("0:00.740");
});
