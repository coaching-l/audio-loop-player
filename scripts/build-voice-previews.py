"""Build real speech previews. Requires numpy, onnxruntime and ffmpeg, only for development.
Run preview-inputs.mjs first; pass its JSON and a directory holding the four model/voice files.
No model files or Python dependencies are shipped with the website.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
import onnxruntime as ort

root = Path(__file__).resolve().parent.parent
inputs = json.loads(Path(sys.argv[1]).read_text())
models = Path(sys.argv[2])
output = root / "voice-previews"
output.mkdir(exist_ok=True)
source = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
names = {"en": ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin"),
         "zh": ("kokoro-v1.1-zh.onnx", "voices-v1.1-zh.bin")}
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {"sampleRate": 24000, "speed": 1, "kbps": 128, "sources": {}, "clips": [],
            "frontendHashes": {p: digest(root / p) for p in
                               ["english.js", "mandarin.js", "mandarin-lexicon.js", "voices.js"]}}
for lang, (model_name, voice_name) in names.items():
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    session = ort.InferenceSession(str(models / model_name), opts, providers=["CPUExecutionProvider"])
    config = json.loads(session.get_modelmeta().custom_metadata_map["kokoro_config"])
    vocab = config["vocab"]
    voices = np.load(models / voice_name, allow_pickle=False)
    manifest["sources"][lang] = [{"url": source + name, "sha256": digest(models / name)}
                                 for name in [model_name, voice_name]]
    for item in [v for v in inputs if v["lang"] == lang]:
        phones = item["phonemes"]
        assert all(c in vocab for c in phones), "Unknown phoneme; do not silently drop it"
        ids = np.array([[0] + [vocab[c] for c in phones] + [0]], dtype=np.int64)
        # Same length-indexed style selection as tts-worker.js (including its bounds).
        style = voices[item["id"]][min(len(phones), 509)].reshape(1, 256).astype(np.float32)
        samples = session.run(None, {"input_ids": ids, "style": style,
                                    "speed": np.array([1], dtype=np.float32)})[0].flatten()
        assert len(samples) and np.isfinite(samples).all() and np.max(np.abs(samples)) > 0.01
        path = output / (item["id"] + ".mp3")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", "24000", "-ac", "1",
                        "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "128k", str(path)],
                       input=samples.astype("<f4").tobytes(), check=True)
        clip = {**item, "seconds": len(samples) / 24000, "file": path.name,
                "bytes": path.stat().st_size, "sha256": digest(path)}
        manifest["clips"].append(clip)
        print(item["id"], round(clip["seconds"], 2), clip["bytes"], flush=True)
    del session
(output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
