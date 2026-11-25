// Video player controls & accurate real-time bilingual subtitle overlay

import { state, on, emit, formatTimeShort, updateStyle } from "./state.js";
import {
  toggleDubbing,
  stopDubbing,
  resetDubbingState,
  onSubtitleTick,
  setSavedUserVolume,
  syncDubbingButtons,
} from "./dubbing.js";

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
  const btnToggleDubbing = document.getElementById("btnToggleDubbing");
  const btnSkipBack = document.getElementById("btnSkipBack");
  const btnSkipFwd = document.getElementById("btnSkipFwd");
  const playbackRateSelect = document.getElementById("playbackRateSelect");
  const volumeSlider = document.getElementById("volumeSlider");
  const btnMute = document.getElementById("btnMute");
  const quickDisplayMode = document.getElementById("quickDisplayMode");
  const btnRotateScreen = document.getElementById("btnRotateScreen");
  const btnFullscreen = document.getElementById("btnFullscreen");

  btnPlayPause.addEventListener("click", togglePlay);
  initFullscreenGestures();

  if (btnToggleDubbing) {
    btnToggleDubbing.addEventListener("click", () => toggleDubbing(videoEl));
  }
  syncDubbingButtons();

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
    const v = parseFloat(volumeSlider.value);
    videoEl.volume = v;
    videoEl.muted = v === 0;
    setSavedUserVolume(v);
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
    stopDubbing(videoEl);
    syncTimeUI();
  });

  videoEl.addEventListener("loadedmetadata", () => {
    const dur = videoEl.duration || state.video?.duration || 0;
    if (state.video && (!state.video.duration || state.video.duration <= 0)) {
      state.video.duration = dur;
    }
    durationLabel.textContent = formatTimeShort(dur);
    renderOverlay();
  });

  videoEl.addEventListener("error", (e) => {
    console.error("Video error event:", videoEl.error);
    const code = videoEl.error ? videoEl.error.code : 0;
    console.warn(`Video playback code: ${code}, src: ${videoEl.src}`);
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
    stopDubbing(videoEl);
    resetDubbingState();
    const src = video.videoUrl || video.mediaUrl || "";
    if (src) {
      videoEl.src = src;
      videoEl.load();
    }
    state.currentTime = 0;
    currentTimeLabel.textContent = formatTimeShort(0);
    durationLabel.textContent = formatTimeShort(video.duration || 0);
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
  stopDubbing(videoEl);
  resetDubbingState();
  emit("time:tick", clamped);
  renderOverlay();
}

export function renderOverlay() {
  if (!subtitleOverlay || !subtitleCue || !videoEl) return;
  const t = state.currentTime;
  const active = state.subtitles.find((s) => t >= s.start && t <= s.end);
  onSubtitleTick(active, videoEl);

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
  const floatingBar = document.getElementById("fsFloatingBar");
  const dimOverlay = document.getElementById("fsDimOverlay");

  if (enterIcon) enterIcon.hidden = isFs;
  if (exitIcon) exitIcon.hidden = !isFs;
  if (box) box.classList.toggle("is-fullscreen", isFs);
  if (floatingBar) floatingBar.hidden = !isFs;

  if (!isFs) {
    if (dimOverlay) dimOverlay.style.opacity = "0";
    if (window.AndroidNative?.setScreenBrightness) {
      try {
        window.AndroidNative.setScreenBrightness(-1);
      } catch {}
    }
  }
  renderOverlay();
}

function initFullscreenGestures() {
  const box = document.getElementById("videoBox");
  const hud = document.getElementById("fsGestureHud");
  const hudIcon = document.getElementById("fsHudIcon");
  const hudText = document.getElementById("fsHudText");
  const hudSub = document.getElementById("fsHudSub");
  const hudBarWrap = document.getElementById("fsHudBarWrap");
  const hudBarFill = document.getElementById("fsHudBarFill");
  const dimOverlay = document.getElementById("fsDimOverlay");

  const floatingBar = document.getElementById("fsFloatingBar");
  const fsBtnPlayPause = document.getElementById("fsBtnPlayPause");
  const fsBtnDubbing = document.getElementById("fsBtnDubbing");
  const fsSeekSlider = document.getElementById("fsSeekSlider");
  const fsTimeCurrent = document.getElementById("fsTimeCurrent");
  const fsTimeDuration = document.getElementById("fsTimeDuration");
  const fsBtnExit = document.getElementById("fsBtnExit");

  if (!box || !videoEl) return;

  let brightness = 1.0; // 0.1 to 1.0
  let hudTimer = null;
  let barHideTimer = null;

  function showHud(icon, text, sub, pct) {
    if (!hud) return;
    hud.hidden = false;
    if (hudIcon) hudIcon.textContent = icon;
    if (hudText) hudText.textContent = text;
    if (hudSub) {
      if (sub) {
        hudSub.textContent = sub;
        hudSub.hidden = false;
      } else {
        hudSub.hidden = true;
      }
    }
    if (hudBarWrap && hudBarFill) {
      if (typeof pct === "number") {
        hudBarWrap.hidden = false;
        hudBarFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      } else {
        hudBarWrap.hidden = true;
      }
    }
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (hud) hud.hidden = true;
    }, 900);
  }

  function showFloatingBarTemporarily() {
    if (!floatingBar) return;
    const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFs) {
      floatingBar.hidden = true;
      return;
    }
    floatingBar.hidden = false;
    clearTimeout(barHideTimer);
    barHideTimer = setTimeout(() => {
      if (floatingBar && !videoEl.paused) {
        floatingBar.hidden = true;
      }
    }, 3500);
  }

  // Sync floating bar with video playback
  videoEl.addEventListener("timeupdate", () => {
    const dur = videoEl.duration || state.video?.duration || 0;
    const cur = videoEl.currentTime || 0;
    if (fsTimeCurrent) fsTimeCurrent.textContent = formatTimeShort(cur).split(".")[0];
    if (fsTimeDuration) fsTimeDuration.textContent = formatTimeShort(dur).split(".")[0];
    if (fsSeekSlider && dur > 0 && !fsSeekSlider.dataset.dragging) {
      fsSeekSlider.max = String(dur);
      fsSeekSlider.value = String(cur);
    }
  });

  videoEl.addEventListener("play", () => {
    if (fsBtnPlayPause) fsBtnPlayPause.textContent = "⏸";
  });
  videoEl.addEventListener("pause", () => {
    if (fsBtnPlayPause) fsBtnPlayPause.textContent = "⏯";
  });

  if (fsBtnPlayPause) {
    fsBtnPlayPause.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlay();
      showFloatingBarTemporarily();
    });
  }
  if (fsBtnDubbing) {
    fsBtnDubbing.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDubbing(videoEl);
      showFloatingBarTemporarily();
    });
  }
  if (fsBtnExit) {
    fsBtnExit.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
  }
  if (fsSeekSlider) {
    fsSeekSlider.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      fsSeekSlider.dataset.dragging = "1";
    }, { passive: true });
    fsSeekSlider.addEventListener("input", (e) => {
      e.stopPropagation();
      const val = parseFloat(fsSeekSlider.value) || 0;
      seekTo(val);
      showFloatingBarTemporarily();
    });
    fsSeekSlider.addEventListener("touchend", () => {
      delete fsSeekSlider.dataset.dragging;
    });
    fsSeekSlider.addEventListener("change", () => {
      delete fsSeekSlider.dataset.dragging;
    });
  }

  // Touch gesture state (Swipe Left/Right = Seek, Left Vertical = Brightness, Right Vertical = Volume)
  let touchStartX = 0;
  let touchStartY = 0;
  let gestureMode = null; // null | "seek" | "brightness" | "volume"
  let startTime = 0;
  let pendingSeekTime = 0;
  let startBrightness = 1.0;
  let startVolume = 1.0;
  let lastTapTime = 0;
  let lastTapX = 0;
  let singleTapTimer = null;

  box.addEventListener(
    "touchstart",
    (e) => {
      if (e.target.closest("#fsFloatingBar")) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      gestureMode = null;
      startTime = videoEl.currentTime || 0;
      pendingSeekTime = startTime;
      startBrightness = brightness;
      startVolume =
        typeof window.AndroidNative?.getMediaVolume === "function"
          ? window.AndroidNative.getMediaVolume()
          : videoEl.volume ?? 1;
    },
    { passive: true }
  );

  box.addEventListener(
    "touchmove",
    (e) => {
      if (e.target.closest("#fsFloatingBar")) return;
      if (e.touches.length !== 1) return;

      const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      // Enable swipe gestures in Fullscreen mode (or horizontally anywhere when video is loaded)
      const t = e.touches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;

      if (!gestureMode) {
        if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
        const rect = box.getBoundingClientRect();
        const relX = (touchStartX - rect.left) / Math.max(1, rect.width);

        if (Math.abs(dx) > Math.abs(dy)) {
          gestureMode = "seek";
        } else if (isFs) {
          gestureMode = relX < 0.5 ? "brightness" : "volume";
        } else {
          return; // Allow normal page scroll outside fullscreen for vertical swipes
        }
      }

      if (e.cancelable) e.preventDefault();

      const rect = box.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);

      if (gestureMode === "seek") {
        const dur = videoEl.duration || state.video?.duration || 0;
        if (dur <= 0) return;
        const maxSpan = Math.min(180, Math.max(45, dur * 0.45));
        const deltaSec = (dx / w) * maxSpan;
        pendingSeekTime = Math.max(0, Math.min(dur, startTime + deltaSec));
        const sign = deltaSec >= 0 ? "+" : "";
        const icon = deltaSec >= 0 ? "⏩" : "⏪";
        const pct = (pendingSeekTime / dur) * 100;
        showHud(
          icon,
          `${sign}${Math.round(deltaSec)} giây`,
          `${formatTimeShort(pendingSeekTime).split(".")[0]} / ${formatTimeShort(dur).split(".")[0]}`,
          pct
        );
      } else if (gestureMode === "brightness") {
        const delta = -dy / (h * 0.65);
        brightness = Math.max(0.1, Math.min(1.0, startBrightness + delta));
        if (window.AndroidNative?.setScreenBrightness) {
          try {
            window.AndroidNative.setScreenBrightness(brightness);
          } catch {}
        }
        if (dimOverlay) {
          dimOverlay.style.opacity = String(Math.max(0, 1 - brightness) * 0.85);
        }
        const pct = Math.round(brightness * 100);
        showHud("☀️", `Độ sáng: ${pct}%`, null, pct);
      } else if (gestureMode === "volume") {
        const delta = -dy / (h * 0.65);
        const newVol = Math.max(0, Math.min(1, startVolume + delta));
        videoEl.volume = newVol;
        videoEl.muted = newVol === 0;
        const volSlider = document.getElementById("volumeSlider");
        if (volSlider) volSlider.value = String(newVol);
        if (window.AndroidNative?.setMediaVolume) {
          try {
            window.AndroidNative.setMediaVolume(newVol);
          } catch {}
        }
        const pct = Math.round(newVol * 100);
        showHud(pct === 0 ? "🔇" : pct < 40 ? "🔉" : "🔊", `Âm lượng: ${pct}%`, null, pct);
      }
    },
    { passive: false }
  );

  box.addEventListener("touchend", (e) => {
    if (e.target.closest("#fsFloatingBar")) return;

    if (gestureMode === "seek") {
      seekTo(pendingSeekTime);
      gestureMode = null;
      return;
    }
    if (gestureMode) {
      gestureMode = null;
      return;
    }

    // Handle single tap vs double tap
    const now = Date.now();
    const rect = box.getBoundingClientRect();
    const tapX = (e.changedTouches?.[0]?.clientX ?? touchStartX) - rect.left;
    const relX = tapX / Math.max(1, rect.width);

    if (now - lastTapTime < 280 && Math.abs(tapX - lastTapX) < 80) {
      clearTimeout(singleTapTimer);
      lastTapTime = 0;
      // Double tap left = -10s, right = +10s
      if (relX < 0.42) {
        seekTo((videoEl.currentTime || 0) - 10);
        showHud("⏪", "Lùi 10 giây", formatTimeShort(videoEl.currentTime || 0).split(".")[0]);
      } else if (relX > 0.58) {
        seekTo((videoEl.currentTime || 0) + 10);
        showHud("⏩", "Tiến 10 giây", formatTimeShort(videoEl.currentTime || 0).split(".")[0]);
      } else {
        togglePlay();
      }
    } else {
      lastTapTime = now;
      lastTapX = tapX;
      const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      singleTapTimer = setTimeout(() => {
        if (isFs) {
          if (floatingBar && floatingBar.hidden) {
            showFloatingBarTemporarily();
          } else if (floatingBar) {
            floatingBar.hidden = true;
          }
        } else {
          togglePlay();
        }
      }, 260);
    }
  });

  // Desktop mouse click support (only when not triggered by touch)
  let lastTouchEnd = 0;
  box.addEventListener("touchend", () => {
    lastTouchEnd = Date.now();
  }, { passive: true });
  videoEl.addEventListener("click", () => {
    if (Date.now() - lastTouchEnd < 400) return;
    togglePlay();
  });
}
