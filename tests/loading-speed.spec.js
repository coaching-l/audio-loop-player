import { test, expect } from '@playwright/test';
import { makeWav } from './fixtures/make-audio.mjs';
test.use({ serviceWorkers: 'block' });

test('playback does not wait for the full file copy used for saving', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async (bytes) => {
    const { openPractice } = await import('./practice.js');
    const file = new File([new Uint8Array(bytes)], 'fast.wav', { type: 'application/octet-stream' });
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => new Promise((resolve, reject) => {
      window.finishFileRead = () => read().then(resolve, reject);
    });
    void openPractice({ file });
  }, [...makeWav()]);
  await expect(page.locator('#play')).toBeEnabled();
  await page.locator('#play').click();
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeGreaterThan(0.1);
  // The held read only feeds the waveform: playback is already advancing.
  await page.evaluate(() => window.finishFileRead?.());
});

test('a saved file is already owned and does not require another byte copy', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (bytes) => {
    const { addAudio, storedFile } = await import('./audio-library.js');
    const { readableAudio } = await import('./audio-import.js');
    const record = await addAudio(new File([new Uint8Array(bytes)], 'saved.wav', { type: 'audio/wav' }));
    const file = storedFile(record);
    let copies = 0;
    file.arrayBuffer = () => { copies++; throw new Error('Redundant full file read'); };
    return { same: await readableAudio(file) === file, copies };
  }, [...makeWav()]);
  expect(result).toEqual({ same: true, copies: 0 });
});

test('a failed direct load falls back to owned bytes; a stale fallback cannot replace another file', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async (bytes) => {
    const { openPractice } = await import('./practice.js');
    const create = URL.createObjectURL.bind(URL);
    let first = true;
    URL.createObjectURL = (file) => {
      if (first) { first = false; return create(new Blob(['broken'], { type: 'audio/wav' })); }
      return create(file);
    };
    await openPractice({ file: new File([new Uint8Array(bytes)], 'fallback.wav', { type: 'audio/wav' }) });
  }, [...makeWav()]);
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#error')).toBeHidden();
  await page.evaluate(async (bytes) => {
    const { openPractice } = await import('./practice.js');
    const file = new File([new Uint8Array(bytes)], 'old.wav', { type: 'audio/wav' });
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => new Promise(resolve => { window.releaseOldRead = async () => resolve(await read()); });
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (f) => f.name === 'old.wav' ? create(new Blob(['broken'])) : create(f);
    void openPractice({ file });
  }, [...makeWav()]);
  await page.waitForFunction(() => typeof window.releaseOldRead === 'function');
  await page.evaluate(async (bytes) => {
    const { openPractice } = await import('./practice.js');
    await openPractice({ file: new File([new Uint8Array(bytes)], 'new.wav', { type: 'audio/wav' }) });
    await window.releaseOldRead();
  }, [...makeWav()]);
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#file-name')).toHaveText('new.wav');
  await expect(page.locator('#error')).toBeHidden();
});

test('an explicit loading tap is not interrupted by the automatic fallback timer', async ({ page }) => {
  await page.addInitScript(() => {
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const load = HTMLMediaElement.prototype.load;
    const play = HTMLMediaElement.prototype.play;
    const pending = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...src, get() { return pending.get(this) || src.get.call(this); },
      set(value) { pending.set(this, value); },
    });
    HTMLMediaElement.prototype.load = function () { if (!pending.has(this)) return load.call(this); };
    HTMLMediaElement.prototype.play = function () {
      if (!pending.has(this)) return play.call(this);
      const url = pending.get(this);
      return new Promise((resolve, reject) => setTimeout(() => {
        pending.delete(this);
        src.set.call(this, url);
        load.call(this);
        play.call(this).then(resolve, reject);
      }, 2200));
    };
  });
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'slow-metadata.wav', mimeType: 'audio/wav', buffer: makeWav() });
  await page.locator('#load-audio').click();
  await expect(page.locator('#play')).toBeEnabled({ timeout: 10000 });
  await expect(page.locator('#error')).toBeHidden();
});
