// Client-side audio extraction (16kHz mono Float32Array for Whisper + waveform peaks for Timeline)

export async function extractAudioAndPeaks(file, onProgress) {
  if (onProgress) onProgress(15, "Đang đọc dữ liệu video trên thiết bị...");
  const arrayBuffer = await file.arrayBuffer();

  if (onProgress) onProgress(45, "Đang giải mã luồng âm thanh...");
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Trình duyệt không hỗ trợ Web Audio API");
  }

  // Gracefully handle sampleRate constraint on Android / mobile devices
  let audioCtx;
  try {
    audioCtx = new AudioCtx({ sampleRate: 16000 });
  } catch (e) {
    console.warn("AudioContext 16000Hz fallback to system rate:", e);
    audioCtx = new AudioCtx();
  }

  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (e) {}
  }

  let audioBuffer;
  try {
    audioBuffer = await new Promise((resolve, reject) => {
      audioCtx.decodeAudioData(
        arrayBuffer.slice(0),
        (buf) => resolve(buf),
        (err) => reject(err || new Error("decodeAudioData failed"))
      );
    });
  } finally {
    try {
      await audioCtx.close();
    } catch (e) {}
  }

  if (onProgress) onProgress(75, "Đang tách sóng âm cho Timeline...");
  // Mix down to mono Float32Array
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

  // Resample to 16000Hz if browser ignored requested sampleRate
  let pcm16k = mono;
  if (audioBuffer.sampleRate !== 16000) {
    const targetLen = Math.floor((mono.length * 16000) / audioBuffer.sampleRate);
    pcm16k = new Float32Array(targetLen);
    const ratio = audioBuffer.sampleRate / 16000;
    for (let i = 0; i < targetLen; i++) {
      pcm16k[i] = mono[Math.floor(i * ratio)] || 0;
    }
  }

  // Compute ~400 normalized waveform peaks for the Timeline UI
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
