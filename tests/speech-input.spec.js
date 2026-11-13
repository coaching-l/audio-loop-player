import { test, expect } from '@playwright/test';
import { speechMono, normalizeQuietSpeech } from '../speech-input.js';
const buffer = (...channels) => ({ length: channels[0].length,
  numberOfChannels: channels.length, getChannelData: c => channels[c] });

test('mono and ordinary stereo retain their samples, with no playback mutation', () => {
  const left = Float32Array.from([0.4, -0.4, 0.2, -0.2]);
  const right = Float32Array.from([0.2, -0.3, -0.2, 0.1]);
  const mono = speechMono(buffer(left));
  expect([...mono]).toEqual([...left]);
  const mixed = speechMono(buffer(left, right));
  for (let i = 0; i < left.length; i++) expect(mixed[i]).toBeCloseTo((left[i] + right[i]) / 2, 6);
  expect(normalizeQuietSpeech(mixed)).toBe(mixed);
  expect([...left]).toEqual([...Float32Array.from([0.4, -0.4, 0.2, -0.2])]);
});

test('opposite phase stereo preserves speech instead of cancelling it', () => {
  const left = Float32Array.from([0.4, -0.4, 0.2, -0.2]);
  for (const strength of [1, 0.8]) {
    const right = left.map(v => -v * strength);
    expect([...speechMono(buffer(left, right))]).toEqual([...left]);
  }
  // Different speech in the two channels must not be discarded.
  const a = Float32Array.from([0.4, 0, -0.4, 0]);
  const b = Float32Array.from([0, 0.2, 0, -0.2]);
  const mixed = speechMono(buffer(a, b));
  for (let i = 0; i < a.length; i++) expect(mixed[i]).toBeCloseTo((a[i] + b[i]) / 2, 6);
});

test('only very quiet speech is boosted; silence and normal audio are unchanged', () => {
  const silent = new Float32Array(100);
  expect(normalizeQuietSpeech(silent).every(v => v === 0)).toBe(true);
  const normal = Float32Array.from([0.03, -0.03, 0.01]);
  expect([...normalizeQuietSpeech(normal)]).toEqual([...Float32Array.from([0.03, -0.03, 0.01])]);
  const quiet = Float32Array.from([0.001, -0.001, 0.0005]);
  const improved = normalizeQuietSpeech(quiet);
  expect(improved[0]).toBeCloseTo(0.2, 6);
  expect(improved[1]).toBeCloseTo(-0.2, 6);
  expect(improved[2]).toBeCloseTo(0.1, 6);
  expect(improved.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
});

test('real English and Mandarin speech remain recognizable through opposite-phase stereo', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Same recognition engine; real inference is measured in the desktop run.');
  test.setTimeout(240000);
  // Expose fixtures only in this test, not via the development server.
  await page.route('**/quality-jfk.wav', r => r.fulfill({ path: 'tests/fixtures/jfk.wav', contentType: 'audio/wav' }));
  await page.route('**/quality-zh.wav', r => r.fulfill({ path: 'tests/fixtures/mandarin-asr.wav', contentType: 'audio/wav' }));
  await page.goto('/');
  for (const [language, path, expected] of [
    ['en', './quality-jfk.wav', 'ask not what your country can do for you'],
    ['zh', './quality-zh.wav', '语音识别模型'],
  ]) {
    // Each step is named in the error: WebKit in CI reported only "Decoding failed".
    const text = await page.evaluate(async ({ language, path }) => {
      let step = 'import';
      try {
        const { transcribe } = await import('./transcriber.js');
        step = 'fetch the source WAV';
        const response = await fetch(path);
        const source = await response.arrayBuffer();
        step = `decode the source WAV (${response.status}, ${source.byteLength} bytes)`;
        const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(source);
        const samples = audio.getChannelData(0);
        const bytes = new ArrayBuffer(44 + samples.length * 4);
        const view = new DataView(bytes);
        const str = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
        str(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVE');
        str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 2, true); view.setUint32(24, 16000, true); view.setUint32(28, 64000, true);
        view.setUint16(32, 4, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
        for (let i = 0; i < samples.length; i++) {
          const pcm = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
          view.setInt16(44 + i * 4, pcm, true); view.setInt16(46 + i * 4, -pcm, true);
        }
        step = `transcribe the made stereo WAV (${audio.sampleRate} Hz, ${samples.length} samples)`;
        return (await transcribe(new File([bytes], 'stereo.wav', { type: 'audio/wav' }), { language })).map(s => s.text).join('');
      } catch (error) {
        throw new Error(`${language}: ${step}: ${error.name}: ${error.message}`);
      }
    }, { language, path });
    expect(text.toLowerCase()).toContain(expected);
  }
});
