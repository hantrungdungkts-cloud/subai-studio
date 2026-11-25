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

export async function transcribeFileDirectlyWithGroq(file, apiKey, sourceLanguage, onStatus) {
  if (onStatus) {
    onStatus(`Đang gửi trực tiếp "${file.name}" lên Groq Cloud...`, 25);
  }
  const form = new FormData();
  form.append("file", file, file.name || "video.mp4");
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
    const start = Number((Number(s.start) || 0).toFixed(3));
    const end = Number(Math.max(start + 0.3, Number(s.end) || 0).toFixed(3));
    out.push({ start, end, text });
  }
  if (!out.length && data.text?.trim()) {
    out.push({ start: 0, end: 5, text: data.text.trim() });
  }
  return out;
}

function compressSilenceForGroq(pcm16k) {
  // Strip silent gaps (> 2.0s) before sending to Groq to save 30-50% of free Groq audio quota!
  const SR = 16000;
  const WIN = SR * 0.5; // 0.5s windows
  const THRESHOLD = 0.003;
  const totalWins = Math.ceil(pcm16k.length / WIN);
  const active = new Uint8Array(totalWins);

  for (let w = 0; w < totalWins; w++) {
    const s = w * WIN;
    const e = Math.min(pcm16k.length, s + WIN);
    let sumSq = 0;
    let cnt = 0;
    for (let i = s; i < e; i += 16) {
      const v = pcm16k[i];
      sumSq += v * v;
      cnt++;
    }
    if (cnt > 0 && Math.sqrt(sumSq / cnt) >= THRESHOLD) {
      // Mark window and 1s padding before/after as active
      for (let p = Math.max(0, w - 2); p <= Math.min(totalWins - 1, w + 2); p++) {
        active[p] = 1;
      }
    }
  }

  // Group contiguous active windows into segments
  const ranges = [];
  let runStart = -1;
  for (let w = 0; w < totalWins; w++) {
    if (active[w] && runStart === -1) runStart = w;
    if ((!active[w] || w === totalWins - 1) && runStart !== -1) {
      const runEnd = active[w] ? w + 1 : w;
      ranges.push({
        origStartSample: runStart * WIN,
        origEndSample: Math.min(pcm16k.length, runEnd * WIN),
      });
      runStart = -1;
    }
  }

  if (!ranges.length) {
    return {
      pcm: pcm16k,
      mapTime: (t) => t,
    };
  }

  let totalSamples = 0;
  for (const r of ranges) totalSamples += r.origEndSample - r.origStartSample;

  // If less than 12% saved, skip re-packing
  if (totalSamples > pcm16k.length * 0.88) {
    return {
      pcm: pcm16k,
      mapTime: (t) => t,
    };
  }

  const compressed = new Float32Array(totalSamples);
  const timeMap = [];
  let cursor = 0;
  for (const r of ranges) {
    const len = r.origEndSample - r.origStartSample;
    compressed.set(pcm16k.subarray(r.origStartSample, r.origEndSample), cursor);
    timeMap.push({
      compStartSec: cursor / SR,
      compEndSec: (cursor + len) / SR,
      origStartSec: r.origStartSample / SR,
    });
    cursor += len;
  }

  const mapTime = (compSec) => {
    for (const seg of timeMap) {
      if (compSec <= seg.compEndSec + 0.05) {
        return seg.origStartSec + Math.max(0, compSec - seg.compStartSec);
      }
    }
    const last = timeMap[timeMap.length - 1];
    return last ? last.origStartSec + (compSec - last.compStartSec) : compSec;
  };

  return { pcm: compressed, mapTime };
}

export async function transcribeWithGroqCloud(pcm16k, apiKeyInput, sourceLanguage, onStatus, onChunkDone) {
  const keys = String(apiKeyInput || "")
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.startsWith("gsk_"));
  if (!keys.length) throw new Error("Groq API Key không hợp lệ.");

  // Save 30-50% Groq quota by stripping long silent sections before upload
  const { pcm, mapTime } = compressSilenceForGroq(pcm16k);
  const SAMPLE_RATE = 16000;
  const CHUNK_SECONDS = 480;
  const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE;

  const chunks = [];
  for (let startSample = 0; startSample < pcm.length; startSample += CHUNK_SAMPLES) {
    const endSample = Math.min(pcm.length, startSample + CHUNK_SAMPLES);
    chunks.push({
      slice: pcm.subarray(startSample, endSample),
      offsetSec: startSample / SAMPLE_RATE,
    });
  }

  if (onStatus) {
    onStatus(
      `Đang gửi ${chunks.length} đoạn (đã nén khoảng lặng tiết kiệm Groq)...`,
      15
    );
  }

  const resultsByChunk = new Array(chunks.length);
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let doneCount = 0;
  let keyIdx = 0;

  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const ch = chunks[idx];
      let segs = null;
      let lastErr = null;

      for (let attempt = 0; attempt < keys.length; attempt++) {
        const currentKey = keys[(keyIdx + attempt) % keys.length];
        try {
          segs = await transcribeChunkGroq(ch.slice, ch.offsetSec, currentKey, sourceLanguage);
          break;
        } catch (err) {
          lastErr = err;
          if (String(err?.message || "").includes("429") && attempt + 1 < keys.length) {
            keyIdx = (keyIdx + 1) % keys.length;
            continue;
          }
          throw err;
        }
      }
      if (!segs) throw lastErr || new Error("Groq Cloud lỗi");

      const mapped = segs.map((s) => ({
        start: Number(mapTime(s.start).toFixed(3)),
        end: Number(mapTime(s.end).toFixed(3)),
        text: s.text,
      }));
      resultsByChunk[idx] = mapped;
      doneCount++;
      if (onChunkDone) {
        onChunkDone(idx, mapped, doneCount, chunks.length);
      }
      if (onStatus) {
        const pct = Math.round(15 + (doneCount / chunks.length) * 60);
        onStatus(`Groq Cloud đã nhận diện ${doneCount}/${chunks.length} đoạn...`, pct);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker())
  );

  return resultsByChunk.flat();
}
