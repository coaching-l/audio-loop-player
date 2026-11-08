// Real-model listening comparison; never uses the test tone worker. Writes only to
// test-results/. Run on a computer that can download the pinned Hugging Face model.
// node scripts/compare-tts.mjs ["text"] [voice ID from voices.js]
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICES } from "../voices.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sourceText = process.argv[2] || "你看得见吗？我得走了，请好好学习。朋友们都来了，他舍不得离开。";
const voice = process.argv[3] || "zf_001";
const language = VOICES.find((v) => v.id === voice)?.lang;
if (!language) throw new Error("Unknown voice.");
const frontend = language === "en" ? "english.js" : "mandarin.js";
const baselineRef = language === "en"
  ? "c3b2d770295dac3d0bb693fe72155e397868043f"
  : "de2f4b2a6c21bd309432a2acd44df0ace22a6f9c";
const baseline = execFileSync("git", ["show", `${baselineRef}:${frontend}`], { cwd: root, encoding: "utf8" });
const workerSource = await readFile(resolve(root, "tts-worker.js"), "utf8");
const voicesSource = await readFile(resolve(root, "voices.js"), "utf8");
if (language === "en" && !voicesSource.includes('dtype: "q8"'))
  throw new Error("English model dtype changed; review the comparison tool.");
const speedInput = 'speed: new Tensor("float32", [1], [1])';
if (!workerSource.includes(speedInput)) throw new Error("Worker speed input changed; update this comparison tool.");
const dir = resolve(root, "test-results", `tts-comparison-${Date.now()}`);
await mkdir(dir, { recursive: true });
const manifest = { text: sourceText, voice, language, baselineRef, status: "running", files: [] };
const saveManifest = () => writeFile(resolve(dir, "result.json"), JSON.stringify(manifest, null, 2));
await saveManifest();

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + sep) || path.split("/").some((s) => s.startsWith("."))) {
      res.writeHead(403).end(); return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  let trial;
  await context.route(`**/${frontend}`, (route) => trial?.old
    ? route.fulfill({ contentType: "text/javascript", body: baseline }) : route.continue());
  await context.route("**/voices.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: language === "en" && trial?.dtype === "fp32"
      ? voicesSource.replace('dtype: "q8"', 'dtype: "fp32"') : voicesSource,
  }));
  // Change only the in-memory response, never the production worker or its fixed 1x speed.
  await context.route("**/tts-worker.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: workerSource.replace(speedInput, `speed: new Tensor("float32", [${trial.speed}], [1])`),
  }));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const trials = language === "en" ? [
    { name: "before-q8", old: true, speed: 1, dtype: "q8" },
    { name: "after-q8", old: false, speed: 1, dtype: "q8" },
    { name: "after-fp32", old: false, speed: 1, dtype: "fp32" },
  ] : [
    { name: "before-1.0", old: true, speed: 1 },
    { name: "after-1.0", old: false, speed: 1 },
    { name: "after-0.9", old: false, speed: 0.9 },
    { name: "after-1.1", old: false, speed: 1.1 },
  ];
  for (trial of trials) {
    console.log(`Generating real speech: ${voice} ${trial.name}`);
    const started = performance.now();
    const result = await page.evaluate(async ({ text, voice }) => {
      const { splitSentences } = await import("./transcript.js");
      const { joinClips, wavBlob } = await import("./audio-tools.js");
      const { encodeMp3 } = await import("./export.js");
      const worker = new Worker("./tts-worker.js", { type: "module" });
      const clips = [];
      const sentences = splitSentences(text);
      try {
        for (const s of sentences) clips.push(await new Promise((resolve, reject) => {
          let timer;
          const arm = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error("Model download or generation stalled for 3 minutes.")), 180000); };
          arm();
          worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
          worker.onmessage = ({ data }) => {
            if (["progress", "stage"].includes(data.type)) { arm(); return; }
            clearTimeout(timer);
            if (data.type === "error") reject(new Error(data.error));
            else if (data.type === "audio") resolve(data);
          };
          worker.postMessage({ type: "generate", text: s.text, voice });
        }));
      } finally { worker.terminate(); }
      const { samples, rate } = joinClips(clips, sentences.map((s) => s.lineEnd ? 0.6 : 0.3));
      if (!samples.length || !samples.every(Number.isFinite)) throw new Error("Invalid model output.");
      const bytes = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
      return {
        seconds: samples.length / rate,
        wav: await bytes(wavBlob(samples, rate)),
        mp3_64: await bytes(await encodeMp3(samples, rate, 64)),
        mp3_128: await bytes(await encodeMp3(samples, rate, 128)),
      };
    }, { text: sourceText, voice });
    for (const [key, ext] of [["wav", "wav"], ["mp3_64", "mp3"], ["mp3_128", "mp3"]]) {
      const name = `${trial.name}-${key}.${ext}`;
      await writeFile(resolve(dir, name), Buffer.from(result[key]));
      manifest.files.push({ name, seconds: result.seconds, bytes: result[key].length,
        processingSeconds: (performance.now() - started) / 1000 });
    }
    await saveManifest();
  }
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const label = language === "en" ? "英語" : "中国語";
  await writeFile(resolve(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>${label}音声の比較</title>
    <h1>${label}音声の比較：${voice}</h1><p>${escape(sourceText)}</p>
    <p>同じ文章・声で、読みの変更前後、${language === "en" ? "q8 / fp32" : "生成速度"}、圧縮形式を比較します。再生速度は1倍のまま聞いてください。</p>
    ${manifest.files.map((f) => `<p>${f.name} (${f.seconds.toFixed(2)}秒)<br><audio controls src="${f.name}"></audio></p>`).join("\n")}`);
  manifest.status = "generated; listening evaluation pending";
  console.log(`Comparison files: ${dir}/index.html`);
} catch (error) {
  manifest.status = "failed";
  manifest.error = String(error.message);
  console.error(`No completed comparison: ${error.message}\nDetails: ${dir}/result.json`);
  process.exitCode = 1;
} finally {
  await saveManifest();
  await browser?.close();
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
}
