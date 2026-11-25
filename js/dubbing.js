// AI Voice-Over / Dubbing Engine (Native Android TextToSpeech + Web Speech API fallback)
// Smoothly ducks original video volume whenever AI Dubbing is active so narration is crystal clear.

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

const DUCK_SPEAKING_VOL = 0.05; // 5% linear (~25% perceived loudness) while AI speaks
const DUCK_IDLE_VOL = 0.14;     // 14% background level during pauses while dubbing is ON

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
  if (activeVideoEl && !activeVideoEl.muted) {
    if (dubbingEnabled) {
      activeVideoEl.volume = Math.min(savedUserVolume, isSpeaking ? DUCK_SPEAKING_VOL : DUCK_IDLE_VOL);
    } else {
      activeVideoEl.volume = savedUserVolume;
    }
  }
}

function restoreVolume() {
  clearTimeout(restoreTimer);
  isSpeaking = false;
  if (activeVideoEl && !activeVideoEl.muted) {
    activeVideoEl.volume = dubbingEnabled
      ? Math.min(savedUserVolume, DUCK_IDLE_VOL)
      : savedUserVolume;
  }
}

function duckVolume(videoEl) {
  if (!videoEl) return;
  activeVideoEl = videoEl;
  isSpeaking = true;
  if (!videoEl.muted) {
    videoEl.volume = Math.min(savedUserVolume, DUCK_SPEAKING_VOL);
  }
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(restoreVolume, 12000);
}

export function toggleDubbing(videoEl) {
  dubbingEnabled = !dubbingEnabled;
  lastSpokenId = null;
  if (videoEl) activeVideoEl = videoEl;

  if (!dubbingEnabled) {
    stopDubbing(videoEl);
    showToast("Đã tắt Thuyết minh AI (khôi phục âm thanh gốc).", "info", 1800);
  } else {
    if (videoEl) {
      if (!isSpeaking && videoEl.volume > DUCK_IDLE_VOL) {
        savedUserVolume = videoEl.volume ?? 1;
      }
      if (!videoEl.muted) {
        videoEl.volume = Math.min(savedUserVolume, DUCK_IDLE_VOL);
      }
    }
    showToast("🎙️ Đã bật Thuyết minh AI (âm thanh gốc đã tự động giảm nhỏ).", "success", 2500);
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

  // Keep original audio softly ducked whenever dubbing is active
  if (!videoEl.muted) {
    const targetMax = isSpeaking ? DUCK_SPEAKING_VOL : DUCK_IDLE_VOL;
    if (videoEl.volume > targetMax + 0.01) {
      videoEl.volume = Math.min(savedUserVolume, targetMax);
    }
  }

  if (!activeSub || activeSub.id === lastSpokenId) {
    return;
  }

  lastSpokenId = activeSub.id;
  const text = (activeSub.translatedText || activeSub.originalText || "").trim();
  if (!text) return;

  const langTag = TTS_LOCALE_MAP[state.targetLanguage] || "vi-VN";
  const cueDur = Math.max(0.8, (activeSub.end || 0) - (activeSub.start || 0));
  const wordCount = text.split(/\s+/).length;
  const estimatedRate = Math.min(
    1.45,
    Math.max(1.0, (wordCount / (cueDur * 3.1)) * (videoEl.playbackRate || 1))
  );

  duckVolume(videoEl);

  const gender = state.dubVoiceGender || "female";
  const emotion = state.dubEmotion || "natural";

  if (window.AndroidNative?.speakTtsEx) {
    window.__onNativeTtsDone = () => {
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(restoreVolume, 600);
    };
    try {
      window.AndroidNative.speakTtsEx(text, langTag, estimatedRate, gender, emotion);
      return;
    } catch {}
  } else if (window.AndroidNative?.speakTts) {
    window.__onNativeTtsDone = () => {
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(restoreVolume, 600);
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

      // Pick matching gender voice if browser exposes multiple voices
      const voices = window.speechSynthesis.getVoices() || [];
      const langPrefix = langTag.split("-")[0].toLowerCase();
      const matching = voices.filter((v) => (v.lang || "").toLowerCase().startsWith(langPrefix));
      if (matching.length > 0) {
        const maleRx = /nam|male|man|guy|daniel|ryan|minh/i;
        const femaleRx = /nu|nữ|female|woman|hoaimy|linh|jenny|aria|nanami/i;
        const picked = matching.find((v) =>
          gender === "male" ? maleRx.test(v.name) : femaleRx.test(v.name)
        );
        utter.voice = picked || matching[0];
      }

      let pitch = gender === "male" ? 0.85 : 1.02;
      let rate = estimatedRate;
      if (emotion === "cheerful") {
        pitch *= 1.1;
        rate *= 1.07;
      } else if (emotion === "dramatic") {
        pitch *= 0.92;
        rate *= 1.04;
      } else if (emotion === "sad") {
        pitch *= 0.86;
        rate *= 0.9;
      }
      utter.pitch = Math.max(0.5, Math.min(1.8, pitch));
      utter.rate = Math.max(0.6, Math.min(2.0, rate));
      utter.onend = () => {
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(restoreVolume, 600);
      };
      utter.onerror = restoreVolume;
      window.speechSynthesis.speak(utter);
    } catch {
      restoreVolume();
    }
  } else {
    restoreVolume();
  }
}
