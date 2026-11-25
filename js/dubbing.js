// AI Voice-Over / Dubbing Engine (Native Android TextToSpeech + Web Speech API fallback)
// Features auto-ducking (lowers original video volume while AI speaks) and smart speed matching.

import { state, showToast } from "./state.js";

const TTS_LOCALE_MAP = {
  "Tiếng Việt": "vi-VN",
  English: "en-US",
  "日本語 (Japanese)": "ja-JP",
  "한국어 (Korean)": "ko-KR",
  "中文 (简体)": "zh-CN",
  "中文 (繁體)": "zh-TW",
  "Français": "fr-FR",
  Deutsch: "de-DE",
  "Español": "es-ES",
  "ภาษาไทย (Thai)": "th-TH",
};

let dubbingEnabled = false;
let lastSpokenId = null;
let isSpeaking = false;
let restoreTimer = null;
let activeVideoEl = null;
let savedUserVolume = 1.0;

export function isDubbingEnabled() {
  return dubbingEnabled;
}

export function setSavedUserVolume(vol) {
  savedUserVolume = Math.max(0, Math.min(1, Number(vol) || 0));
  if (!isSpeaking && activeVideoEl) {
    activeVideoEl.volume = savedUserVolume;
  }
}

function restoreVolume() {
  clearTimeout(restoreTimer);
  isSpeaking = false;
  if (activeVideoEl && !activeVideoEl.muted) {
    activeVideoEl.volume = savedUserVolume;
  }
}

function duckVolume(videoEl) {
  if (!videoEl) return;
  activeVideoEl = videoEl;
  isSpeaking = true;
  if (!videoEl.muted) {
    videoEl.volume = Math.min(savedUserVolume, 0.16);
  }
  clearTimeout(restoreTimer);
  // Safety timeout in case TTS callback doesn't fire
  restoreTimer = setTimeout(restoreVolume, 12000);
}

export function toggleDubbing(videoEl) {
  dubbingEnabled = !dubbingEnabled;
  lastSpokenId = null;
  if (!dubbingEnabled) {
    stopDubbing(videoEl);
    showToast("Đã tắt Thuyết minh AI.", "info", 1800);
  } else {
    if (videoEl) {
      savedUserVolume = videoEl.volume ?? 1;
      activeVideoEl = videoEl;
    }
    showToast("🎙️ Đã bật Thuyết minh AI (tự động đọc bản dịch & giảm tiếng gốc).", "success", 2500);
  }
  syncDubbingButtons();
  return dubbingEnabled;
}

export function syncDubbingButtons() {
  const btn = document.getElementById("btnToggleDubbing");
  const fsBtn = document.getElementById("fsBtnDubbing");
  if (btn) {
    btn.classList.toggle("active", dubbingEnabled);
    btn.textContent = dubbingEnabled ? "🎙️ Đang thuyết minh" : "🎙️ Thuyết minh";
  }
  if (fsBtn) {
    fsBtn.classList.toggle("active", dubbingEnabled);
  }
}

export function stopDubbing(videoEl) {
  if (videoEl) activeVideoEl = videoEl;
  if (window.AndroidNative?.stopTts) {
    try {
      window.AndroidNative.stopTts();
    } catch {}
  }
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  restoreVolume();
}

export function resetDubbingState() {
  lastSpokenId = null;
}

export function onSubtitleTick(activeSub, videoEl) {
  if (!dubbingEnabled || !videoEl || videoEl.paused) return;
  activeVideoEl = videoEl;

  if (!activeSub) {
    return;
  }
  if (activeSub.id === lastSpokenId) {
    return;
  }

  lastSpokenId = activeSub.id;
  const text = (activeSub.translatedText || activeSub.originalText || "").trim();
  if (!text) return;

  const langTag = TTS_LOCALE_MAP[state.targetLanguage] || "vi-VN";
  const cueDur = Math.max(0.8, (activeSub.end || 0) - (activeSub.start || 0));
  const wordCount = text.split(/\s+/).length;
  // Slightly speed up for dense lines so narration stays synced with video
  const estimatedRate = Math.min(1.45, Math.max(1.0, (wordCount / (cueDur * 3.1)) * (videoEl.playbackRate || 1)));

  duckVolume(videoEl);

  if (window.AndroidNative?.speakTts) {
    window.__onNativeTtsDone = () => {
      restoreVolume();
    };
    try {
      window.AndroidNative.speakTts(text, langTag, estimatedRate);
      return;
    } catch {}
  }

  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = langTag;
      utter.rate = estimatedRate;
      utter.onend = restoreVolume;
      utter.onerror = restoreVolume;
      window.speechSynthesis.speak(utter);
    } catch {
      restoreVolume();
    }
  } else {
    restoreVolume();
  }
}
