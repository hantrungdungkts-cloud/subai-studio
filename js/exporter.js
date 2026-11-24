// 100% Client-Side Subtitle Export (.SRT, .VTT, .ASS) & Import (.SRT / .VTT)

function pad2(n) {
  return String(Math.floor(n)).padStart(2, "0");
}

function pad3(n) {
  return String(Math.floor(n)).padStart(3, "0");
}

function fmtSrtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(secs)},${pad3(Math.min(999, ms))}`;
}

function fmtVttTime(sec) {
  return fmtSrtTime(sec).replace(",", ".");
}

function fmtAssTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  return `${h}:${pad2(m)}:${pad2(secs)}.${pad2(cs)}`;
}

function hexToAssColor(hex, alpha = 0) {
  const clean = (hex || "#ffffff").replace("#", "");
  const r = clean.slice(0, 2) || "ff";
  const g = clean.slice(2, 4) || "ff";
  const b = clean.slice(4, 6) || "ff";
  const a = pad2(Math.max(0, Math.min(255, Math.round(alpha))).toString(16));
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function formatCueText(sub, mode, newline = "\n") {
  const trans = (sub.translatedText || "").trim();
  const orig = (sub.originalText || "").trim();
  if (mode === "original") return orig || trans;
  if (mode === "bilingual") {
    if (trans && orig && trans !== orig) return `${trans}${newline}${orig}`;
    return trans || orig;
  }
  return trans || orig;
}

export function buildSrt(subtitles, mode = "translated") {
  return subtitles
    .map((s, i) => {
      const text = formatCueText(s, mode, "\n");
      return `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${text}\n`;
    })
    .join("\n");
}

export function buildVtt(subtitles, mode = "translated") {
  const body = subtitles
    .map((s) => {
      const text = formatCueText(s, mode, "\n");
      return `${fmtVttTime(s.start)} --> ${fmtVttTime(s.end)}\n${text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function buildAss(subtitles, mode = "translated", style = {}) {
  const font = style.fontFamily || "Be Vietnam Pro";
  const size = Math.round((style.fontSize || 28) * 1.3);
  const primary = hexToAssColor(style.color || "#ffffff", 0);
  const outline = hexToAssColor(style.outlineColor || "#000000", 0);
  const backAlpha = Math.round((1 - (style.bgOpacity ?? 0.55)) * 255);
  const back = hexToAssColor(style.bgColor || "#000000", backAlpha);
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  const align = style.position === "top" ? 8 : style.position === "middle" ? 5 : 2;
  const marginV = Math.round(style.marginBottom ?? 36);

  const header = `[Script Info]
Title: SubAI Studio Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${size},${primary},&H000000FF,${outline},${back},${bold},${italic},0,0,100,100,0,0,1,${style.outlineWidth ?? 2},1,${align},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = subtitles.map((s) => {
    const text = formatCueText(s, mode, "\\N").replace(/\r?\n/g, "\\N");
    return `Dialogue: 0,${fmtAssTime(s.start)},${fmtAssTime(s.end)},Default,,0,0,0,,${text}`;
  });

  return header + lines.join("\n") + "\n";
}

export function triggerDownloadSubtitle({ format, mode, subtitles, style, baseName }) {
  let content = "";
  let mime = "text/plain;charset=utf-8";
  if (format === "vtt") {
    content = buildVtt(subtitles, mode);
    mime = "text/vtt;charset=utf-8";
  } else if (format === "ass") {
    content = buildAss(subtitles, mode, style);
  } else {
    content = buildSrt(subtitles, mode);
  }

  const blob = new Blob(["\uFEFF" + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeBase = (baseName || "subtitles").replace(/\.[^/.]+$/, "");
  a.href = url;
  a.download = `${safeBase}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseTimestamp(ts) {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

export function parseSrtOrVtt(rawText) {
  const normalized = (rawText || "").replace(/\r\n/g, "\n").replace(/^WEBVTT.*\n+/i, "").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/);
  const subs = [];
  blocks.forEach((block, idx) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) return;
    const [sStr, eStr] = lines[timeIdx].split("-->");
    const start = parseTimestamp(sStr);
    const end = parseTimestamp((eStr || "").split(" ")[0]);
    const textLines = lines.slice(timeIdx + 1);
    if (!textLines.length) return;
    const text = textLines.join("\n");
    subs.push({
      id: `imp-${Date.now()}-${idx}`,
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start + 0.3, end).toFixed(3)),
      originalText: text,
      translatedText: text,
    });
  });
  return subs;
}
