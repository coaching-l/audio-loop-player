// The learner's own voice, kept only in memory for this page; never saved or sent.
export const MAX_RECORDING_SECONDS = 60;

export function recordingSupported() {
  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

export class VoiceRecorder {
  constructor(onStop) {
    this.onStop = onStop;
    this.recorder = null;
    this.stream = null;
    this.timer = null;
    this.startedAt = 0;
  }
  get recording() {
    return this.recorder?.state === "recording";
  }
  get elapsed() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(this.stream);
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      clearTimeout(this.timer);
      this.release();
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      this.onStop(blob.size ? blob : null);
    });
    recorder.start();
    this.startedAt = performance.now();
    this.timer = setTimeout(() => this.stop(), MAX_RECORDING_SECONDS * 1000);
  }
  stop() {
    if (this.recording) this.recorder.stop();
  }
  // Turning the microphone off also clears the browser's recording indicator.
  release() {
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
  }
}
