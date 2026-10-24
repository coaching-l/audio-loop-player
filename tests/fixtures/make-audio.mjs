// A real, decodable PCM WAV: two alternating tones with a soft envelope.
// Generated locally; no copyrighted teaching material or external requests.
export function makeWav(seconds = 3, frequency = 440) {
  const sampleRate = 22050;
  const samples = Math.round(seconds * sampleRate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 40, (seconds - t) * 40);
    wav.writeInt16LE(
      Math.round(
        7000 *
          envelope *
          Math.sin(
            2 *
              Math.PI *
              (Math.floor(t * 2) % 2 ? frequency * 1.25 : frequency) *
              t,
          ),
      ),
      44 + i * 2,
    );
  }
  return wav;
}

// Short tones separated by silence, like phrases in speech, for pause detection.
export function makePhrasesWav(parts = [0.5, 0.6, 0.5, 0.6, 0.5]) {
  const sampleRate = 22050;
  const total = Math.round(parts.reduce((sum, s) => sum + s, 0) * sampleRate);
  const wav = Buffer.alloc(44 + total * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(36 + total * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(total * 2, 40);
  let offset = 0;
  parts.forEach((seconds, index) => {
    const samples = Math.round(seconds * sampleRate);
    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      const envelope = Math.min(1, t * 40, (seconds - t) * 40);
      // Even parts are tones, odd parts are silence.
      const value =
        index % 2 ? 0 : 8000 * envelope * Math.sin(2 * Math.PI * 330 * t);
      wav.writeInt16LE(Math.round(value), 44 + (offset + i) * 2);
    }
    offset += samples;
  });
  return wav;
}
