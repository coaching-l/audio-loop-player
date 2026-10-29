# Removes the attention outputs (encoder_attentions.0-5) from the Whisper encoder.
#
# Xenova/whisper-base's encoder returns each layer's attention weights besides its
# result. Nothing here uses them, but ONNX Runtime keeps every graph output until the
# run ends: six 8x1500x1500 tensors, about 430 MB, which made an iPhone reload the page.
# Only the list of outputs changes; nodes and weights stay as they are.
#
# Usage: python3 scripts/strip-encoder-attentions.py SOURCE.onnx models/whisper-base/onnx/encoder_model_quantized.onnx
# (needs the onnx package: pip install onnx)
import sys

import onnx

source, target = sys.argv[1], sys.argv[2]
model = onnx.load(source)
kept = [o for o in model.graph.output if not o.name.startswith("encoder_attentions")]
removed = len(model.graph.output) - len(kept)
del model.graph.output[:]
model.graph.output.extend(kept)
onnx.checker.check_model(model)
onnx.save(model, target)
print(f"removed {removed} outputs; kept {[o.name for o in kept]}")
