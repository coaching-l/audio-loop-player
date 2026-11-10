// After npm start: node scripts/benchmark-transcription.mjs
// Real, locally hosted Whisper; no recognition service or text/audio upload.
// Controlled low-volume / opposite-phase variants are not a general accuracy score.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baseline = '334e4ee';
const corpus = [
  { id: 'jfk', lang: 'en', path: 'tests/fixtures/jfk.wav', reference: 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country' },
  { id: 'heart', lang: 'en', path: 'voice-previews/af_heart.mp3', reference: "Hello let's practice together one sentence at a time and enjoy learning" },
  { id: 'mandarin-preview', lang: 'zh', path: 'voice-previews/zf_001.mp3', reference: '你好让我们每天练习一起进步享受学习的乐趣' },
  { id: 'mandarin-human', lang: 'zh', path: 'tests/fixtures/mandarin-asr.wav', reference: '欢迎大家来体验达摩院推出的语音识别模型' },
];
function units(text, lang) {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').trim();
  return lang === 'zh' ? [...cleaned.replace(/\s/g, '')] : cleaned.split(/\s+/).filter(Boolean);
}
function errorRate(reference, actual, lang) {
  const a = units(reference, lang), b = units(actual, lang);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return { metric: lang === 'en' ? 'WER' : 'CER', errors: row[b.length], units: a.length, rate: row[b.length] / a.length };
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox'],
});
const results = [];
await mkdir(resolve(root, 'test-results'), { recursive: true });
const output = resolve(root, 'test-results/transcription-comparison.json');
try {
  for (const version of ['before', 'after']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let source = version === 'before'
      ? execFileSync('git', ['show', `${baseline}:transcribe-worker.js`], { cwd: root, encoding: 'utf8' })
      : await readFile(resolve(root, 'transcribe-worker.js'), 'utf8');
    // Reuse the same recognizer for the small corpus only, avoiding repeated setup.
    source = source.replace('self.onmessage =', 'let recognizer;\nself.onmessage =')
      .replace('const recognize = await pipeline(', 'const recognize = await (recognizer ??= pipeline(')
      .replace('    );\n    const convert', '    ));\n    const convert');
    await page.route('**/transcribe-worker.js', r => r.fulfill({ contentType: 'text/javascript', body: source }));
    for (const item of corpus)
      await page.route(`**/quality-${item.id}`, r => r.fulfill({ path: resolve(root, item.path), contentType: 'application/octet-stream' }));
    await page.goto(process.env.BENCHMARK_URL || 'http://127.0.0.1:4173');
    await page.evaluate(() => { window.recognizer = new Worker('./transcribe-worker.js', { type: 'module' }); });
    for (const item of corpus) for (const condition of ['normal', 'quiet', 'opposite-phase']) {
      const text = await page.evaluate(async ({ item, condition, version }) => {
        const raw = await (await fetch(`./quality-${item.id}`)).arrayBuffer();
        const buffer = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(raw);
        const left = Float32Array.from(buffer.getChannelData(0), v => v * (condition === 'quiet' ? 0.001 : 1));
        let audio = left;
        if (condition === 'opposite-phase') {
          const right = left.map(v => -v);
          audio = version === 'before' ? left.map((v, i) => (v + right[i]) / 2)
            : (await import('./speech-input.js')).speechMono({ length: left.length, numberOfChannels: 2, getChannelData: c => c ? right : left });
        }
        // The production planner skips completely silent audio before inference.
        if (!audio.some(v => v !== 0)) return '';
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Recognition stalled')), 180000);
          window.recognizer.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
          window.recognizer.onmessage = ({ data }) => {
            if (data.type === 'done') { clearTimeout(timer); resolve(data.segments.map(s => s.text).join('')); }
            if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.message)); }
          };
          window.recognizer.postMessage({ audio, windows: [{ start: 0, end: audio.length }], language: item.lang, rate: 16000 }, [audio.buffer]);
        });
      }, { item, condition, version });
      const result = { version, id: item.id, condition, text, ...errorRate(item.reference, text, item.lang) };
      results.push(result);
      console.log(JSON.stringify(result));
      await writeFile(output, JSON.stringify({ baseline, corpus, results }, null, 2));
    }
    await context.close();
  }
} finally { await browser.close(); }
console.log(`Saved: ${output}`);
