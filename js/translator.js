// 100% Free Client-Side Translation (Google GTX public endpoint with MyMemory fallback)

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
  try {
    return (await translateViaGTX(clean, code)).trim();
  } catch {
    try {
      return (await translateViaMyMemory(clean, code)).trim();
    } catch {
      return clean;
    }
  }
}

export async function translateBatch(lines, targetLanguage, onProgress) {
  const code = getLangCode(targetLanguage);
  const results = new Array(lines.length).fill("");
  const sep = "\n|||\n";
  const BATCH_SIZE = 12;

  for (let start = 0; start < lines.length; start += BATCH_SIZE) {
    const slice = lines.slice(start, start + BATCH_SIZE);
    const joined = slice.map((t) => (t || "").replace(/\s+/g, " ").trim()).join(sep);

    try {
      const translatedJoined = await translateViaGTX(joined, code);
      const parts = translatedJoined.split(/\s*\|\|\|\s*/);
      if (parts.length === slice.length) {
        for (let j = 0; j < slice.length; j++) {
          results[start + j] = parts[j].trim() || slice[j];
        }
      } else {
        // Fallback line-by-line if separator count mismatched
        for (let j = 0; j < slice.length; j++) {
          results[start + j] = await translateSingleLine(slice[j], targetLanguage);
        }
      }
    } catch {
      for (let j = 0; j < slice.length; j++) {
        results[start + j] = await translateSingleLine(slice[j], targetLanguage);
      }
    }

    if (onProgress) {
      const done = Math.min(lines.length, start + BATCH_SIZE);
      onProgress(done, lines.length);
    }
  }

  return results;
}
