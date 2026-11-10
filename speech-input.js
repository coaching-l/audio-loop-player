// Prepare a separate mono copy for recognition; never alter playback or saved audio.
// Ordinary mono/stereo recordings retain the existing averaging behaviour. When
// opposite-phase channels would erase speech, keep the strongest channel instead.
export function speechMono(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const mono = new Float32Array(buffer.length);
  let strongest = 0;
  let strongestEnergy = 0;
  for (let c = 0; c < channels.length; c++) {
    let energy = 0;
    for (let i = 0; i < mono.length; i++) {
      const value = channels[c][i];
      mono[i] += value / channels.length;
      energy += value * value;
    }
    if (energy > strongestEnergy) { strongestEnergy = energy; strongest = c; }
  }
  let mixedEnergy = 0;
  for (const value of mono) mixedEnergy += value * value;
  if (channels.length > 1 && mixedEnergy < strongestEnergy * 0.05)
    mono.set(channels[strongest]);
  return mono;
}

// Whisper can miss very quiet speech. Boost only low-level input, without clipping
// or changing normally recorded speech. Silence stays silent; no denoising or
// automatic word replacement is performed here.
export function normalizeQuietSpeech(samples) {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak < 0.00001 || peak >= 0.02) return samples;
  const gain = Math.min(1000, 0.2 / peak);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}
