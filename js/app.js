// 100% Client-Side SubAI Studio orchestrator (GitHub Pages / Static Hosting Ready)
// Runs Whisper AI inside a Web Worker + Free Translation + IndexedDB persistence + SRT/VTT/ASS Export

import { state, on, emit, persistSettings, setSubtitles, showToast } from "./state.js";
import { initPlayer } from "./player.js";
import { initTimeline } from "./timeline.js";
import { initSubtitleEditor } from "./editor.js";
import { initStylePanel } from "./styles.js";
import { extractAudioAndPeaks } from "./audio-utils.js";
import { translateBatch } from "./translator.js";
import { transcribeWithGroqCloud, transcribeFileDirectlyWithGroq } from "./groq-ai.js";
import { transcribeWithGeminiCloud } from "./gemini-ai.js";
import {
  saveProjectLocal,
  listProjectsLocal,
  getProjectLocal,
  deleteProjectLocal,
} from "./storage.js";
import { triggerDownloadSubtitle, parseSrtOrVtt } from "./exporter.js";

let currentPcm16k = null;
let pendingAudioPromise = null;
let currentVideoFile = null;
let currentVideoObjectUrl = null;
let whisperWorker = null;
let isGenerating = false;
let autoSaveTimer = null;

const BROWSER_MODELS = [
  { id: "whisper-tiny", name: "⚡ Whisper Tiny (Siêu nhẹ ~40MB — Điện thoại)" },
  { id: "whisper-base", name: "🎯 Whisper Base (Cân bằng ~75MB — Khuyên dùng)" },
  { id: "whisper-small", name: "💎 Whisper Small (Chính xác ~240MB — PC)" },
];

async function bootstrap() {
  initMobileMode();
  initPlayer();
  initTimeline();
  initSubtitleEditor();
  initStylePanel();
  initTabs();
  initUpload();
  initTopbarActions();
  initSettingsModal();
  initExportModal();
  initProjectSystem();

  populateModelSelect();
  renderProjectsList();
}

function populateModelSelect() {
  const sel = document.getElementById("selectModel");
  const engineSel = document.getElementById("engineSelect");
  if (sel) sel.innerHTML = "";
  if (engineSel) engineSel.innerHTML = "";

  for (const m of BROWSER_MODELS) {
    if (sel) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
    if (engineSel) {
      const eOpt = document.createElement("option");
      eOpt.value = m.id;
      eOpt.textContent = m.name;
      engineSel.appendChild(eOpt);
    }
  }

  const valid = BROWSER_MODELS.some((m) => m.id === state.model) ? state.model : "whisper-tiny";
  state.model = valid;
  if (sel) sel.value = valid;
  if (engineSel) {
    engineSel.value = valid;
    engineSel.addEventListener("change", () => {
      state.model = engineSel.value;
      if (sel) sel.value = engineSel.value;
      persistSettings();
    });
  }
}

function initTabs() {
  const tabBtns = document.querySelectorAll(".inspector-tabs .tab-btn");
  const inspectorPane = document.querySelector(".inspector-pane");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.tab;
      document.getElementById("panelSubtitles").classList.toggle("active", target === "subtitles");
      document.getElementById("panelStyles").classList.toggle("active", target === "styles");

      if (inspectorPane) {
        inspectorPane.classList.toggle("timeline-active", target === "timeline");
      }

      const tlPane = document.querySelector(".timeline-pane");
      if (tlPane) {
        if (target === "timeline") {
          tlPane.classList.add("mobile-show-timeline");
          requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        } else {
          tlPane.classList.remove("mobile-show-timeline");
        }
      }
    });
  });
}

function initMobileMode() {
  const btnToggle = document.getElementById("btnToggleMobileMode");
  const icon = document.getElementById("mobileModeIcon");
  const text = document.getElementById("mobileModeText");

  const ua = navigator.userAgent || "";
  const isAppOrMobile = /Android|iPhone|iPad|iPod|Mobile|SubAIStudioMobile/i.test(ua) || window.AndroidNative !== undefined || window.innerWidth <= 850;
  const savedMobile = localStorage.getItem("subai_mobile_mode");

  let isMobileInitial = true;
  if (isAppOrMobile) {
    if (ua.includes("SubAIStudioMobile") || window.AndroidNative !== undefined) {
      isMobileInitial = true;
    } else {
      isMobileInitial = savedMobile !== "false";
    }
  } else {
    isMobileInitial = savedMobile === "true" || window.innerWidth <= 850;
  }

  function applyMobileMode(isMobile, showNotice) {
    document.documentElement.classList.toggle("mobile-mode", isMobile);
    document.body.classList.toggle("mobile-mode", isMobile);
    if (isMobile) {
      document.body.classList.add("mobile-device");
    }
    if (icon) icon.textContent = isMobile ? "💻" : "📱";
    if (text) text.textContent = isMobile ? "Giao diện PC" : "Giao diện ĐT";
    if (!isMobile) {
      const activeTab = document.querySelector(".inspector-tabs .tab-btn.active");
      if (activeTab && activeTab.dataset.tab === "timeline") {
        document.getElementById("tabBtnSubtitles")?.click();
      }
    }
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    if (showNotice) {
      showToast(isMobile ? "Đã chuyển sang giao diện Điện thoại." : "Đã chuyển sang giao diện Máy tính.", "info", 2000);
    }
  }

  applyMobileMode(isMobileInitial, false);

  if (btnToggle) {
    btnToggle.addEventListener("click", () => {
      const next = !document.body.classList.contains("mobile-mode");
      localStorage.setItem("subai_mobile_mode", next ? "true" : "false");
      applyMobileMode(next, true);
    });
  }

  window.addEventListener("resize", () => {
    if (localStorage.getItem("subai_mobile_mode") === null) {
      applyMobileMode(window.innerWidth <= 850 || isAppOrMobile, false);
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function initUpload() {
  const fileInput = document.getElementById("videoFileInput");
  const dropCard = document.getElementById("dropCard");
  const btnPickVideo = document.getElementById("btnPickVideo");
  const btnChangeVideo = document.getElementById("btnChangeVideo");

  btnPickVideo.addEventListener("click", () => fileInput.click());
  btnChangeVideo.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      handleVideoFile(fileInput.files[0]);
      fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropCard.addEventListener(evt, (e) => {
      e.preventDefault();
      dropCard.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropCard.addEventListener(evt, (e) => {
      e.preventDefault();
      dropCard.classList.remove("dragover");
    });
  });
  dropCard.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleVideoFile(file);
  });
}

async function handleVideoFile(file) {
  const uploadZone = document.getElementById("uploadZone");
  const dropCard = document.getElementById("dropCard");
  const progressCard = document.getElementById("uploadProgressCard");
  const progressTitle = document.getElementById("uploadProgressTitle");
  const progressSub = document.getElementById("uploadProgressSub");
  const progressBar = document.getElementById("uploadProgressBar");
  const playerShell = document.getElementById("playerShell");

  uploadZone.hidden = false;
  playerShell.hidden = true;
  dropCard.hidden = true;
  progressCard.hidden = false;
  progressBar.style.width = "10%";
  progressTitle.textContent = `Đang mở "${file.name}" trực tiếp trên thiết bị...`;
  progressSub.textContent = "Không cần tải lên server — xử lý siêu tốc ngay trên trình duyệt";

  try {
    currentVideoFile = file;
    currentPcm16k = null;
    if (currentVideoObjectUrl) {
      URL.revokeObjectURL(currentVideoObjectUrl);
    }
    currentVideoObjectUrl = URL.createObjectURL(file);

    // Show video player INSTANTLY (< 0.1s) without waiting for audio extraction
    const videoId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.video = {
      videoId,
      filename: file.name,
      videoUrl: currentVideoObjectUrl,
      mediaUrl: currentVideoObjectUrl,
      duration: 0,
      width: 1280,
      height: 720,
      peaks: [],
    };

    document.getElementById("videoFileName").textContent = file.name;
    document.getElementById("btnChangeVideo").hidden = false;
    document.getElementById("btnGenerateAI").disabled = false;
    document.getElementById("btnOpenExport").disabled = false;
    document.getElementById("btnSaveProject").disabled = false;

    uploadZone.hidden = true;
    playerShell.hidden = false;
    dropCard.hidden = false;
    progressCard.hidden = true;

    setSubtitles([], false);
    emit("video:loaded", state.video);
    showToast(`⚡ Đã mở video "${file.name}" tức thì! Bấm "Tạo & Dịch Phụ Đề AI" bất cứ lúc nào.`, "success", 3500);

    // Extract 16kHz audio + waveform peaks asynchronously in the background
    pendingAudioPromise = extractAudioAndPeaks(file, () => {})
      .then((audioData) => {
        if (currentVideoFile !== file) return;
        currentPcm16k = audioData.pcm16k;
        if (state.video && state.video.videoId === videoId) {
          state.video.peaks = audioData.peaks || [];
          if (!state.video.duration && audioData.duration) {
            state.video.duration = audioData.duration;
          }
          emit("subtitles:change");
        }
      })
      .catch((audioErr) => {
        console.warn("Background audio decode warning:", audioErr);
        if (currentVideoFile === file) currentPcm16k = null;
      })
      .finally(() => {
        if (currentVideoFile === file) pendingAudioPromise = null;
      });
    return;
  } catch (err) {
    dropCard.hidden = false;
    progressCard.hidden = true;
    showToast(err.message || "Không thể mở tệp video.", "error", 5000);
  }
}

function initTopbarActions() {
  const targetLangSelect = document.getElementById("targetLangSelect");
  const transStyleSelect = document.getElementById("transStyleSelect");
  const btnGenerateAI = document.getElementById("btnGenerateAI");
  const btnRetranslate = document.getElementById("btnRetranslate");
  const btnCancelAI = document.getElementById("btnCancelAI");

  targetLangSelect.value = state.targetLanguage;
  transStyleSelect.value = state.translationStyle;

  targetLangSelect.addEventListener("change", () => {
    state.targetLanguage = targetLangSelect.value;
    persistSettings();
  });

  transStyleSelect.addEventListener("change", () => {
    state.translationStyle = transStyleSelect.value;
    persistSettings();
  });

  btnGenerateAI.addEventListener("click", runClientSideAI);
  btnRetranslate.addEventListener("click", runRetranslateAll);

  if (btnCancelAI) {
    btnCancelAI.addEventListener("click", () => {
      if (whisperWorker) {
        whisperWorker.terminate();
        whisperWorker = null;
      }
      isGenerating = false;
      document.getElementById("aiLoadingOverlay").hidden = true;
      btnGenerateAI.disabled = !state.video;
      btnRetranslate.disabled = state.subtitles.length === 0;
      showToast("Đã dừng nhận diện AI.", "info");
    });
  }

  on("subtitles:change", () => {
    btnRetranslate.disabled = state.subtitles.length === 0 || isGenerating;
  });
}

function setAiBanner(visible, title, desc, pct) {
  const overlay = document.getElementById("aiLoadingOverlay");
  const titleEl = document.getElementById("aiLoadingTitle");
  const descEl = document.getElementById("aiLoadingDesc");
  const progressWrap = document.getElementById("aiProgressWrap");
  const progressBar = document.getElementById("aiProgressBar");
  const btnCancelAI = document.getElementById("btnCancelAI");

  overlay.hidden = !visible;
  if (title) titleEl.textContent = title;
  if (desc) descEl.textContent = desc;
  if (typeof pct === "number") {
    progressWrap.hidden = false;
    progressBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  }
  if (btnCancelAI) btnCancelAI.hidden = !visible;
}

function hasSpeechEnergy(pcmSlice, threshold = 0.0025) {
  let sumSq = 0;
  const step = 16; // Fast subsampling check
  let count = 0;
  for (let i = 0; i < pcmSlice.length; i += step) {
    const v = pcmSlice[i];
    sumSq += v * v;
    count++;
  }
  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
  return rms >= threshold;
}

function runWhisperWorkerChunk(audioSlice, modelKey, sourceLanguage, onStatus) {
  return new Promise((resolve, reject) => {
    if (!whisperWorker) {
      whisperWorker = new Worker(new URL("./whisper-worker.js", import.meta.url), {
        type: "module",
      });
    }

    const handleMsg = (e) => {
      const data = e.data || {};
      if (data.type === "status") {
        if (onStatus) onStatus(data.message, data.progress);
      } else if (data.type === "complete") {
        cleanup();
        resolve(data.segments || []);
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(data.error || "Lỗi Whisper Worker"));
      }
    };

    const handleErr = (err) => {
      cleanup();
      reject(new Error(err?.message || "Lỗi khởi chạy Web Worker AI"));
    };

    function cleanup() {
      whisperWorker?.removeEventListener("message", handleMsg);
      whisperWorker?.removeEventListener("error", handleErr);
    }

    whisperWorker.addEventListener("message", handleMsg);
    whisperWorker.addEventListener("error", handleErr);

    const audioCopy = new Float32Array(audioSlice);
    whisperWorker.postMessage(
      {
        type: "transcribe",
        audio: audioCopy,
        modelKey,
        sourceLanguage,
      },
      [audioCopy.buffer]
    );
  });
}

async function runClientSideAI() {
  if (!state.video || isGenerating) return;
  const useGroq = Boolean(state.groqApiKey && state.groqApiKey.trim());

  isGenerating = true;
  const btnGenerateAI = document.getElementById("btnGenerateAI");
  const btnRetranslate = document.getElementById("btnRetranslate");
  btnGenerateAI.disabled = true;
  btnRetranslate.disabled = true;

  if (!currentPcm16k && pendingAudioPromise) {
    setAiBanner(true, "Đang hoàn tất tách âm thanh từ video...", "Đợi một chút là xong...", 8);
    try {
      await pendingAudioPromise;
    } catch {}
  }

  const canDirectGroq = !currentPcm16k && useGroq && currentVideoFile && currentVideoFile.size <= 24 * 1024 * 1024;
  if (!currentPcm16k && !canDirectGroq) {
    isGenerating = false;
    setAiBanner(false);
    btnGenerateAI.disabled = !state.video;
    btnRetranslate.disabled = state.subtitles.length === 0;
    showToast("Video chưa giải mã được âm thanh 16kHz (thử cập nhật APK mới nhất hoặc file MP4 chuẩn AAC).", "error", 5500);
    return;
  }

  try {
    let cloudHandled = false;

    if (useGroq) {
      try {
        setAiBanner(
          true,
          "⚡ Chế độ Siêu Tốc (Groq Cloud 200x) đang chạy...",
          "Đang nén khoảng lặng & xử lý trên Cloud...",
          10
        );

        const translatedByChunk = {};
        const chunkTransPromises = [];

        const segments = currentPcm16k
          ? await transcribeWithGroqCloud(
              currentPcm16k,
              state.groqApiKey,
              state.sourceLanguage,
              (msg, pct) => {
                setAiBanner(true, "⚡ Groq Cloud đang nhận diện giọng nói...", msg, pct);
              },
              (chunkIdx, segs) => {
                if (!segs.length) return;
                const p = translateBatch(segs.map((s) => s.text), state.targetLanguage).then((tr) => {
                  translatedByChunk[chunkIdx] = segs.map((seg, i) => ({
                    id: `sub-${Date.now()}-${chunkIdx}-${i}`,
                    start: seg.start,
                    end: seg.end,
                    originalText: seg.text,
                    translatedText: tr[i] || seg.text,
                  }));
                });
                chunkTransPromises.push(p);
              }
            )
          : await transcribeFileDirectlyWithGroq(
              currentVideoFile,
              state.groqApiKey,
              state.sourceLanguage,
              (msg, pct) => {
                setAiBanner(true, "⚡ Groq Cloud đang nhận diện trực tiếp...", msg, pct);
              }
            );

        if (!isGenerating) return;
        if (!segments.length) {
          throw new Error("Không nhận diện được lời thoại trong video.");
        }

        let subs = [];
        if (currentPcm16k && chunkTransPromises.length > 0) {
          setAiBanner(true, `Đang hoàn tất dịch ${segments.length} câu...`, `Đích: ${state.targetLanguage}`, 88);
          await Promise.all(chunkTransPromises);
          const sortedKeys = Object.keys(translatedByChunk).map(Number).sort((a, b) => a - b);
          for (const k of sortedKeys) {
            subs.push(...translatedByChunk[k]);
          }
        } else {
          setAiBanner(
            true,
            `Đã nhận diện ${segments.length} câu! Đang dịch 8 luồng sang ${state.targetLanguage}...`,
            "Dịch tốc độ cao...",
            75
          );
          const origTexts = segments.map((s) => s.text);
          const translatedTexts = await translateBatch(origTexts, state.targetLanguage, (done, total) => {
            const pct = Math.round(75 + (done / Math.max(1, total)) * 24);
            setAiBanner(true, `⚡ AI đang dịch (${done}/${total})...`, `Đích: ${state.targetLanguage}`, pct);
          });
          subs = segments.map((seg, idx) => ({
            id: `sub-${Date.now()}-${idx}`,
            start: seg.start,
            end: seg.end,
            originalText: seg.text,
            translatedText: translatedTexts[idx] || seg.text,
          }));
        }

        setSubtitles(subs, true);
        showToast(`⚡ Hoàn tất siêu tốc! Đã tạo & dịch ${subs.length} câu phụ đề.`, "success", 4500);
        saveCurrentProject(true);
        cloudHandled = true;
      } catch (groqErr) {
        if (!isGenerating) return;
        console.warn("Groq fallback triggered:", groqErr);
        const isQuota = String(groqErr?.message || "").includes("429") || String(groqErr?.message || "").toLowerCase().includes("rate");
        showToast(
          isQuota
            ? "Groq tạm hết lượt miễn phí — tự động chuyển sang AI dự phòng!"
            : `Groq gặp sự cố (${groqErr.message}) — chuyển sang AI dự phòng!`,
          "info",
          4000
        );
      }
    }

    if (cloudHandled) return;

    const useGemini = Boolean(state.geminiApiKey && state.geminiApiKey.trim());
    if (useGemini && currentPcm16k) {
      try {
        setAiBanner(true, "✨ Gemini Flash Cloud đang nghe...", "Đang xử lý âm thanh qua Google Gemini...", 15);
        const translatedByChunk = {};
        const chunkTransPromises = [];

        const segments = await transcribeWithGeminiCloud(
          currentPcm16k,
          state.geminiApiKey,
          state.sourceLanguage,
          (msg, pct) => setAiBanner(true, "✨ Gemini Flash đang nhận diện...", msg, pct),
          (chunkIdx, segs) => {
            if (!segs.length) return;
            const p = translateBatch(segs.map((s) => s.text), state.targetLanguage).then((tr) => {
              translatedByChunk[chunkIdx] = segs.map((seg, i) => ({
                id: `sub-${Date.now()}-gm-${chunkIdx}-${i}`,
                start: seg.start,
                end: seg.end,
                originalText: seg.text,
                translatedText: tr[i] || seg.text,
              }));
            });
            chunkTransPromises.push(p);
          }
        );

        if (!isGenerating) return;
        if (segments.length > 0) {
          setAiBanner(true, `Đang hoàn tất dịch ${segments.length} câu...`, `Đích: ${state.targetLanguage}`, 88);
          await Promise.all(chunkTransPromises);
          const subs = [];
          const sortedKeys = Object.keys(translatedByChunk).map(Number).sort((a, b) => a - b);
          for (const k of sortedKeys) subs.push(...translatedByChunk[k]);
          setSubtitles(subs, true);
          showToast(`✨ Hoàn tất qua Gemini! Đã tạo & dịch ${subs.length} câu phụ đề.`, "success", 4500);
          saveCurrentProject(true);
          return;
        }
      } catch (gemErr) {
        if (!isGenerating) return;
        console.warn("Gemini fallback to local Whisper:", gemErr);
        showToast(`Gemini lỗi (${gemErr.message}) — chuyển sang Whisper trên máy!`, "info", 3500);
      }
    }

    if (!currentPcm16k) {
      throw new Error("Không tách được âm thanh 16kHz để chạy AI trên máy.");
    }

    // LOCAL TURBO STREAMING MODE:
    // Split long audio into 30s chunks, skip silent chunks, stream subtitles live, and translate in parallel!
    const SAMPLE_RATE = 16000;
    const totalSec = currentPcm16k.length / SAMPLE_RATE;
    const CHUNK_SEC = totalSec > 45 ? 30 : Math.ceil(totalSec);
    const CHUNK_SAMPLES = CHUNK_SEC * SAMPLE_RATE;

    const chunks = [];
    for (let s = 0; s < currentPcm16k.length; s += CHUNK_SAMPLES) {
      const e = Math.min(currentPcm16k.length, s + CHUNK_SAMPLES);
      chunks.push({
        startSample: s,
        endSample: e,
        offsetSec: s / SAMPLE_RATE,
      });
    }

    setAiBanner(
      true,
      `Whisper AI (${state.model}) đang khởi động...`,
      chunks.length > 1
        ? `Video dài ${Math.round(totalSec)}s — chia thành ${chunks.length} đoạn để dịch cuốn chiếu siêu tốc.`
        : "Lần đầu chạy sẽ tải mô hình và lưu cache trên máy.",
      5
    );

    const accumulatedSubs = [];
    const pendingTranslations = [];
    let skippedSilence = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (!isGenerating) return;
      const ch = chunks[i];
      const slice = currentPcm16k.subarray(ch.startSample, ch.endSample);

      // Skip silent chunks in long videos to save 20-40% processing time
      if (chunks.length > 1 && !hasSpeechEnergy(slice)) {
        skippedSilence++;
        const pct = Math.round(10 + ((i + 1) / chunks.length) * 85);
        setAiBanner(
          true,
          `Đang bỏ qua đoạn im lặng (${i + 1}/${chunks.length})...`,
          `Đã nhận diện ${accumulatedSubs.length} câu phụ đề`,
          pct
        );
        continue;
      }

      const rawSegs = await runWhisperWorkerChunk(
        slice,
        state.model,
        state.sourceLanguage,
        (msg, workerPct) => {
          const basePct = 10 + (i / chunks.length) * 85;
          const spanPct = (1 / chunks.length) * 85;
          const pct =
            chunks.length === 1
              ? Math.min(85, workerPct || 50)
              : Math.round(basePct + ((workerPct || 50) / 100) * spanPct);
          setAiBanner(
            true,
            chunks.length > 1
              ? `Đang nghe đoạn ${i + 1}/${chunks.length} (đã có ${accumulatedSubs.length} câu)...`
              : `Whisper AI (${state.model}) đang xử lý...`,
            msg,
            pct
          );
        }
      );

      if (!isGenerating) return;

      if (rawSegs.length > 0) {
        const chunkSubs = rawSegs.map((seg, idx) => ({
          id: `sub-${Date.now()}-${i}-${idx}`,
          start: Number((ch.offsetSec + seg.start).toFixed(3)),
          end: Number((ch.offsetSec + seg.end).toFixed(3)),
          originalText: seg.text,
          translatedText: seg.text,
        }));

        const startIdx = accumulatedSubs.length;
        accumulatedSubs.push(...chunkSubs);
        // Stream subtitles immediately so user sees results live while next chunk processes
        setSubtitles([...accumulatedSubs], false);

        // Pipeline translation in background while next Whisper chunk runs
        const textsToTranslate = chunkSubs.map((s) => s.originalText);
        const transPromise = translateBatch(textsToTranslate, state.targetLanguage).then((translated) => {
          for (let j = 0; j < chunkSubs.length; j++) {
            accumulatedSubs[startIdx + j].translatedText = translated[j] || chunkSubs[j].originalText;
          }
          setSubtitles([...accumulatedSubs], false);
        });
        pendingTranslations.push(transPromise);
      }
    }

    if (!isGenerating) return;

    setAiBanner(
      true,
      `Đang hoàn tất dịch thuật ${accumulatedSubs.length} câu...`,
      `Đích: ${state.targetLanguage}`,
      96
    );
    await Promise.all(pendingTranslations);

    if (!accumulatedSubs.length) {
      throw new Error("Không nhận diện được lời thoại trong video.");
    }

    setSubtitles([...accumulatedSubs], true);
    const skipNote = skippedSilence > 0 ? ` (đã bỏ qua ${skippedSilence} đoạn im lặng)` : "";
    showToast(`Hoàn tất! Đã tạo & dịch ${accumulatedSubs.length} câu phụ đề${skipNote}.`, "success", 4500);
    saveCurrentProject(true);
  } catch (err) {
    if (isGenerating) {
      showToast(err.message || "Lỗi xử lý AI trên trình duyệt.", "error", 6500);
    }
  } finally {
    isGenerating = false;
    setAiBanner(false);
    btnGenerateAI.disabled = !state.video;
    btnRetranslate.disabled = state.subtitles.length === 0;
  }
}

async function runRetranslateAll() {
  if (!state.subtitles.length || isGenerating) return;
  isGenerating = true;
  const btnRetranslate = document.getElementById("btnRetranslate");
  const btnGenerateAI = document.getElementById("btnGenerateAI");
  btnRetranslate.disabled = true;
  btnGenerateAI.disabled = true;

  setAiBanner(true, `Đang dịch lại ${state.subtitles.length} câu sang ${state.targetLanguage}...`, "Dịch tự động miễn phí...", 15);
  try {
    const origs = state.subtitles.map((s) => s.originalText || s.translatedText);
    const translated = await translateBatch(
      origs,
      state.targetLanguage,
      (done, total) => {
        const pct = Math.round(15 + (done / Math.max(1, total)) * 84);
        setAiBanner(true, `⚡ Đang dịch lại (${done}/${total})...`, `Ngôn ngữ đích: ${state.targetLanguage}`, pct);
      },
      { groqApiKey: state.groqApiKey, style: state.translationStyle }
    );
    const updated = state.subtitles.map((s, idx) => ({
      ...s,
      translatedText: translated[idx] || s.translatedText,
    }));
    setSubtitles(updated, true);
    showToast(`Đã dịch lại toàn bộ sang ${state.targetLanguage}!`, "success");
    saveCurrentProject(true);
  } catch (err) {
    showToast(err.message || "Lỗi dịch lại.", "error");
  } finally {
    isGenerating = false;
    setAiBanner(false);
    btnGenerateAI.disabled = !state.video;
    btnRetranslate.disabled = state.subtitles.length === 0;
  }
}

function initSettingsModal() {
  const modal = document.getElementById("settingsModal");
  const btnOpen = document.getElementById("btnOpenSettings");
  const selectModel = document.getElementById("selectModel");
  const selectSourceLang = document.getElementById("selectSourceLang");
  const selectDubGender = document.getElementById("selectDubGender");
  const selectDubEmotion = document.getElementById("selectDubEmotion");
  const inputGroqKey = document.getElementById("inputGroqKey");
  const inputGeminiKey = document.getElementById("inputGeminiKey");
  const btnSave = document.getElementById("btnSaveSettings");

  btnOpen.addEventListener("click", () => {
    selectModel.value = state.model;
    selectSourceLang.value = state.sourceLanguage;
    if (selectDubGender) selectDubGender.value = state.dubVoiceGender || "female";
    if (selectDubEmotion) selectDubEmotion.value = state.dubEmotion || "natural";
    if (inputGroqKey) inputGroqKey.value = state.groqApiKey || "";
    if (inputGeminiKey) inputGeminiKey.value = state.geminiApiKey || "";
    modal.hidden = false;
  });

  btnSave.addEventListener("click", () => {
    state.model = selectModel.value;
    const engineSel = document.getElementById("engineSelect");
    if (engineSel) engineSel.value = state.model;
    state.sourceLanguage = selectSourceLang.value;
    if (selectDubGender) state.dubVoiceGender = selectDubGender.value;
    if (selectDubEmotion) state.dubEmotion = selectDubEmotion.value;
    if (inputGroqKey) state.groqApiKey = inputGroqKey.value.trim();
    if (inputGeminiKey) state.geminiApiKey = inputGeminiKey.value.trim();
    persistSettings();
    modal.hidden = true;
    showToast(
      state.groqApiKey
        ? "⚡ Đã lưu cài đặt (Đã bật Groq Cloud Siêu Tốc 200x)!"
        : "Đã lưu cài đặt AI.",
      "success"
    );
  });

  bindModalClose(modal);
}

function initExportModal() {
  const modal = document.getElementById("exportModal");
  const btnOpen = document.getElementById("btnOpenExport");
  const importSubInput = document.getElementById("importSubFileInput");
  const btnImportSub = document.getElementById("btnImportSubFile");

  btnOpen.addEventListener("click", () => {
    document.getElementById("exportSubMode").value = state.style.displayMode;
    modal.hidden = false;
  });

  modal.querySelectorAll("button[data-export-fmt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.subtitles.length) {
        showToast("Chưa có phụ đề để xuất.", "error");
        return;
      }
      const format = btn.dataset.exportFmt;
      const mode = document.getElementById("exportSubMode").value;
      triggerDownloadSubtitle({
        format,
        mode,
        subtitles: state.subtitles,
        style: state.style,
        baseName: state.video?.filename || "subtitles",
      });
      showToast(`Đã tải xuống file phụ đề .${format.toUpperCase()}`, "success");
    });
  });

  if (btnImportSub && importSubInput) {
    btnImportSub.addEventListener("click", () => importSubInput.click());
    importSubInput.addEventListener("change", async () => {
      const f = importSubInput.files?.[0];
      if (!f) return;
      const text = await f.text();
      const parsed = parseSrtOrVtt(text);
      importSubInput.value = "";
      if (!parsed.length) {
        showToast("Không đọc được phụ đề từ file này.", "error");
        return;
      }
      setSubtitles(parsed, true);
      modal.hidden = true;
      showToast(`Đã nhập ${parsed.length} dòng phụ đề từ "${f.name}"!`, "success");
    });
  }

  bindModalClose(modal);
}

function bindModalClose(modal) {
  modal.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal.hidden = true;
    });
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

// ==================== PROJECT PERSISTENCE (IndexedDB) ====================
function updateSaveStatus(statusText, stateClass = "") {
  const wrap = document.getElementById("saveStatusWrap");
  const badge = document.getElementById("saveStatusBadge");
  if (!wrap || !badge) return;
  wrap.hidden = false;
  badge.textContent = statusText;
  badge.className = "save-status-badge" + (stateClass ? ` ${stateClass}` : "");
}

async function saveCurrentProject(isAuto = false) {
  if (!state.video) return;
  const btnSave = document.getElementById("btnSaveProject");
  if (btnSave) btnSave.disabled = true;
  updateSaveStatus("Đang lưu...", "saving");

  try {
    const res = await saveProjectLocal({
      videoId: state.video.videoId,
      filename: state.video.filename,
      duration: state.video.duration || 0,
      peaks: state.video.peaks || [],
      subtitles: state.subtitles,
      style: state.style,
      targetLanguage: state.targetLanguage,
    });
    const nowStr = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    updateSaveStatus(`Đã lưu lúc ${nowStr}`, "saved");
    if (!isAuto) {
      showToast(`Đã lưu dự án "${state.video.filename}" (${res.count} câu phụ đề) vào trình duyệt!`, "success");
    }
    renderProjectsList();
  } catch (err) {
    updateSaveStatus("Lỗi lưu!", "error");
    if (!isAuto) showToast(err.message || "Lỗi lưu dự án.", "error");
  } finally {
    if (btnSave) btnSave.disabled = false;
  }
}

function scheduleAutoSave() {
  if (!state.video) return;
  updateSaveStatus("Chưa lưu...", "dirty");
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveCurrentProject(true);
  }, 1500);
}

async function loadProjectIntoStudio(videoId) {
  try {
    const proj = await getProjectLocal(videoId);
    if (!proj) throw new Error("Không tìm thấy dự án.");

    state.video = {
      videoId: proj.videoId,
      filename: proj.filename,
      videoUrl: currentVideoObjectUrl || "",
      mediaUrl: currentVideoObjectUrl || "",
      duration: proj.duration || 0,
      width: 1280,
      height: 720,
      peaks: proj.peaks || [],
    };

    if (proj.style && typeof proj.style === "object") {
      Object.assign(state.style, proj.style);
      emit("style:change", state.style);
    }

    document.getElementById("videoFileName").textContent = proj.filename;
    document.getElementById("btnChangeVideo").hidden = false;
    document.getElementById("btnGenerateAI").disabled = false;
    document.getElementById("btnOpenExport").disabled = false;
    document.getElementById("btnSaveProject").disabled = false;

    document.getElementById("uploadZone").hidden = true;
    document.getElementById("playerShell").hidden = false;

    setSubtitles(proj.subtitles || [], false);
    emit("video:loaded", state.video);
    updateSaveStatus("Đã lưu trên máy", "saved");

    document.getElementById("projectsModal").hidden = true;
    showToast(`Đã mở dự án "${proj.filename}" (${state.subtitles.length} câu phụ đề). Nhấn "Đổi video" nếu cần nạp lại file hình.`, "success", 4500);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function renderProjectsList() {
  const container = document.getElementById("projectsModalList");
  const recentBox = document.getElementById("recentProjectsBox");
  const recentList = document.getElementById("recentProjectsList");

  try {
    const projects = await listProjectsLocal();

    if (container) {
      if (!projects.length) {
        container.innerHTML = `<div class="empty-state" style="padding: 36px 20px;">
          <p>Chưa có dự án nào được lưu trên trình duyệt.</p>
          <span>Chọn video và tạo phụ đề — dự án sẽ tự động lưu lại trên máy bạn.</span>
        </div>`;
      } else {
        container.innerHTML = "";
        for (const p of projects) {
          const card = document.createElement("div");
          card.className = "project-card";
          const mins = Math.floor((p.duration || 0) / 60);
          const secs = Math.floor((p.duration || 0) % 60).toString().padStart(2, "0");
          const dateStr = p.updatedAt ? new Date(p.updatedAt * 1000).toLocaleString("vi-VN") : "";
          const count = (p.subtitles || []).length;

          card.innerHTML = `
            <div class="project-card-info">
              <div class="project-card-title" title="${p.filename}">${p.filename}</div>
              <div class="project-card-meta">
                <span>⏱ ${mins}:${secs}</span>
                <span>💬 ${count} câu phụ đề</span>
                <span>🕒 ${dateStr}</span>
              </div>
            </div>
            <div class="project-card-actions">
              <button class="btn btn-primary btn-sm btn-open-proj">Mở tiếp</button>
              <button class="btn btn-ghost btn-sm btn-del-proj" title="Xóa dự án">🗑</button>
            </div>
          `;

          card.querySelector(".btn-open-proj").addEventListener("click", () => loadProjectIntoStudio(p.videoId));
          card.querySelector(".btn-del-proj").addEventListener("click", async () => {
            if (!confirm(`Xóa dự án "${p.filename}"?`)) return;
            await deleteProjectLocal(p.videoId);
            showToast("Đã xóa dự án.", "info");
            renderProjectsList();
          });
          container.appendChild(card);
        }
      }
    }

    if (recentBox && recentList) {
      const topRecents = projects.slice(0, 4);
      recentList.innerHTML = "";
      for (const p of topRecents) {
        const pill = document.createElement("div");
        pill.className = "recent-project-pill";
        pill.innerHTML = `<span class="recent-project-name">🎬 ${p.filename}</span> <span class="badge">${(p.subtitles || []).length} câu</span>`;
        pill.addEventListener("click", () => loadProjectIntoStudio(p.videoId));
        recentList.appendChild(pill);
      }
      recentBox.hidden = topRecents.length === 0;
    }
  } catch (err) {
    if (container) container.innerHTML = `<div style="color:var(--danger); padding:20px;">Lỗi đọc bộ nhớ trình duyệt: ${err.message}</div>`;
  }
}

function initProjectSystem() {
  const btnOpenProjects = document.getElementById("btnOpenProjects");
  const modal = document.getElementById("projectsModal");
  const btnSaveProject = document.getElementById("btnSaveProject");

  btnOpenProjects.addEventListener("click", () => {
    modal.hidden = false;
    renderProjectsList();
  });

  btnSaveProject.addEventListener("click", () => saveCurrentProject(false));

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.video) saveCurrentProject(false);
    }
  });

  on("subtitles:change", () => {
    btnSaveProject.disabled = !state.video;
    if (state.video && state.subtitles.length > 0) scheduleAutoSave();
  });

  on("style:change", () => {
    if (state.video && state.subtitles.length > 0) scheduleAutoSave();
  });

  bindModalClose(modal);
}

bootstrap();
