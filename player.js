// All repeat delays use wall-clock milliseconds, independently of playbackRate.
// A relative gap (gapRatio) lasts as long as the interval took to play at the current speed.
export const GAP_RATIOS = [0, 1, 1.5, 2];
// "off" plays through once; "ab" repeats A–B; "whole" repeats the whole audio.
export const MODES = ["off", "ab", "whole"];
// Seconds before the end that count as the end when starting playback.
const END_SLACK = 0.05;
// While playing through ("off"), the player can stop after each sentence for as long as
// `pauseFor(seconds the sentence took)` says, then go on from where it stopped.
//
// During such a silence the audio keeps playing, muted, instead of pausing: with the
// screen locked, a phone may suspend a page whose audio has stopped (so the silence never
// ends), and may refuse to start it again without a tap. `position` is the time to show
// meanwhile (where the silence began), not where the muted audio happens to be.
export class LoopPlayer {
  constructor(audio, onChange = () => {}, onError = () => {}) {
    this.audio = audio;
    this.onChange = onChange;
    this.onError = onError;
    this.mode = "off";
    this.a = 0;
    this.b = 0;
    this.limit = 2;
    this.gap = 0;
    this.gapRatio = 0;
    this.baseRate = 1;
    this.completed = 0;
    this.phase = "paused";
    this.timer = null;
    this.epoch = 0;
    this.remaining = 0;
    this.stops = [];
    this.stopIndex = -1;
    this.pauseFor = () => 0;
    this.resumeAt = null;
    this.heldAt = null; // the time shown during a silence
    this.onEnded = () => {
      // The muted audio ran to the end during a silence: keep it going.
      if (this.phase === "waiting") return this.keepSounding(this.start);
      return this.mode === "off" ? this.finish() : this.boundary();
    };
    this.onTime = () => {
      // Timers may be held back while the screen is locked; the audio's own time events
      // still come, so a silence also ends from here.
      if (this.phase === "waiting" && performance.now() >= this.deadline)
        this.endSilence(this.epoch);
      else this.checkBoundary();
      this.emit();
    };
    audio.addEventListener("ended", this.onEnded);
    audio.addEventListener("timeupdate", this.onTime);
  }
  get start() {
    return this.mode === "ab" ? this.a : 0;
  }
  get end() {
    return this.mode === "ab" ? this.b : this.audio.duration;
  }
  get active() {
    return this.phase === "playing" || this.phase === "waiting";
  }
  get position() {
    return this.heldAt ?? this.audio.currentTime;
  }
  // Plays on, muted, from `time` (a silence keeps the audio going).
  keepSounding(time) {
    this.audio.muted = true;
    // WebKit can report the end while not paused, and then stand still there; stopping
    // first makes the play below start it again, as before silences were muted (CI).
    if (this.audio.ended && !this.audio.paused) this.audio.pause();
    this.audio.currentTime = time;
    if (this.audio.paused) this.audio.play().catch(() => {});
  }
  // Back to the shown time, audible, with no silence held.
  settle() {
    if (this.heldAt !== null) this.audio.currentTime = this.heldAt;
    this.heldAt = null;
    this.audio.muted = false;
  }
  emit() {
    this.onChange(this);
  }
  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.epoch++;
  }
  get gapMilliseconds() {
    if (!this.gapRatio) return this.gap * 1000;
    return (
      ((this.end - this.start) / this.audio.playbackRate) * this.gapRatio * 1000
    );
  }
  configure({ mode, a, b, limit, gap, gapRatio = 0 }) {
    if (
      !MODES.includes(mode) ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      b <= a ||
      b > this.audio.duration + 0.001 ||
      ![0, 2, 3, 5, 10].includes(limit) ||
      !Number.isFinite(gap) ||
      gap < 0 ||
      gap > 10 ||
      !GAP_RATIOS.includes(gapRatio)
    ) {
      throw new Error(
        "開始点Aは終了点Bより前に、Bは音声の長さ以内にしてください。",
      );
    }
    if (
      this.mode === mode &&
      this.a === a &&
      this.b === b &&
      this.limit === limit &&
      this.gap === gap &&
      this.gapRatio === gapRatio
    )
      return;
    const wasActive = this.active;
    this.pause();
    this.settle();
    Object.assign(this, { mode, a, b, limit, gap, gapRatio });
    this.completed = 0;
    this.remaining = 0;
    this.resumeAt = null;
    this.phase = "paused";
    if (
      mode === "ab" &&
      (this.audio.currentTime < a || this.audio.currentTime >= b)
    )
      this.audio.currentTime = a;
    this.emit();
    if (wasActive) void this.play();
  }
  // Sentences ({ start, end } in seconds) to stop after while playing through.
  setStops(stops = [], pauseFor = () => 0) {
    this.stops = stops;
    this.pauseFor = pauseFor;
    this.findStop();
  }
  findStop() {
    const time = this.audio.currentTime;
    this.stopIndex = this.stops.findIndex((s) => s.end > time + 0.05);
  }
  setRate(rate) {
    this.baseRate = rate;
    this.applyRate(rate);
  }
  applyRate(rate) {
    this.audio.preservesPitch = true;
    if ("webkitPreservesPitch" in this.audio)
      this.audio.webkitPreservesPitch = true;
    this.audio.playbackRate = rate;
    this.emit();
  }
  async play() {
    if (this.active || this.phase === "disposed") return;
    if (this.phase === "gap-paused") {
      this.wait(this.remaining, this.resumeAt);
      return;
    }
    // At (or within a hair of) the end of the audio there is nothing left to play: start
    // over. WebKit can stop a paused element a few microseconds short of its duration,
    // and playing from there it neither moves nor sends "ended". The allowance is for the
    // end of the audio only: an A–B interval can be shorter than it, and each repeat
    // starts at A, where it must not reset the count.
    const nearAudioEnd =
      this.mode !== "ab" &&
      this.audio.currentTime > this.start &&
      this.audio.currentTime >= this.end - END_SLACK;
    if (
      this.phase === "done" ||
      this.audio.ended ||
      this.audio.currentTime >= this.end ||
      nearAudioEnd
    ) {
      this.completed = 0;
      this.audio.currentTime = this.start;
    }
    if (this.mode === "ab" && this.audio.currentTime < this.a)
      this.audio.currentTime = this.a;
    this.findStop();
    this.phase = "playing";
    this.emit();
    const epoch = this.epoch;
    try {
      await this.audio.play();
      if (epoch !== this.epoch || this.phase !== "playing") return;
      this.tick();
    } catch (error) {
      if (epoch !== this.epoch || this.phase === "disposed") return;
      this.pause();
      this.onError(
        error.name === "NotAllowedError"
          ? "ブラウザが再生を止めました。再生ボタンをもう一度押してください。"
          : "音声を再生できません。MP3・M4A・WAVなど、別のファイルをお試しください。",
      );
    }
  }
  tick() {
    if (this.phase !== "playing") return;
    this.checkBoundary();
    this.emit();
    if (this.phase === "playing")
      this.timer = setTimeout(() => this.tick(), 15);
  }
  checkBoundary() {
    if (this.phase !== "playing" || this.audio.seeking) return;
    // The element has ended but its "ended" event did not come (seen in WebKit):
    // handle it the same way rather than stay "playing" for ever.
    if (this.mode !== "ab" && this.audio.ended) {
      this.onEnded();
      return;
    }
    if (this.mode === "ab") {
      if (this.audio.currentTime >= this.end) this.boundary();
      return;
    }
    // Whole-audio shadowing uses the native ended event, with no sentence pauses.
    if (this.mode === "whole") return;
    const stop = this.stops[this.stopIndex];
    if (stop && this.audio.currentTime >= stop.end) this.sentenceEnd(stop);
  }
  sentenceEnd(stop) {
    this.findStop();
    // The last sentence runs into the end of the audio; nothing to wait for there.
    if (stop.end >= this.audio.duration - 0.05) return;
    const seconds = this.pauseFor(
      (stop.end - stop.start) / this.audio.playbackRate,
    );
    if (!(seconds > 0)) return;
    this.clearTimer();
    this.wait(seconds * 1000, this.audio.currentTime);
  }
  boundary() {
    if (this.phase !== "playing") return;
    this.clearTimer();
    this.completed++;
    if (this.limit > 0 && this.completed >= this.limit) {
      this.audio.pause();
      this.audio.currentTime = this.end;
      this.finish();
      return;
    }
    this.wait(this.gapMilliseconds, null, this.end);
  }
  // Silence, then playback again from `resumeAt` (after a sentence) or the start (a repeat).
  // The audio plays on muted meanwhile; `shownAt` is the time to show.
  wait(milliseconds, resumeAt = null, shownAt = resumeAt) {
    this.clearTimer();
    if (milliseconds <= 0) {
      // No silence (whole repeat, or a silence of 0 s): straight on, as before silences
      // were muted, but with no timer in between, which a locked iPhone may hold back.
      this.remaining = 0;
      this.resumeAt = null;
      this.heldAt = null;
      this.audio.muted = false;
      this.audio.pause();
      this.audio.currentTime = resumeAt ?? this.start;
      this.phase = "paused";
      void this.play();
      return;
    }
    this.phase = "waiting";
    this.resumeAt = resumeAt;
    this.remaining = milliseconds;
    this.deadline = performance.now() + milliseconds;
    this.heldAt = shownAt ?? this.heldAt ?? this.audio.currentTime;
    this.keepSounding(resumeAt ?? this.start);
    const epoch = this.epoch;
    this.emit();
    this.timer = setTimeout(() => this.endSilence(epoch), milliseconds);
  }
  endSilence(epoch) {
    if (epoch !== this.epoch || this.phase !== "waiting") return;
    this.clearTimer();
    this.remaining = 0;
    this.audio.currentTime = this.resumeAt ?? this.start;
    this.resumeAt = null;
    this.heldAt = null;
    this.audio.muted = false;
    this.phase = "paused";
    void this.play();
  }
  pause() {
    if (this.phase === "disposed") return;
    const silent = this.phase === "waiting";
    if (silent) {
      this.remaining = Math.max(0, this.deadline - performance.now());
      this.phase = "gap-paused";
    } else if (this.phase !== "gap-paused") this.phase = "paused";
    this.clearTimer();
    this.audio.pause();
    // Paused during a silence: the muted audio stops where the silence began, audible
    // again (playing on resumes the rest of the silence first).
    if (silent) {
      this.audio.currentTime = this.heldAt;
      this.audio.muted = false;
    }
    this.emit();
  }
  seek(time) {
    const resume = this.active;
    this.pause();
    this.settle();
    this.remaining = 0;
    this.resumeAt = null;
    this.phase = "paused";
    const min = this.mode === "ab" ? this.a : 0;
    const max = this.mode === "ab" ? this.b : this.audio.duration;
    this.audio.currentTime = Math.min(max, Math.max(min, time));
    this.emit();
    if (resume) void this.play();
  }
  finish() {
    this.clearTimer();
    this.audio.pause();
    this.settle();
    this.phase = "done";
    this.remaining = 0;
    this.emit();
  }
  dispose() {
    this.clearTimer();
    this.audio.pause();
    this.heldAt = null;
    this.audio.muted = false;
    this.phase = "disposed";
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("timeupdate", this.onTime);
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
export function parseTime(text) {
  const value = text.trim();
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return Number(value);
  const match = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}
export function formatTime(seconds, precision = 3) {
  if (!Number.isFinite(seconds)) return "0:00";
  const factor = 10 ** precision;
  const units = Math.max(0, Math.round(seconds * factor));
  const minutes = Math.floor(units / (60 * factor));
  const rest = ((units % (60 * factor)) / factor)
    .toFixed(precision)
    .padStart(precision ? precision + 3 : 2, "0");
  return `${minutes}:${rest}`;
}
