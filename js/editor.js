// Right sidebar bilingual subtitle list editor with inline editing, split, merge, delete, and AI line refine

import {
  state,
  on,
  emit,
  pushHistory,
  updateSubtitle,
  formatTimeShort,
  parseTimeShort,
  showToast,
} from "./state.js";
import { translateSingleLine } from "./translator.js";

let listEl;
let countBadge;
let searchInput;
let btnAddSubtitle;
let lastActiveId = null;

export function initSubtitleEditor() {
  listEl = document.getElementById("subtitleList");
  countBadge = document.getElementById("subtitleCountBadge");
  searchInput = document.getElementById("subtitleSearchInput");
  btnAddSubtitle = document.getElementById("btnAddSubtitle");

  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value.trim().toLowerCase();
    renderList();
  });

  btnAddSubtitle.addEventListener("click", addSubtitleAtPlayhead);

  on("video:loaded", () => {
    btnAddSubtitle.disabled = false;
  });

  on("subtitles:change", (meta) => {
    countBadge.textContent = String(state.subtitles.length);
    // Avoid losing focus when user is typing inside an existing card textarea
    const focused = document.activeElement;
    if (meta?.updatedId && focused && focused.closest(`.sub-card[data-id="${meta.updatedId}"]`)) {
      return;
    }
    renderList();
  });

  on("selection:change", (id) => {
    highlightCard(id, true);
  });

  on("time:tick", (t) => {
    const active = state.subtitles.find((s) => t >= s.start && t <= s.end);
    const activeId = active ? active.id : null;
    if (activeId !== lastActiveId) {
      lastActiveId = activeId;
      highlightCard(activeId, state.isPlaying);
    }
  });
}

function addSubtitleAtPlayhead() {
  if (!state.video) return;
  pushHistory();
  const start = Number(state.currentTime.toFixed(2));
  const maxDur = state.video.duration || start + 3;
  const end = Number(Math.min(maxDur, start + 2.5).toFixed(2));
  const id = `sub-${Date.now()}`;
  state.subtitles.push({
    id,
    start,
    end: Math.max(start + 0.5, end),
    originalText: "Lời thoại gốc...",
    translatedText: "Bản dịch mới...",
  });
  state.subtitles.sort((a, b) => a.start - b.start);
  state.selectedId = id;
  emit("subtitles:change");
  emit("selection:change", id);
}

function renderList() {
  if (!listEl) return;
  const q = state.searchQuery;
  const items = q
    ? state.subtitles.filter(
        (s) =>
          s.translatedText.toLowerCase().includes(q) ||
          s.originalText.toLowerCase().includes(q)
      )
    : state.subtitles;

  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state">
      <p>${q ? "Không tìm thấy dòng phụ đề phù hợp." : "Chưa có phụ đề nào."}</p>
      <span>${
        q
          ? "Thử từ khóa tìm kiếm khác."
          : "Nhấn <strong>Tạo &amp; Dịch Phụ Đề AI</strong> ở thanh trên cùng hoặc nhấn <strong>+ Thêm</strong> để tự nhập."
      }</span>
    </div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach((sub, visibleIdx) => {
    const realIndex = state.subtitles.findIndex((x) => x.id === sub.id);
    const card = document.createElement("div");
    card.className = `sub-card${sub.id === state.selectedId || sub.id === lastActiveId ? " active" : ""}`;
    card.dataset.id = sub.id;

    card.innerHTML = `
      <div class="sub-card-head">
        <span class="sub-index">#${realIndex + 1}</span>
        <div class="sub-times">
          <input class="time-input start-inp" value="${formatTimeShort(sub.start)}" title="Thời gian bắt đầu (mm:ss.xx)" />
          <span>→</span>
          <input class="time-input end-inp" value="${formatTimeShort(sub.end)}" title="Thời gian kết thúc (mm:ss.xx)" />
        </div>
        <div class="sub-actions">
          <button class="sub-action-btn btn-jump" title="Phát từ mốc này">▶</button>
          <button class="sub-action-btn btn-ai-line" title="Dịch lại dòng này bằng Gemini AI">✨</button>
          <button class="sub-action-btn btn-split" title="Tách đôi dòng này">✂</button>
          <button class="sub-action-btn btn-merge" title="Gộp với dòng kế tiếp" ${realIndex >= state.subtitles.length - 1 ? "disabled" : ""}>⇕</button>
          <button class="sub-action-btn danger btn-del" title="Xóa dòng này">✕</button>
        </div>
      </div>
      <textarea class="sub-textarea trans" rows="2" placeholder="Bản dịch..."></textarea>
      <textarea class="sub-textarea orig" rows="1" placeholder="Lời thoại gốc..."></textarea>
    `;

    const transEl = card.querySelector(".sub-textarea.trans");
    const origEl = card.querySelector(".sub-textarea.orig");
    const startInp = card.querySelector(".start-inp");
    const endInp = card.querySelector(".end-inp");

    transEl.value = sub.translatedText;
    origEl.value = sub.originalText;

    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      state.selectedId = sub.id;
      emit("selection:change", sub.id);
    });

    transEl.addEventListener("input", () => {
      updateSubtitle(sub.id, { translatedText: transEl.value });
    });
    origEl.addEventListener("input", () => {
      updateSubtitle(sub.id, { originalText: origEl.value });
    });

    startInp.addEventListener("change", () => {
      const val = parseTimeShort(startInp.value);
      if (val !== null && val < sub.end - 0.1) {
        updateSubtitle(sub.id, { start: Number(val.toFixed(3)) }, true);
        state.subtitles.sort((a, b) => a.start - b.start);
        emit("subtitles:change");
      } else {
        startInp.value = formatTimeShort(sub.start);
      }
    });

    endInp.addEventListener("change", () => {
      const val = parseTimeShort(endInp.value);
      if (val !== null && val > sub.start + 0.1) {
        updateSubtitle(sub.id, { end: Number(val.toFixed(3)) }, true);
      } else {
        endInp.value = formatTimeShort(sub.end);
      }
    });

    card.querySelector(".btn-jump").addEventListener("click", () => {
      state.selectedId = sub.id;
      emit("selection:change", sub.id);
      emit("player:seek", { time: sub.start + 0.01, autoPlay: true });
    });

    card.querySelector(".btn-split").addEventListener("click", () => splitSubtitle(sub.id));
    card.querySelector(".btn-merge").addEventListener("click", () => mergeSubtitle(sub.id));
    card.querySelector(".btn-del").addEventListener("click", () => deleteSubtitle(sub.id));
    card.querySelector(".btn-ai-line").addEventListener("click", (e) => handleRefineLine(sub.id, e.currentTarget));

    frag.appendChild(card);
  });

  listEl.innerHTML = "";
  listEl.appendChild(frag);
}

function highlightCard(id, scrollIntoView = false) {
  if (!listEl) return;
  let targetCard = null;
  listEl.querySelectorAll(".sub-card").forEach((card) => {
    const match = Boolean(id && card.dataset.id === id);
    card.classList.toggle("active", match);
    if (match) targetCard = card;
  });
  if (targetCard && scrollIntoView) {
    targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function splitSubtitle(id) {
  const idx = state.subtitles.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const sub = state.subtitles[idx];
  const mid = Number(((sub.start + sub.end) / 2).toFixed(3));
  if (mid - sub.start < 0.2) return;

  const splitText = (txt) => {
    const words = txt.trim().split(/\s+/);
    if (words.length <= 1) return [txt, ""];
    const half = Math.ceil(words.length / 2);
    return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
  };

  const [t1, t2] = splitText(sub.translatedText);
  const [o1, o2] = splitText(sub.originalText);

  pushHistory();
  state.subtitles.splice(
    idx,
    1,
    { id: sub.id, start: sub.start, end: mid, originalText: o1, translatedText: t1 },
    { id: `sub-${Date.now()}`, start: mid, end: sub.end, originalText: o2 || o1, translatedText: t2 || t1 }
  );
  emit("subtitles:change");
}

function mergeSubtitle(id) {
  const idx = state.subtitles.findIndex((s) => s.id === id);
  if (idx === -1 || idx >= state.subtitles.length - 1) return;
  const a = state.subtitles[idx];
  const b = state.subtitles[idx + 1];

  pushHistory();
  state.subtitles.splice(idx, 2, {
    id: a.id,
    start: a.start,
    end: b.end,
    originalText: `${a.originalText} ${b.originalText}`.trim(),
    translatedText: `${a.translatedText} ${b.translatedText}`.trim(),
  });
  emit("subtitles:change");
}

function deleteSubtitle(id) {
  pushHistory();
  state.subtitles = state.subtitles.filter((s) => s.id !== id);
  emit("subtitles:change");
}

async function handleRefineLine(id, btn) {
  const idx = state.subtitles.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const sub = state.subtitles[idx];

  btn.disabled = true;
  btn.textContent = "…";
  try {
    const translatedText = await translateSingleLine(
      sub.originalText || sub.translatedText,
      state.targetLanguage
    );
    if (translatedText) {
      updateSubtitle(id, { translatedText }, true);
      emit("subtitles:change");
      showToast("Đã dịch lại câu phụ đề.", "success");
    }
  } catch (err) {
    showToast(err.message || "Không thể dịch câu này.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨";
  }
}
