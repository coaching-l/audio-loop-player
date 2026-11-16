// Shared steps for the practice screen.
import { test, expect } from "@playwright/test";

// Opens the folded "詳しい設定" so its fields can be used.
export async function openAdvanced(page) {
  const details = page.locator("#advanced");
  if (!(await details.evaluate((d) => d.open)))
    await details.locator("summary").click();
}

// Turns interval repeat on or off with the button above the gauge.
export async function setRepeat(page, on) {
  const toggle = page.locator("#toggle-ab");
  if ((await toggle.getAttribute("aria-pressed")) !== String(on))
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(on));
}

// Linux WebKit (the CI's WebKit) cannot run some offline steps: once the network is cut
// it reports "WebKit encountered an internal error" on navigation, or cannot re-read a
// Blob (NotReadableError). Offline use was checked on a real iPhone. These tests still
// run everywhere; on Linux WebKit they are expected to fail, so the WebKit job turns red
// only for a new failure, or if one of these starts to pass. See DEVELOPMENT.md.
export function expectLinuxWebKitFailure(browserName, reason) {
  test.fail(browserName === "webkit" && process.platform === "linux", reason);
}


// Records when the audio can be heard: it starts ("sound") and stops ("silence"), with the
// time in the audio. Silences keep the element playing, muted (so an iPhone with its
// screen locked keeps going), so play and pause events alone no longer show them. The
// element's own play, pause and muted are watched as they are called, not by their
// events, which arrive later: a 0-second silence would otherwise be missed.
export async function traceSound(page) {
  await page.locator("#audio").evaluate((audio) => {
    const proto = HTMLMediaElement.prototype;
    const muted = Object.getOwnPropertyDescriptor(proto, "muted");
    let audible = !audio.paused && !audio.muted;
    window.sound = [];
    const note = () => {
      const now = !audio.paused && !audio.muted;
      if (now === audible) return;
      audible = now;
      window.sound.push({ type: now ? "sound" : "silence", at: performance.now(), time: audio.currentTime });
    };
    Object.defineProperty(audio, "muted", {
      configurable: true,
      get() { return muted.get.call(this); },
      set(value) { muted.set.call(this, value); note(); },
    });
    audio.play = function () { const started = proto.play.call(this); note(); return started; };
    audio.pause = function () { proto.pause.call(this); note(); };
    for (const type of ["play", "pause", "ended"]) audio.addEventListener(type, note);
  });
}
export const soundTrace = (page) => page.evaluate(() => window.sound);
// The first silence: where and when the sound stopped, and when it came back.
export async function firstSilence(page) {
  const trace = await soundTrace(page);
  const stop = trace.find((x) => x.type === "silence");
  expect(stop).toBeTruthy();
  const resume = trace.find((x) => x.type === "sound" && x.at >= stop.at && x !== trace[0]);
  expect(resume).toBeTruthy();
  return { stop, resume, ms: resume.at - stop.at };
}
