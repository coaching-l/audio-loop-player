// Stands in for tts-worker.js in tests: answers each sentence with a tone as long as the
// text (0.04 s per character), as Kokoro would, after a short delay. A sentence that
// contains "FAIL" fails, as one Kokoro could not read. Calls are counted on the page.
self.onmessage = ({ data }) => {
  setTimeout(() => {
    if (data.text.includes("FAIL")) {
      self.postMessage({ type: "error", error: "読めない文です。" });
      return;
    }
    self.postMessage({
      type: "progress",
      progress: { status: "progress", file: "onnx/model.onnx", loaded: 5, total: 10 },
    });
    const rate = 24000;
    const samples = new Float32Array(Math.round(rate * 0.04 * data.text.length));
    for (let i = 0; i < samples.length; i++)
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
    self.postMessage({ type: "audio", samples, rate });
  }, 30);
};
