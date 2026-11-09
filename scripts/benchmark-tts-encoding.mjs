// Run after npm start. Measures MP3 work only, not Kokoro inference speed.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args:['--no-sandbox'] });
const page = await browser.newPage({ serviceWorkers: 'block' });
await page.goto(process.env.BENCHMARK_URL || 'http://127.0.0.1:4173');
const results = [];
try {
for (const voice of ['af_heart', 'zf_001']) {
 results.push(await page.evaluate(async (voice) => {
  const { decodeMono, joinClips } = await import('./audio-tools.js');
  const { encodeMp3, Mp3StreamEncoder } = await import('./export.js');
  const clip = await decodeMono(await (await fetch(`./voice-previews/${voice}.mp3`)).blob(), 24000);
  const clips = Array(20).fill(clip);
  const joined = joinClips(clips, Array(20).fill(0.3));
  const begin = performance.now();
  const sequential = await encodeMp3(joined.samples, joined.rate);
  const sequentialEncodingMs = performance.now() - begin;
  const encoder = new Mp3StreamEncoder(24000);
  for (let i=0; i<20; i++) {
    // Controlled sentence availability, NOT a model inference benchmark.
    await new Promise(r => setTimeout(r, 300));
    await encoder.drain();
    if (i) encoder.append(new Float32Array(7200));
    encoder.append(clip.samples);
  }
  const tailStart = performance.now();
  const streamed = await encoder.finish();
  const streamTailMs = performance.now() - tailStart;
  const a = new Uint8Array(await sequential.arrayBuffer()), b = new Uint8Array(await streamed.arrayBuffer());
  return {voice, sentences:20, seconds:joined.samples.length/24000, simulatedSentenceDelayMs:300,
   sequentialEncodingMs, streamTailMs, byteIdentical:a.length === b.length && a.every((v,i)=>v===b[i])};
 }, voice));
}
} finally { await browser.close(); }
console.log(JSON.stringify(results,null,2));
await mkdir('test-results', { recursive: true });
await writeFile('test-results/tts-encoding-benchmark.json', JSON.stringify(results, null, 2));
