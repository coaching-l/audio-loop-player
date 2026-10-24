// All repeat delays use wall-clock milliseconds, independently of playbackRate.
// A relative gap (gapRatio) lasts as long as the interval took to play at the current speed.
export const GAP_RATIOS = [0, 1, 1.5, 2];
// A speed ramp raises the rate after each completed play, up to 1.0x, from the chosen base rate.
export const RAMP_STEPS = [0, 0.05, 0.1];
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
    this.rampStep = 0;
    this.baseRate = 1;
    this.completed = 0;
    this.phase = "paused";
    this.timer = null;
    this.epoch = 0;
    this.remaining = 0;
    this.onEnded = () =>
      this.mode === "off" ? this.finish() : this.boundary();
    this.onTime = () => {
      this.checkBoundary();
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
  // The rate for the next play: the base rate, raised by the ramp for each completed play.
  get rampedRate() {
    if (!this.rampStep || this.baseRate >= 1) return this.baseRate;
    const rate = this.baseRate + this.rampStep * this.completed;
    return Math.min(1, Math.round(rate * 100) / 100);
  }
  configure({ mode, a, b, limit, gap, gapRatio = 0, rampStep = 0 }) {
    if (
      !["off", "ab", "all"].includes(mode) ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      b <= a ||
      b > this.audio.duration + 0.001 ||
      ![0, 2, 3, 5, 10].includes(limit) ||
      !Number.isFinite(gap) ||
      gap < 0 ||
      gap > 10 ||
      !GAP_RATIOS.includes(gapRatio) ||
      !RAMP_STEPS.includes(rampStep)
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
      this.gapRatio === gapRatio &&
      this.rampStep === rampStep
    )
      return;
    const wasActive = this.active;
    this.pause();
    Object.assign(this, { mode, a, b, limit, gap, gapRatio, rampStep });
    this.completed = 0;
    this.applyRate(this.baseRate);
    this.remaining = 0;
    this.phase = "paused";
    if (
      mode === "ab" &&
      (this.audio.currentTime < a || this.audio.currentTime >= b)
    )
      this.audio.currentTime = a;
    this.emit();
    if (wasActive) void this.play();
  }
  setRate(rate) {
    this.baseRate = rate;
    this.applyRate(this.rampedRate);
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
      this.wait(this.remaining);
      return;
    }
    if (
      this.phase === "done" ||
      this.audio.ended ||
      this.audio.currentTime >= this.end
    ) {
      this.completed = 0;
      this.audio.currentTime = this.start;
      this.applyRate(this.baseRate);
    }
    if (this.mode === "ab" && this.audio.currentTime < this.a)
      this.audio.currentTime = this.a;
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
    if (
      this.phase === "playing" &&
      this.mode !== "off" &&
      !this.audio.seeking &&
      this.audio.currentTime >= this.end
    )
      this.boundary();
  }
  boundary() {
    if (this.phase !== "playing") return;
    this.clearTimer();
    this.audio.pause();
    this.audio.currentTime = this.end;
    this.completed++;
    if (this.limit > 0 && this.completed >= this.limit) {
      this.finish();
      return;
    }
    // The silence matches what was just heard, so measure it before speeding up.
    const gap = this.gapMilliseconds;
    this.applyRate(this.rampedRate);
    this.wait(gap);
  }
  wait(milliseconds) {
    this.clearTimer();
    this.phase = "waiting";
    this.remaining = milliseconds;
    this.deadline = performance.now() + milliseconds;
    const epoch = this.epoch;
    this.emit();
    this.timer = setTimeout(() => {
      if (epoch !== this.epoch || this.phase !== "waiting") return;
      this.remaining = 0;
      this.audio.currentTime = this.start;
      this.phase = "paused";
      void this.play();
    }, milliseconds);
  }
  pause() {
    if (this.phase === "disposed") return;
    if (this.phase === "waiting") {
      this.remaining = Math.max(0, this.deadline - performance.now());
      this.phase = "gap-paused";
    } else if (this.phase !== "gap-paused") this.phase = "paused";
    this.clearTimer();
    this.audio.pause();
    this.emit();
  }
  seek(time) {
    const resume = this.active;
    this.pause();
    this.remaining = 0;
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
    this.phase = "done";
    this.remaining = 0;
    this.emit();
  }
  dispose() {
    this.clearTimer();
    this.audio.pause();
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
