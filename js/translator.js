// 100% Free Client-Side Translation (Parallel Google GTX batching + Cache + MyMemory fallback)

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

function buildBatches(lines, code) {
  const MAX_LINES = 25;
  const MAX_CHARS = 1500;
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
      current.length >= MAX_LINES ||
      (current.length > 0 && currentChars + clean.length > MAX_CHARS)
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

export async function translateBatch(lines, targetLanguage, onProgress) {
  const code = getLangCode(targetLanguage);
  const results = new Array(lines.length).fill("");
  let completedCount = 0;

  // Fill empty lines and cache hits immediately
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

  const batches = buildBatches(lines, code);
  const CONCURRENCY = 6;
  let nextBatchIdx = 0;

  async function processBatch(batch) {
    const joined = batch.map((item) => item.text).join("\n");
    let translatedLines = null;

    try {
      const translatedJoined = await translateViaGTX(joined, code);
      const parts = translatedJoined.split(/\r?\n/).map((p) => p.trim());
      if (parts.length === batch.length) {
        translatedLines = parts;
      }
    } catch {
      // Fall through to parallel single-line fallback
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
