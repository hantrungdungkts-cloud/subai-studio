// Interactive Waveform + Subtitle Timeline with drag-move, edge-resize, scrub, and zoom

import { state, on, emit, pushHistory, updateSubtitle, undo, redo } from "./state.js";

let scrollEl;
let wrapEl;
let rulerEl;
let waveformCanvas;
let trackEl;
let playheadEl;
let zoomSlider;

let dragState = null;

export function initTimeline() {
  scrollEl = document.getElementById("timelineScroll");
  wrapEl = document.getElementById("timelineCanvasWrap");
  rulerEl = document.getElementById("timelineRuler");
  waveformCanvas = document.getElementById("waveformCanvas");
  trackEl = document.getElementById("subtitleTrack");
  playheadEl = document.getElementById("timelinePlayhead");
  zoomSlider = document.getElementById("timelineZoom");

  const btnZoomIn = document.getElementById("btnZoomIn");
  const btnZoomOut = document.getElementById("btnZoomOut");
  const btnZoomFit = document.getElementById("btnZoomFit");
  const btnUndo = document.getElementById("btnUndo");
  const btnRedo = document.getElementById("btnRedo");

  btnUndo.addEventListener("click", undo);
  btnRedo.addEventListener("click", redo);

  window.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    }
  });

  zoomSlider.addEventListener("input", () => {
    state.pxPerSec = Number(zoomSlider.value);
    renderTimeline();
  });

  btnZoomIn.addEventListener("click", () => {
    state.pxPerSec = Math.min(220, state.pxPerSec + 20);
    zoomSlider.value = state.pxPerSec;
    renderTimeline();
  });

  btnZoomOut.addEventListener("click", () => {
    state.pxPerSec = Math.max(25, state.pxPerSec - 20);
    zoomSlider.value = state.pxPerSec;
    renderTimeline();
  });

  btnZoomFit.addEventListener("click", () => {
    if (!state.video?.duration) return;
    const avail = Math.max(400, scrollEl.clientWidth - 24);
    state.pxPerSec = Math.max(25, Math.min(220, Math.floor(avail / state.video.duration)));
    zoomSlider.value = state.pxPerSec;
    renderTimeline();
  });

  // Scrubbing on ruler or waveform
  const startScrub = (e) => {
    if (!state.video) return;
    const seekFromClientX = (clientX) => {
      const rect = wrapEl.getBoundingClientRect();
      const x = Math.max(0, clientX - rect.left);
      emit("player:seek", { time: x / state.pxPerSec, autoPlay: false });
    };
    seekFromClientX(e.clientX);
    const onMove = (ev) => seekFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  rulerEl.addEventListener("mousedown", startScrub);
  waveformCanvas.addEventListener("mousedown", startScrub);

  // Global mouse handlers for block drag & resize
  window.addEventListener("mousemove", handleBlockDragMove);
  window.addEventListener("mouseup", handleBlockDragEnd);

  on("video:loaded", () => {
    // Fit nicely initially for short/medium clips
    if (state.video?.duration) {
      const avail = Math.max(600, scrollEl.clientWidth - 24);
      state.pxPerSec = Math.max(30, Math.min(140, Math.round(avail / Math.min(state.video.duration, 45))));
      zoomSlider.value = state.pxPerSec;
    }
    renderTimeline();
  });

  on("subtitles:change", () => renderBlocks());
  on("selection:change", () => updateSelectedBlockHighlight());
  on("time:tick", (t) => updatePlayhead(t));
  on("history:change", () => {
    btnUndo.disabled = state.history.length === 0;
    btnRedo.disabled = state.future.length === 0;
  });

  window.addEventListener("resize", () => renderTimeline());
  renderTimeline();
}

function getTimelineWidth() {
  const duration = state.video?.duration || 30;
  const minW = scrollEl ? scrollEl.clientWidth : 800;
  return Math.max(minW, Math.ceil((duration + 2) * state.pxPerSec));
}

export function renderTimeline() {
  if (!wrapEl) return;
  const width = getTimelineWidth();
  wrapEl.style.width = `${width}px`;

  renderRuler(width);
  renderWaveform(width);
  renderBlocks();
  updatePlayhead(state.currentTime);
}

function renderRuler(width) {
  rulerEl.innerHTML = "";
  const duration = Math.max(state.video?.duration || 30, width / state.pxPerSec);
  let step = 1;
  if (state.pxPerSec < 35) step = 5;
  else if (state.pxPerSec < 65) step = 2;

  const frag = document.createDocumentFragment();
  for (let s = 0; s <= duration; s += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${s * state.pxPerSec}px`;
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    tick.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    frag.appendChild(tick);
  }
  rulerEl.appendChild(frag);
}

function renderWaveform(width) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const h = 54;
  // Cap backing canvas width to stay safely under browser 32,767px canvas limit for 1h+ videos
  const maxCanvasCssW = 12000;
  const drawW = Math.min(width, maxCanvasCssW);
  waveformCanvas.width = Math.max(1, Math.floor(drawW * dpr));
  waveformCanvas.height = Math.floor(h * dpr);
  waveformCanvas.style.width = `${width}px`;
  waveformCanvas.style.height = `${h}px`;

  const ctx = waveformCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, drawW, h);

  const peaks = state.video?.waveform;
  const duration = state.video?.duration || 0;
  if (!peaks || !peaks.length || !duration) {
    // Subtle center baseline
    ctx.strokeStyle = "#1e293b";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(drawW, h / 2);
    ctx.stroke();
    return;
  }

  const audioRatio = Math.min(1, (duration * state.pxPerSec) / Math.max(1, width));
  const audioDrawW = drawW * audioRatio;
  const barStep = audioDrawW / peaks.length;
  const barW = Math.max(1.5, barStep * 0.68);
  const mid = h / 2;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(6, 182, 212, 0.72)");
  grad.addColorStop(0.5, "rgba(99, 102, 241, 0.85)");
  grad.addColorStop(1, "rgba(6, 182, 212, 0.72)");
  ctx.fillStyle = grad;

  for (let i = 0; i < peaks.length; i++) {
    const amp = Math.max(0.06, peaks[i]);
    const barH = amp * (h - 10);
    const x = i * barStep;
    ctx.fillRect(x, mid - barH / 2, barW, barH);
  }
}

function renderBlocks() {
  if (!trackEl) return;
  trackEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const sub of state.subtitles) {
    const left = sub.start * state.pxPerSec;
    const width = Math.max(16, (sub.end - sub.start) * state.pxPerSec);

    const el = document.createElement("div");
    el.className = `tl-block${sub.id === state.selectedId ? " selected" : ""}`;
    el.dataset.id = sub.id;
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;

    const leftHandle = document.createElement("div");
    leftHandle.className = "tl-handle left";
    leftHandle.dataset.handle = "left";

    const rightHandle = document.createElement("div");
    rightHandle.className = "tl-handle right";
    rightHandle.dataset.handle = "right";

    const text = document.createElement("div");
    text.className = "tl-block-text";
    text.textContent = sub.translatedText || sub.originalText || "(Trống)";

    const orig = document.createElement("div");
    orig.className = "tl-block-orig";
    orig.textContent = sub.originalText !== sub.translatedText ? sub.originalText : "";

    el.append(leftHandle, text, orig, rightHandle);

    el.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const handle = e.target.dataset.handle || "move";
      state.selectedId = sub.id;
      emit("selection:change", sub.id);

      pushHistory();
      dragState = {
        id: sub.id,
        mode: handle,
        startX: e.clientX,
        origStart: sub.start,
        origEnd: sub.end,
        moved: false,
      };
    });

    frag.appendChild(el);
  }

  trackEl.appendChild(frag);
}

function handleBlockDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  if (Math.abs(dx) > 2) dragState.moved = true;
  const dt = dx / state.pxPerSec;
  const maxDur = state.video?.duration || 3600;
  const minLen = 0.25;

  let newStart = dragState.origStart;
  let newEnd = dragState.origEnd;

  if (dragState.mode === "move") {
    const len = dragState.origEnd - dragState.origStart;
    newStart = Math.max(0, Math.min(maxDur - len, dragState.origStart + dt));
    newEnd = newStart + len;
  } else if (dragState.mode === "left") {
    newStart = Math.max(0, Math.min(dragState.origEnd - minLen, dragState.origStart + dt));
  } else if (dragState.mode === "right") {
    newEnd = Math.min(maxDur, Math.max(dragState.origStart + minLen, dragState.origEnd + dt));
  }

  updateSubtitle(dragState.id, {
    start: Number(newStart.toFixed(3)),
    end: Number(newEnd.toFixed(3)),
  });
}

function handleBlockDragEnd() {
  if (!dragState) return;
  const ended = dragState;
  dragState = null;

  if (!ended.moved) {
    // Clicked without dragging: pop redundant history snapshot and jump playhead
    state.history.pop();
    emit("history:change");
    emit("player:seek", { time: ended.origStart + 0.02, autoPlay: false });
  } else {
    // Re-sort subtitles by start time after drag finishes
    state.subtitles.sort((a, b) => a.start - b.start);
    emit("subtitles:change");
  }
}

function updateSelectedBlockHighlight() {
  if (!trackEl) return;
  trackEl.querySelectorAll(".tl-block").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === state.selectedId);
  });
}

function updatePlayhead(time) {
  if (!playheadEl) return;
  const x = (time || 0) * state.pxPerSec;
  playheadEl.style.transform = `translateX(${x}px)`;

  // Auto-scroll timeline gently during playback
  if (state.isPlaying && scrollEl) {
    const viewLeft = scrollEl.scrollLeft;
    const viewRight = viewLeft + scrollEl.clientWidth;
    if (x > viewRight - 80 || x < viewLeft) {
      scrollEl.scrollLeft = Math.max(0, x - 120);
    }
  }
}
