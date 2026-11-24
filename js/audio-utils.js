// Client-side audio extraction (16kHz mono Float32Array for Whisper + waveform peaks for Timeline)

export async function extractAudioAndPeaks(file, onProgress) {
  if (onProgress) onProgress(15, "Đang đọc dữ liệu video trên thiết bị...");
  const arrayBuffer = await file.arrayBuffer();

  if (onProgress) onProgress(45, "Đang giải mã luồng âm thanh...");
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  // Decode at 16kHz directly (Whisper's native sample rate)
  const audioCtx = new AudioCtx({ sampleRate: 16000 });
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close().catch(() => {});
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
    const scale = Math.SQRT2;
    for (let i = 0; i < audioBuffer.length; i++) {
      mono[i] = (ch0[i] + ch1[i]) / scale;
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

  // Compute ~600 normalized waveform peaks for the Timeline UI
  const numPeaks = 600;
  const blockSize = Math.max(1, Math.floor(pcm16k.length / numPeaks));
  const peaks = [];
  for (let i = 0; i < numPeaks; i++) {
    let maxVal = 0;
    const start = i * blockSize;
    const end = Math.min(pcm16k.length, start + blockSize);
    for (let j = start; j < end; j += Math.max(1, Math.floor(blockSize / 64))) {
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
