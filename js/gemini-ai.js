// Free Google Gemini Flash Cloud Audio Transcription Fallback
// Used when Groq quota is exhausted or when user prefers Gemini API Key (aistudio.google.com/apikey)

function encodeWav16kMonoBytes(pcmFloat32) {
  const numSamples = pcmFloat32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function transcribeChunkGemini(pcmSlice, offsetSec, apiKey, sourceLanguage) {
  const wavBytes = encodeWav16kMonoBytes(pcmSlice);
  const b64 = uint8ToBase64(wavBytes);
  const langHint =
    sourceLanguage && sourceLanguage !== "auto"
      ? `Spoken language is ${sourceLanguage}. `
      : "";

  const prompt =
    `${langHint}Transcribe all spoken dialogue in this audio with accurate start and end timestamps in seconds (relative to 0.0 at start of this clip). ` +
    `Return ONLY a valid JSON array of objects: [{"start": 0.5, "end": 3.2, "text": "..."}]. No markdown, no extra text.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey.trim()
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: "audio/wav",
                  data: b64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API lỗi (${res.status}): ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  let arr = [];
  try {
    arr = JSON.parse(rawText);
  } catch {
    const m = rawText.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  }

  const out = [];
  if (Array.isArray(arr)) {
    for (const s of arr) {
      const text = (s?.text || "").trim();
      if (!text) continue;
      const start = Number((offsetSec + Math.max(0, Number(s.start) || 0)).toFixed(3));
      const end = Number((offsetSec + Math.max((Number(s.start) || 0) + 0.3, Number(s.end) || 0)).toFixed(3));
      out.push({ start, end, text });
    }
  }
  return out;
}

export async function transcribeWithGeminiCloud(pcm16k, apiKey, sourceLanguage, onStatus, onChunkDone) {
  const SAMPLE_RATE = 16000;
  // 4 minutes per chunk (~7.6MB WAV, ~10MB base64, well within Gemini 20MB inline limit)
  const CHUNK_SECONDS = 240;
  const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE;

  const chunks = [];
  for (let s = 0; s < pcm16k.length; s += CHUNK_SAMPLES) {
    const e = Math.min(pcm16k.length, s + CHUNK_SAMPLES);
    chunks.push({ slice: pcm16k.subarray(s, e), offsetSec: s / SAMPLE_RATE });
  }

  if (onStatus) {
    onStatus(`Đang gửi ${chunks.length} đoạn lên Gemini Flash Cloud...`, 15);
  }

  const resultsByChunk = new Array(chunks.length);
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let doneCount = 0;

  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const ch = chunks[idx];
      const segs = await transcribeChunkGemini(ch.slice, ch.offsetSec, apiKey, sourceLanguage);
      resultsByChunk[idx] = segs;
      doneCount++;
      if (onChunkDone) onChunkDone(idx, segs, doneCount, chunks.length);
      if (onStatus) {
        const pct = Math.round(15 + (doneCount / chunks.length) * 60);
        onStatus(`Gemini Cloud đã nhận diện ${doneCount}/${chunks.length} đoạn...`, pct);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()));
  return resultsByChunk.flat();
}
