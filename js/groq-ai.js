// Ultra-fast Cloud Whisper (Groq whisper-large-v3-turbo: ~200x-300x real-time)
// Supports long videos by slicing 16kHz mono PCM into <20MB WAV chunks and running in parallel.

function encodeWav16kMono(pcmFloat32) {
  const numSamples = pcmFloat32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, 16000, true); // Sample rate
  view.setUint32(28, 32000, true); // Byte rate (16000 * 1 * 2)
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

const GROQ_LANG_ISO = {
  auto: "",
  English: "en",
  "Tiếng Việt": "vi",
  "日本語 (Japanese)": "ja",
  "한국어 (Korean)": "ko",
  "中文 (Chinese)": "zh",
  "Français": "fr",
  Deutsch: "de",
  "Español": "es",
};

async function transcribeChunkGroq(pcmSlice, offsetSeconds, apiKey, sourceLanguage) {
  const wavBlob = encodeWav16kMono(pcmSlice);
  const form = new FormData();
  form.append("file", wavBlob, "audio.wav");
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const iso = GROQ_LANG_ISO[sourceLanguage] || "";
  if (iso) {
    form.append("language", iso);
  }

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = `Groq API lỗi (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) msg = `Groq API: ${parsed.error.message}`;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  const rawSegs = Array.isArray(data.segments) ? data.segments : [];
  const out = [];

  for (const s of rawSegs) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const start = Number((offsetSeconds + (Number(s.start) || 0)).toFixed(3));
    const end = Number((offsetSeconds + Math.max((Number(s.start) || 0) + 0.3, Number(s.end) || 0)).toFixed(3));
    out.push({ start, end, text });
  }

  if (!out.length && data.text?.trim()) {
    out.push({
      start: Number(offsetSeconds.toFixed(3)),
      end: Number((offsetSeconds + pcmSlice.length / 16000).toFixed(3)),
      text: data.text.trim(),
    });
  }

  return out;
}

export async function transcribeWithGroqCloud(pcm16k, apiKey, sourceLanguage, onStatus) {
  const SAMPLE_RATE = 16000;
  // 9 minutes per chunk (~17.3MB WAV, safely under Groq's 25MB limit)
  const CHUNK_SECONDS = 540;
  const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE;

  const chunks = [];
  for (let startSample = 0; startSample < pcm16k.length; startSample += CHUNK_SAMPLES) {
    const endSample = Math.min(pcm16k.length, startSample + CHUNK_SAMPLES);
    chunks.push({
      slice: pcm16k.subarray(startSample, endSample),
      offsetSec: startSample / SAMPLE_RATE,
    });
  }

  if (onStatus) {
    onStatus(
      `Đang gửi ${chunks.length} phần âm thanh lên Groq Cloud (200x tốc độ)...`,
      15
    );
  }

  const resultsByChunk = new Array(chunks.length);
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let doneCount = 0;

  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const ch = chunks[idx];
      const segs = await transcribeChunkGroq(ch.slice, ch.offsetSec, apiKey, sourceLanguage);
      resultsByChunk[idx] = segs;
      doneCount++;
      if (onStatus) {
        const pct = Math.round(15 + (doneCount / chunks.length) * 55);
        onStatus(`Groq Cloud đã nhận diện ${doneCount}/${chunks.length} đoạn video...`, pct);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker())
  );

  return resultsByChunk.flat();
}
