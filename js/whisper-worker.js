// Dedicated Web Worker running Whisper AI 100% locally in the browser via Transformers.js (ONNX/WASM/WebGPU)
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let loadedModelId = null;

const MODEL_MAP = {
  "whisper-tiny": "onnx-community/whisper-tiny",
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
  "Deutsch": "german",
  "Español": "spanish",
};

async function getPipeline(modelKey) {
  const hfModel = MODEL_MAP[modelKey] || MODEL_MAP["whisper-tiny"];
  if (transcriber && loadedModelId === hfModel) {
    return transcriber;
  }

  self.postMessage({
    type: "status",
    message: `Đang tải mô hình AI (${modelKey}) về trình duyệt (chỉ tải 1 lần duy nhất)...`,
    progress: 5,
  });

  // Use WASM q8 by default for maximum compatibility across Android, iOS, and PC browsers
  transcriber = await pipeline("automatic-speech-recognition", hfModel, {
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q8",
    },
    device: "wasm",
    progress_callback: (info) => {
      if (info.status === "progress" && typeof info.progress === "number") {
        const pct = Math.min(45, Math.max(5, Math.round(5 + info.progress * 0.4)));
        self.postMessage({
          type: "status",
          message: `Đang tải file mô hình AI (${info.file || modelKey}): ${Math.round(info.progress)}%`,
          progress: pct,
        });
      } else if (info.status === "ready") {
        self.postMessage({
          type: "status",
          message: "Mô hình Whisper AI đã sẵn sàng! Đang phân tích giọng nói...",
          progress: 48,
        });
      }
    },
  });

  loadedModelId = hfModel;
  return transcriber;
}

self.addEventListener("message", async (e) => {
  const { type, audio, modelKey, sourceLanguage } = e.data || {};
  if (type !== "transcribe") return;

  try {
    const pipe = await getPipeline(modelKey || "whisper-tiny");

    self.postMessage({
      type: "status",
      message: "Whisper AI đang nghe và tạo mốc thời gian phụ đề...",
      progress: 52,
    });

    const lang = LANG_MAP[sourceLanguage] || null;
    const options = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: "transcribe",
    };
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
