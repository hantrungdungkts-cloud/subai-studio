// Central application state with pub-sub, localStorage persistence, and Undo/Redo

const STORAGE_KEY = "subai_studio_settings_v1";

export const DEFAULT_STYLE = {
  displayMode: "bilingual", // bilingual | bilingual_orig_top | translated | original
  fontFamily: "Be Vietnam Pro",
  fontSize: 44, // px relative to 1080p height
  originalScale: 0.78,
  bold: true,
  italic: false,
  textColor: "#ffffff",
  originalColor: "#cbd5e1",
  outlineColor: "#000000",
  outlineWidth: 2.0,
  shadowDepth: 1.5,
  bgColor: "#000000",
  bgOpacity: 0.6,
  position: "bottom", // top | middle | bottom
  marginV: 56,
};

export const STYLE_PRESETS = {
  cinema: {
    ...DEFAULT_STYLE,
    fontFamily: "Be Vietnam Pro",
    fontSize: 44,
    textColor: "#ffffff",
    originalColor: "#cbd5e1",
    outlineColor: "#000000",
    outlineWidth: 2.5,
    bgOpacity: 0.0,
    shadowDepth: 2.0,
    bold: true,
  },
  youtube: {
    ...DEFAULT_STYLE,
    fontFamily: "Inter",
    fontSize: 42,
    textColor: "#ffffff",
    originalColor: "#e2e8f0",
    outlineWidth: 0,
    bgColor: "#000000",
    bgOpacity: 0.78,
    bold: false,
  },
  classic: {
    ...DEFAULT_STYLE,
    fontFamily: "Arial",
    fontSize: 46,
    textColor: "#fde047",
    originalColor: "#f8fafc",
    outlineColor: "#000000",
    outlineWidth: 3.0,
    bgOpacity: 0.0,
    bold: true,
  },
  bilingual_study: {
    ...DEFAULT_STYLE,
    displayMode: "bilingual",
    fontFamily: "Be Vietnam Pro",
    fontSize: 42,
    originalScale: 0.85,
    textColor: "#38bdf8",
    originalColor: "#f8fafc",
    bgColor: "#0f172a",
    bgOpacity: 0.82,
    outlineWidth: 1.0,
    bold: true,
  },
};

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const saved = loadSavedSettings();

export const state = {
  // Server info
  hasServerApiKey: false,
  models: [],

  // User AI settings
  apiKey: saved.apiKey || "",
  groqApiKey: saved.groqApiKey || "",
  geminiApiKey: saved.geminiApiKey || "",
  model: saved.model && !saved.model.startsWith("gemini") ? saved.model : "whisper-tiny",
  sourceLanguage: saved.sourceLanguage || "auto",
  targetLanguage: saved.targetLanguage || "Tiếng Việt",
  translationStyle: saved.translationStyle || "natural",
  dubVoiceGender: saved.dubVoiceGender || "female",
  dubEmotion: saved.dubEmotion || "natural",
  contextHint: saved.contextHint || "",

  // Video state
  video: null, // { videoId, filename, videoUrl, duration, width, height, waveform }
  currentTime: 0,
  isPlaying: false,

  // Subtitles & Selection
  subtitles: [], // [{ id, start, end, originalText, translatedText }]
  selectedId: null,
  detectedLanguage: "",
  searchQuery: "",

  // Undo / Redo stacks
  history: [],
  future: [],

  // Style
  style: { ...DEFAULT_STYLE, ...(saved.style || {}) },

  // Timeline
  pxPerSec: 80,
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`Error in listener for ${event}:`, err);
    }
  }
}

export function persistSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: state.apiKey,
        groqApiKey: state.groqApiKey,
        geminiApiKey: state.geminiApiKey,
        model: state.model,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        translationStyle: state.translationStyle,
        dubVoiceGender: state.dubVoiceGender,
        dubEmotion: state.dubEmotion,
        contextHint: state.contextHint,
        style: state.style,
      })
    );
  } catch {
    // ignore quota errors
  }
}

export function pushHistory() {
  state.history.push(JSON.stringify(state.subtitles));
  if (state.history.length > 50) state.history.shift();
  state.future = [];
  emit("history:change");
}

export function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify(state.subtitles));
  state.subtitles = JSON.parse(state.history.pop());
  emit("subtitles:change");
  emit("history:change");
}

export function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify(state.subtitles));
  state.subtitles = JSON.parse(state.future.pop());
  emit("subtitles:change");
  emit("history:change");
}

export function setSubtitles(items, recordHistory = true) {
  if (recordHistory && state.subtitles.length > 0) {
    pushHistory();
  }
  state.subtitles = items
    .map((item, idx) => ({
      id: item.id || `sub-${Date.now()}-${idx}`,
      start: Math.max(0, Number(item.start) || 0),
      end: Math.max((Number(item.start) || 0) + 0.2, Number(item.end) || 0),
      originalText: String(item.originalText ?? ""),
      translatedText: String(item.translatedText ?? ""),
    }))
    .sort((a, b) => a.start - b.start);
  emit("subtitles:change");
}

export function updateSubtitle(id, patch, recordHistory = false) {
  const idx = state.subtitles.findIndex((s) => s.id === id);
  if (idx === -1) return;
  if (recordHistory) pushHistory();
  state.subtitles[idx] = { ...state.subtitles[idx], ...patch };
  emit("subtitles:change", { updatedId: id });
}

export function updateStyle(patch) {
  state.style = { ...state.style, ...patch };
  persistSettings();
  emit("style:change");
}

export function formatTimeShort(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, "0")}:${rem.toFixed(2).padStart(5, "0")}`;
}

export function parseTimeShort(str) {
  const clean = String(str || "0").trim().replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(clean)) return Math.max(0, parseFloat(clean));
  const parts = clean.split(":").map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
}

export function showToast(message, type = "info", duration = 3800) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "all 0.2s ease";
    setTimeout(() => el.remove(), 220);
  }, duration);
}
