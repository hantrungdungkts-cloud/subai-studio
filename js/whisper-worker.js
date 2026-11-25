// Dedicated Web Worker running Whisper AI 100% locally in the browser via Transformers.js (WebGPU / ONNX-WASM q8)
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let loadedModelKey = null;
let activeDevice = "wasm";

const MODEL_MAP = {
  "whisper-tiny": "onnx-community/whisper-tiny",
  "whisper-tiny.en": "onnx-community/whisper-tiny.en",
  "whisper-base": "onnx-community/whisper-base",
  "whisper-small": "onnx-community/whisper-small",
};

const LANG_MAP = {
  auto: null,
  English: "english",
  "Tiếng Việt": "vietnamese",
  "日本語 (Japanese)": "japanese",
  "한국어 (Korean)": "korean",
  "中文 (Chinese)": "chinese",
  "Français": "french",
  Deutsch: "german",
  "Español": "spanish",
};

async function detectBestDevice() {
  try {
    if (typeof navigator !== "undefined" && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    // Fallback to WASM
  }
  return "wasm";
}

async function getPipeline(modelKey, sourceLanguage) {
  let effectiveKey = modelKey || "whisper-tiny";
  // Use faster English-only tiny model when source language is explicitly English
  if (effectiveKey === "whisper-tiny" && sourceLanguage === "English") {
    effectiveKey = "whisper-tiny.en";
  }

  const hfModel = MODEL_MAP[effectiveKey] || MODEL_MAP["whisper-tiny"];
  if (transcriber && loadedModelKey === hfModel) {
    return transcriber;
  }

  const preferredDevice = await detectBestDevice();
  const accelLabel = preferredDevice === "webgpu" ? "GPU (WebGPU siêu tốc)" : "CPU (WASM q8 tối ưu)";

  self.postMessage({
    type: "status",
    message: `Đang nạp mô hình AI (${effectiveKey}) chế độ ${accelLabel}...`,
    progress: 5,
  });

  const onProgress = (info) => {
    if (info.status === "progress" && typeof info.progress === "number") {
      const pct = Math.min(45, Math.max(5, Math.round(5 + info.progress * 0.4)));
      self.postMessage({
        type: "status",
        message: `Đang tải mô hình AI (${info.file || effectiveKey}): ${Math.round(info.progress)}%`,
        progress: pct,
      });
    } else if (info.status === "ready") {
      self.postMessage({
        type: "status",
        message: `Mô hình Whisper AI (${accelLabel}) đã sẵn sàng! Đang phân tích giọng nói...`,
        progress: 48,
      });
    }
  };

  if (preferredDevice === "webgpu") {
    try {
      transcriber = await pipeline("automatic-speech-recognition", hfModel, {
        dtype: {
          encoder_model: "fp32",
          decoder_model_merged: "q4",
        },
        device: "webgpu",
        progress_callback: onProgress,
      });
      activeDevice = "webgpu";
      loadedModelKey = hfModel;
      return transcriber;
    } catch (gpuErr) {
      console.warn("WebGPU pipeline failed, falling back to WASM q8:", gpuErr);
    }
  }

  // Optimized WASM q8 for both encoder & decoder (2x-3x faster & 65% smaller than fp32 on mobile)
  transcriber = await pipeline("automatic-speech-recognition", hfModel, {
    dtype: {
      encoder_model: "q8",
      decoder_model_merged: "q8",
    },
    device: "wasm",
    progress_callback: onProgress,
  });

  activeDevice = "wasm";
  loadedModelKey = hfModel;
  return transcriber;
}

self.addEventListener("message", async (e) => {
  const { type, audio, modelKey, sourceLanguage } = e.data || {};
  if (type !== "transcribe") return;

  try {
    const pipe = await getPipeline(modelKey || "whisper-tiny", sourceLanguage);

    self.postMessage({
      type: "status",
      message: `Whisper AI (${activeDevice === "webgpu" ? "WebGPU" : "WASM q8"}) đang nghe và tạo phụ đề...`,
      progress: 52,
    });

    const lang = LANG_MAP[sourceLanguage] || null;
    const options = {
      chunk_length_s: 25,
      stride_length_s: 4,
      return_timestamps: true,
      task: "transcribe",
    };
    if (activeDevice === "webgpu") {
      options.batch_size = 4;
    }
    if (lang) {
      options.language = lang;
    }

    const result = await pipe(audio, options);

    const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
    const segments = [];
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const text = (ch.text || "").trim();
      if (!text) continue;
      const start = Array.isArray(ch.timestamp) && typeof ch.timestamp[0] === "number" ? ch.timestamp[0] : 0;
      const end =
        Array.isArray(ch.timestamp) && typeof ch.timestamp[1] === "number"
          ? ch.timestamp[1]
          : start + 2.5;
      segments.push({
        start: Number(Math.max(0, start).toFixed(3)),
        end: Number(Math.max(start + 0.3, end).toFixed(3)),
        text,
      });
    }

    if (!segments.length && result?.text?.trim()) {
      segments.push({
        start: 0,
        end: Math.max(2, Number((audio.length / 16000).toFixed(2))),
        text: result.text.trim(),
      });
    }

    self.postMessage({
      type: "complete",
      segments,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err?.message || String(err),
    });
  }
});
