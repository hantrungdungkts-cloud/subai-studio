// Client-side audio extraction (16kHz mono Float32Array for Whisper + waveform peaks for Timeline)
// Includes Native Android MediaCodec fallback for MKV/HEVC/AC3/large videos in the APK.

function extractViaAndroidNative() {
  return new Promise((resolve, reject) => {
    if (!window.AndroidNative?.extractAudio16kAsync) {
      reject(new Error("No native extractor"));
      return;
    }
    window.__onNativeAudioReady = async (ok, errMsg) => {
      delete window.__onNativeAudioReady;
      if (!ok) {
        reject(new Error(errMsg || "Native audio extraction failed"));
        return;
      }
      try {
        const res = await fetch("./__native_audio__.wav?t=" + Date.now());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const wavBuf = await res.arrayBuffer();
        resolve(wavBuf);
      } catch (e) {
        reject(e);
      }
    };
    window.AndroidNative.extractAudio16kAsync();
  });
}

async function decodeBufferToAudio(arrayBuffer) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Trình duyệt không hỗ trợ Web Audio API");
  }

  let audioCtx;
  try {
    audioCtx = new AudioCtx({ sampleRate: 16000 });
  } catch {
    audioCtx = new AudioCtx();
  }

  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {}
  }

  try {
    return await new Promise((resolve, reject) => {
      // Pass buffer directly without .slice(0) to avoid doubling RAM on large mobile videos
      audioCtx.decodeAudioData(
        arrayBuffer,
        (buf) => resolve(buf),
        (err) => reject(err || new Error("decodeAudioData failed"))
      );
    });
  } finally {
    try {
      await audioCtx.close();
    } catch {}
  }
}

export async function extractAudioAndPeaks(file, onProgress) {
  let audioBuffer = null;

  // On Android APK, for large files (> 80MB) or unsupported codecs, native MediaCodec is faster & uses <5MB RAM
  const hasNative = Boolean(window.AndroidNative?.extractAudio16kAsync);
  const preferNativeFirst = hasNative && file.size > 80 * 1024 * 1024;

  if (preferNativeFirst) {
    if (onProgress) onProgress(25, "Đang tách âm thanh bằng phần cứng Android...");
    try {
      const wavBuf = await extractViaAndroidNative();
      if (onProgress) onProgress(60, "Đang nạp luồng âm thanh 16kHz...");
      audioBuffer = await decodeBufferToAudio(wavBuf);
    } catch (nativeErr) {
      console.warn("Native large-file audio extraction failed, trying Web Audio:", nativeErr);
    }
  }

  if (!audioBuffer) {
    if (onProgress) onProgress(15, "Đang đọc dữ liệu video trên thiết bị...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (onProgress) onProgress(45, "Đang giải mã luồng âm thanh...");
      audioBuffer = await decodeBufferToAudio(arrayBuffer);
    } catch (webErr) {
      if (hasNative && !preferNativeFirst) {
        if (onProgress) onProgress(50, "Đang dùng bộ giải mã phần cứng Android cho video này...");
        const wavBuf = await extractViaAndroidNative();
        audioBuffer = await decodeBufferToAudio(wavBuf);
      } else {
        throw new Error(
          "Không thể giải mã track âm thanh của video: " +
            (webErr?.message || "Định dạng âm thanh chưa được hỗ trợ")
        );
      }
    }
  }

  if (onProgress) onProgress(75, "Đang tách sóng âm cho Timeline...");
  let mono;
  if (audioBuffer.numberOfChannels === 1) {
    mono = audioBuffer.getChannelData(0);
  } else {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    mono = new Float32Array(audioBuffer.length);
    for (let i = 0; i < audioBuffer.length; i++) {
      mono[i] = (ch0[i] + ch1[i]) * 0.5;
    }
  }

  let pcm16k = mono;
  if (audioBuffer.sampleRate !== 16000) {
    const targetLen = Math.floor((mono.length * 16000) / audioBuffer.sampleRate);
    pcm16k = new Float32Array(targetLen);
    const ratio = audioBuffer.sampleRate / 16000;
    for (let i = 0; i < targetLen; i++) {
      pcm16k[i] = mono[Math.floor(i * ratio)] || 0;
    }
  }

  const numPeaks = 400;
  const blockSize = Math.max(1, Math.floor(pcm16k.length / numPeaks));
  const peaks = [];
  for (let i = 0; i < numPeaks; i++) {
    let maxVal = 0;
    const start = i * blockSize;
    const end = Math.min(pcm16k.length, start + blockSize);
    for (let j = start; j < end; j += Math.max(1, Math.floor(blockSize / 32))) {
      const v = Math.abs(pcm16k[j]);
      if (v > maxVal) maxVal = v;
    }
    peaks.push(Number(Math.min(1, maxVal * 1.15).toFixed(3)));
  }

  if (onProgress) onProgress(100, "Sẵn sàng!");
  return {
    pcm16k,
    peaks,
    duration: audioBuffer.duration,
  };
}
