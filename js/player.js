// Video player controls & accurate real-time bilingual subtitle overlay

import { state, on, emit, formatTimeShort, updateStyle } from "./state.js";

let videoEl;
let subtitleOverlay;
let subtitleCue;
let currentTimeLabel;
let durationLabel;
let iconPlay;
let iconPause;
let rafId = null;

function hexToRgba(hex, alpha) {
  const clean = (hex || "#000000").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function initPlayer() {
  videoEl = document.getElementById("videoEl");
  subtitleOverlay = document.getElementById("subtitleOverlay");
  subtitleCue = document.getElementById("subtitleCue");
  currentTimeLabel = document.getElementById("currentTimeLabel");
  durationLabel = document.getElementById("durationLabel");
  iconPlay = document.getElementById("iconPlay");
  iconPause = document.getElementById("iconPause");

  const btnPlayPause = document.getElementById("btnPlayPause");
  const btnSkipBack = document.getElementById("btnSkipBack");
  const btnSkipFwd = document.getElementById("btnSkipFwd");
  const playbackRateSelect = document.getElementById("playbackRateSelect");
  const volumeSlider = document.getElementById("volumeSlider");
  const btnMute = document.getElementById("btnMute");
  const quickDisplayMode = document.getElementById("quickDisplayMode");
  const btnRotateScreen = document.getElementById("btnRotateScreen");
  const btnFullscreen = document.getElementById("btnFullscreen");

  btnPlayPause.addEventListener("click", togglePlay);
  videoEl.addEventListener("click", togglePlay);

  if (btnRotateScreen) {
    btnRotateScreen.addEventListener("click", rotateScreen);
  }
  if (btnFullscreen) {
    btnFullscreen.addEventListener("click", toggleFullscreen);
  }

  document.addEventListener("fullscreenchange", updateFullscreenUI);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUI);

  btnSkipBack.addEventListener("click", () => seekTo(videoEl.currentTime - 5));
  btnSkipFwd.addEventListener("click", () => seekTo(videoEl.currentTime + 5));

  playbackRateSelect.addEventListener("change", () => {
    videoEl.playbackRate = parseFloat(playbackRateSelect.value) || 1;
  });

  volumeSlider.addEventListener("input", () => {
    videoEl.volume = parseFloat(volumeSlider.value);
    videoEl.muted = videoEl.volume === 0;
  });

  btnMute.addEventListener("click", () => {
    videoEl.muted = !videoEl.muted;
    volumeSlider.value = videoEl.muted ? 0 : videoEl.volume || 1;
  });

  quickDisplayMode.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    updateStyle({ displayMode: btn.dataset.mode });
  });

  videoEl.addEventListener("play", () => {
    state.isPlaying = true;
    iconPlay.hidden = true;
    iconPause.hidden = false;
    startTick();
  });

  videoEl.addEventListener("pause", () => {
    state.isPlaying = false;
    iconPlay.hidden = false;
    iconPause.hidden = true;
    stopTick();
    syncTimeUI();
  });

  videoEl.addEventListener("loadedmetadata", () => {
    durationLabel.textContent = formatTimeShort(videoEl.duration || state.video?.duration || 0);
    renderOverlay();
  });

  videoEl.addEventListener("timeupdate", () => {
    if (!state.isPlaying) syncTimeUI();
  });

  // Keep overlay proportions accurate on window resize
  const ro = new ResizeObserver(() => renderOverlay());
  ro.observe(videoEl);

  // Keyboard shortcuts (ignore when typing in inputs/textareas)
  window.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!state.video) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      seekTo(videoEl.currentTime - (e.shiftKey ? 1 : 5));
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      seekTo(videoEl.currentTime + (e.shiftKey ? 1 : 5));
    } else if (e.code === "KeyF") {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      rotateScreen();
    }
  });

  on("video:loaded", (video) => {
    videoEl.src = video.videoUrl;
    videoEl.load();
    state.currentTime = 0;
    currentTimeLabel.textContent = formatTimeShort(0);
    durationLabel.textContent = formatTimeShort(video.duration);
    renderOverlay();
  });

  on("player:seek", ({ time, autoPlay }) => {
    seekTo(time);
    if (autoPlay && videoEl.paused) {
      videoEl.play().catch(() => {});
    }
  });

  on("subtitles:change", () => renderOverlay());
  on("style:change", () => {
    syncQuickDisplayButtons();
    renderOverlay();
  });

  syncQuickDisplayButtons();
}

function syncQuickDisplayButtons() {
  const mode = state.style.displayMode;
  const normalized = mode.startsWith("bilingual") ? "bilingual" : mode;
  document.querySelectorAll("#quickDisplayMode button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === normalized);
  });
}

function startTick() {
  stopTick();
  const loop = () => {
    syncTimeUI();
    if (state.isPlaying) {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

function stopTick() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function syncTimeUI() {
  if (!videoEl) return;
  state.currentTime = videoEl.currentTime || 0;
  currentTimeLabel.textContent = formatTimeShort(state.currentTime);
  emit("time:tick", state.currentTime);
  renderOverlay();
}

export function togglePlay() {
  if (!videoEl || !state.video) return;
  if (videoEl.paused) {
    videoEl.play().catch(() => {});
  } else {
    videoEl.pause();
  }
}

export function seekTo(seconds) {
  if (!videoEl || !state.video) return;
  const max = videoEl.duration || state.video.duration || 0;
  const clamped = Math.max(0, Math.min(max, Number(seconds) || 0));
  videoEl.currentTime = clamped;
  state.currentTime = clamped;
  currentTimeLabel.textContent = formatTimeShort(clamped);
  emit("time:tick", clamped);
  renderOverlay();
}

export function renderOverlay() {
  if (!subtitleOverlay || !subtitleCue || !videoEl) return;
  const t = state.currentTime;
  const active = state.subtitles.find((s) => t >= s.start && t <= s.end);

  if (!active) {
    subtitleCue.hidden = true;
    return;
  }

  const st = state.style;
  const displayH = videoEl.clientHeight || 540;
  const scale = displayH / 1080;

  const fontSizePx = Math.max(12, Math.round(st.fontSize * scale));
  const origSizePx = Math.max(10, Math.round(fontSizePx * st.originalScale));
  const marginVPx = Math.round(st.marginV * scale);
  const outlinePx = Math.max(0, st.outlineWidth * scale);

  subtitleOverlay.className = `subtitle-overlay pos-${st.position}`;
  subtitleOverlay.style.paddingBottom = st.position === "bottom" ? `${marginVPx}px` : "0";
  subtitleOverlay.style.paddingTop = st.position === "top" ? `${marginVPx}px` : "0";

  subtitleCue.style.fontFamily = `"${st.fontFamily}", "Be Vietnam Pro", sans-serif`;
  subtitleCue.style.fontWeight = st.bold ? "700" : "400";
  subtitleCue.style.fontStyle = st.italic ? "italic" : "normal";
  subtitleCue.style.backgroundColor =
    st.bgOpacity > 0.02 ? hexToRgba(st.bgColor, st.bgOpacity) : "transparent";

  // Crisp text outline + subtle drop shadow matching libass look
  const shadows = [];
  if (outlinePx > 0.1) {
    const o = outlinePx.toFixed(1);
    const oc = st.outlineColor;
    shadows.push(
      `-${o}px -${o}px 0 ${oc}`,
      `${o}px -${o}px 0 ${oc}`,
      `-${o}px ${o}px 0 ${oc}`,
      `${o}px ${o}px 0 ${oc}`,
      `0 ${o}px 0 ${oc}`,
      `0 -${o}px 0 ${oc}`,
      `${o}px 0 0 ${oc}`,
      `-${o}px 0 0 ${oc}`
    );
  }
  if (st.bgOpacity <= 0.05) {
    shadows.push(`0 ${Math.max(1, 2 * scale).toFixed(1)}px ${Math.max(2, 4 * scale).toFixed(1)}px rgba(0,0,0,0.8)`);
  }
  subtitleCue.style.textShadow = shadows.join(", ");

  subtitleCue.innerHTML = "";
  const trans = (active.translatedText || "").trim();
  const orig = (active.originalText || "").trim();

  const appendLine = (text, cls, color, sizePx, weight) => {
    if (!text) return;
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    span.style.color = color;
    span.style.fontSize = `${sizePx}px`;
    if (weight) span.style.fontWeight = weight;
    subtitleCue.appendChild(span);
  };

  if (st.displayMode === "translated") {
    appendLine(trans || orig, "line-translated", st.textColor, fontSizePx);
  } else if (st.displayMode === "original") {
    appendLine(orig || trans, "line-original", st.originalColor, fontSizePx);
  } else if (st.displayMode === "bilingual_orig_top") {
    if (orig && orig !== trans) {
      appendLine(orig, "line-original", st.originalColor, origSizePx, "500");
    }
    appendLine(trans || orig, "line-translated", st.textColor, fontSizePx);
  } else {
    appendLine(trans || orig, "line-translated", st.textColor, fontSizePx);
    if (orig && orig !== trans) {
      appendLine(orig, "line-original", st.originalColor, origSizePx, "500");
    }
  }

  subtitleCue.hidden = subtitleCue.childNodes.length === 0;
}

let currentRotation = 0;

export function rotateScreen() {
  currentRotation = (currentRotation + 90) % 360;
  const box = document.getElementById("videoBox");
  const badge = document.getElementById("rotateBadge");

  if (box) {
    box.classList.remove("rot-90", "rot-180", "rot-270");
    if (currentRotation > 0) {
      box.classList.add(`rot-${currentRotation}`);
    }
  }

  if (badge) {
    if (currentRotation > 0) {
      badge.textContent = `${currentRotation}°`;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Try device orientation lock on supported mobile browsers
  if (window.screen?.orientation?.lock) {
    const isLandscape = currentRotation === 90 || currentRotation === 270;
    window.screen.orientation.lock(isLandscape ? "landscape" : "portrait").catch(() => {});
  }

  renderOverlay();
}

export function toggleFullscreen() {
  const box = document.getElementById("videoBox");
  if (!box) return;

  const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFs) {
    if (box.requestFullscreen) {
      box.requestFullscreen().catch(() => {});
    } else if (box.webkitRequestFullscreen) {
      box.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenUI() {
  const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const enterIcon = document.getElementById("iconEnterFullscreen");
  const exitIcon = document.getElementById("iconExitFullscreen");
  const box = document.getElementById("videoBox");
  if (enterIcon) enterIcon.hidden = isFs;
  if (exitIcon) exitIcon.hidden = !isFs;
  if (box) box.classList.toggle("is-fullscreen", isFs);
  renderOverlay();
}
