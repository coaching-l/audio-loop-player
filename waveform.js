// Loudness over time for the gauge, and the pauses between phrases.
// Audio is decoded at a low sample rate so a long file stays small in memory.
const MAX_BYTES = 40 * 1024 * 1024;
const STEP = 0.01; // seconds per level

export async function analyzeAudio(file) {
  const Offline =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline || file.size > MAX_BYTES) return null;
  const bytes = await file.arrayBuffer();
  let buffer = null;
  // Some engines refuse very low rates; fall back to more common ones.
  for (const rate of [8000, 22050, 44100]) {
    try {
      buffer = await new Offline(1, 1, rate).decodeAudioData(bytes.slice(0));
      break;
    } catch {
      /* Try the next rate; give up after the last. */
    }
  }
  if (!buffer) return null;
  const size = Math.max(1, Math.round(buffer.sampleRate * STEP));
  const levels = new Float32Array(Math.ceil(buffer.length / size));
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i]);
      const index = (i / size) | 0;
      if (value > levels[index]) levels[index] = value;
    }
  }
  return { levels, step: STEP, phrases: findPhrases(levels) };
}

// A phrase is sound between pauses of at least 0.3 s; tiny blips are dropped.
export function findPhrases(levels, step = STEP) {
  let peak = 0;
  for (const level of levels) if (level > peak) peak = level;
  if (!peak) return [];
  const threshold = peak * 0.08;
  const minPause = Math.round(0.3 / step);
  const phrases = [];
  let start = -1;
  let quiet = 0;
  const close = (end) => {
    if ((end - start) * step >= 0.2)
      phrases.push({
        start: Math.max(0, (start - 5) * step),
        end: Math.min(levels.length * step, (end + 10) * step),
      });
    start = -1;
  };
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] >= threshold) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet >= minPause) close(i - quiet + 1);
  }
  if (start >= 0) close(levels.length - quiet);
  return phrases;
}

// Draws the part of the audio from viewStart to viewEnd across the whole canvas.
export function drawWaveform(canvas, analysis, viewStart, viewEnd, a, b) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const style = getComputedStyle(canvas);
  const inside = style.getPropertyValue("--wave-inside").trim();
  const outside = style.getPropertyValue("--wave-outside").trim();
  const { levels, step } = analysis;
  let peak = 0;
  for (const level of levels) if (level > peak) peak = level;
  const bar = Math.max(1, Math.round(2 * ratio));
  const gapWidth = Math.max(1, Math.round(ratio));
  const span = viewEnd - viewStart;
  // Zoomed in, a bar can cover less than one level, so blocky steps are expected.
  for (let x = 0; x < width; x += bar + gapWidth) {
    const from = Math.floor((viewStart + (x / width) * span) / step);
    const to = Math.max(
      from + 1,
      Math.floor((viewStart + ((x + bar) / width) * span) / step),
    );
    let level = 0;
    for (let i = from; i < to && i < levels.length; i++)
      if (levels[i] > level) level = levels[i];
    const h = Math.max(ratio, (peak ? level / peak : 0) * height);
    const time = viewStart + ((x + bar / 2) / width) * span;
    context.fillStyle = time >= a && time <= b ? inside : outside;
    context.fillRect(x, (height - h) / 2, bar, h);
  }
}
