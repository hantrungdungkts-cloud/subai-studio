// Ultra-Fast Client-Side Translation:
// 1. Groq Llama-3.1-8B-Instant (~1000 tok/s, 60 lines/batch, 4 concurrent = <1s for whole video!)
// 2. Fallback: 8-way parallel Google GTX batching + Cache + MyMemory

const TARGET_LANG_CODES = {
  "Tiếng Việt": "vi",
  English: "en",
  "日本語 (Japanese)": "ja",
  "한국어 (Korean)": "ko",
  "中文 (简体)": "zh-CN",
  "中文 (繁體)": "zh-TW",
  "Français": "fr",
  Deutsch: "de",
  "Español": "es",
  "ภาษาไทย (Thai)": "th",
};

const translationCache = new Map();

export function getLangCode(label) {
  return TARGET_LANG_CODES[label] || "vi";
}

async function translateViaGTX(text, targetCode) {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
      targetCode
    )}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GTX HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Invalid GTX response");
  }
  return data[0].map((part) => (part && part[0] ? part[0] : "")).join("");
}

async function translateViaMyMemory(text, targetCode) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text
  )}&langpair=en|${encodeURIComponent(targetCode)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  if (!translated) throw new Error("Empty MyMemory response");
  return translated;
}

async function translateBatchViaGroqLLM(batchItems, targetLanguage, groqApiKey, style) {
  const payload = batchItems.map((it, idx) => `${idx}|${it.text}`).join("\n");
  const styleNote =
    style === "cinema"
      ? "natural cinematic movie subtitle style"
      : style === "casual"
      ? "friendly casual conversational style"
      : style === "formal"
      ? "polite formal style"
      : "natural fluent subtitle style";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey.trim()}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are an expert subtitle translator. Translate each line to ${targetLanguage} in ${styleNote}. Input format is "index|text". Output ONLY the exact same number of lines in "index|translated_text" format, no extra commentary.`,
        },
        {
          role: "user",
          content: payload,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq LLM HTTP ${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const out = new Array(batchItems.length).fill(null);
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const sepIdx = line.indexOf("|");
    if (sepIdx === -1) continue;
    const idxNum = parseInt(line.slice(0, sepIdx).trim(), 10);
    if (!Number.isNaN(idxNum) && idxNum >= 0 && idxNum < batchItems.length) {
      const val = line.slice(sepIdx + 1).trim();
      if (val) out[idxNum] = val;
    }
  }

  // Require at least 85% parsed lines to accept batch
  const validCount = out.filter((x) => x !== null).length;
  if (validCount < Math.ceil(batchItems.length * 0.85)) {
    throw new Error("Groq LLM batch line mismatch");
  }
  return out.map((v, idx) => v || batchItems[idx].text);
}

export async function translateSingleLine(text, targetLanguage) {
  const clean = (text || "").trim();
  if (!clean) return "";
  const code = getLangCode(targetLanguage);
  const cacheKey = `${code}::${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  try {
    const out = (await translateViaGTX(clean, code)).trim();
    translationCache.set(cacheKey, out);
    return out;
  } catch {
    try {
      const out = (await translateViaMyMemory(clean, code)).trim();
      translationCache.set(cacheKey, out);
      return out;
    } catch {
      return clean;
    }
  }
}

function buildBatches(lines, code, maxLines, maxChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const clean = (lines[i] || "").replace(/\s+/g, " ").trim();
    const cacheKey = `${code}::${clean}`;
    if (!clean || translationCache.has(cacheKey)) {
      continue;
    }
    if (
      current.length >= maxLines ||
      (current.length > 0 && currentChars + clean.length > maxChars)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push({ index: i, text: clean });
    currentChars += clean.length + 1;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export async function translateBatch(lines, targetLanguage, onProgress, options = {}) {
  const code = getLangCode(targetLanguage);
  const groqApiKey = (options.groqApiKey || "").trim();
  const style = options.style || "natural";
  const results = new Array(lines.length).fill("");
  let completedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const clean = (lines[i] || "").replace(/\s+/g, " ").trim();
    if (!clean) {
      results[i] = "";
      completedCount++;
      continue;
    }
    const cacheKey = `${code}::${clean}`;
    if (translationCache.has(cacheKey)) {
      results[i] = translationCache.get(cacheKey);
      completedCount++;
    }
  }

  if (onProgress && completedCount > 0) {
    onProgress(completedCount, lines.length);
  }

  const useGroq = Boolean(groqApiKey);
  const batches = buildBatches(lines, code, useGroq ? 60 : 30, useGroq ? 3500 : 1700);
  const CONCURRENCY = useGroq ? 4 : 8;
  let nextBatchIdx = 0;

  async function processBatch(batch) {
    let translatedLines = null;

    if (useGroq) {
      try {
        translatedLines = await translateBatchViaGroqLLM(batch, targetLanguage, groqApiKey, style);
      } catch {
        // Fallback to GTX if Groq rate-limited
      }
    }

    if (!translatedLines) {
      const joined = batch.map((item) => item.text).join("\n");
      try {
        const translatedJoined = await translateViaGTX(joined, code);
        const parts = translatedJoined.split(/\r?\n/).map((p) => p.trim());
        if (parts.length === batch.length) {
          translatedLines = parts;
        }
      } catch {}
    }

    if (!translatedLines) {
      translatedLines = await Promise.all(
        batch.map((item) => translateSingleLine(item.text, targetLanguage))
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const out = (translatedLines[j] || "").trim() || item.text;
      results[item.index] = out;
      translationCache.set(`${code}::${item.text}`, out);
    }

    completedCount += batch.length;
    if (onProgress) {
      onProgress(Math.min(lines.length, completedCount), lines.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (nextBatchIdx < batches.length) {
      const idx = nextBatchIdx++;
      await processBatch(batches[idx]);
    }
  });

  await Promise.all(workers);
  return results;
}
