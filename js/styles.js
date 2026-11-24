// Subtitle typography & appearance panel bindings

import { state, STYLE_PRESETS, updateStyle, on } from "./state.js";

export function initStylePanel() {
  const displayMode = document.getElementById("styleDisplayMode");
  const fontFamily = document.getElementById("styleFontFamily");
  const fontSize = document.getElementById("styleFontSize");
  const originalScale = document.getElementById("styleOriginalScale");
  const bold = document.getElementById("styleBold");
  const italic = document.getElementById("styleItalic");
  const textColor = document.getElementById("styleTextColor");
  const originalColor = document.getElementById("styleOriginalColor");
  const outlineColor = document.getElementById("styleOutlineColor");
  const bgColor = document.getElementById("styleBgColor");
  const outlineWidth = document.getElementById("styleOutlineWidth");
  const bgOpacity = document.getElementById("styleBgOpacity");
  const marginV = document.getElementById("styleMarginV");
  const positionGroup = document.getElementById("stylePositionGroup");
  const presets = document.getElementById("stylePresets");

  const syncControlsFromState = () => {
    const s = state.style;
    displayMode.value = s.displayMode;
    fontFamily.value = s.fontFamily;
    fontSize.value = s.fontSize;
    document.getElementById("valFontSize").textContent = `${s.fontSize}px`;
    originalScale.value = Math.round(s.originalScale * 100);
    document.getElementById("valOriginalScale").textContent = `${Math.round(s.originalScale * 100)}%`;
    bold.checked = Boolean(s.bold);
    italic.checked = Boolean(s.italic);
    textColor.value = s.textColor;
    originalColor.value = s.originalColor;
    outlineColor.value = s.outlineColor;
    bgColor.value = s.bgColor;
    outlineWidth.value = s.outlineWidth;
    document.getElementById("valOutlineWidth").textContent = `${Number(s.outlineWidth).toFixed(1)}px`;
    bgOpacity.value = Math.round(s.bgOpacity * 100);
    document.getElementById("valBgOpacity").textContent = `${Math.round(s.bgOpacity * 100)}%`;
    marginV.value = s.marginV;
    document.getElementById("valMarginV").textContent = `${s.marginV}px`;

    positionGroup.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pos === s.position);
    });
  };

  displayMode.addEventListener("change", () => updateStyle({ displayMode: displayMode.value }));
  fontFamily.addEventListener("change", () => updateStyle({ fontFamily: fontFamily.value }));
  fontSize.addEventListener("input", () => updateStyle({ fontSize: Number(fontSize.value) }));
  originalScale.addEventListener("input", () => updateStyle({ originalScale: Number(originalScale.value) / 100 }));
  bold.addEventListener("change", () => updateStyle({ bold: bold.checked }));
  italic.addEventListener("change", () => updateStyle({ italic: italic.checked }));
  textColor.addEventListener("input", () => updateStyle({ textColor: textColor.value }));
  originalColor.addEventListener("input", () => updateStyle({ originalColor: originalColor.value }));
  outlineColor.addEventListener("input", () => updateStyle({ outlineColor: outlineColor.value }));
  bgColor.addEventListener("input", () => updateStyle({ bgColor: bgColor.value }));
  outlineWidth.addEventListener("input", () => updateStyle({ outlineWidth: Number(outlineWidth.value) }));
  bgOpacity.addEventListener("input", () => updateStyle({ bgOpacity: Number(bgOpacity.value) / 100 }));
  marginV.addEventListener("input", () => updateStyle({ marginV: Number(marginV.value) }));

  positionGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-pos]");
    if (!btn) return;
    updateStyle({ position: btn.dataset.pos });
  });

  presets.addEventListener("click", (e) => {
    const card = e.target.closest("button[data-preset]");
    if (!card) return;
    const preset = STYLE_PRESETS[card.dataset.preset];
    if (!preset) return;
    presets.querySelectorAll(".preset-card").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    updateStyle({ ...preset });
  });

  on("style:change", syncControlsFromState);
  syncControlsFromState();
}
