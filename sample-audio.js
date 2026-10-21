// sample-audio.js — generates the fictional "Quiet Voice Memo": soft, speech-like tone bursts.
// Shared by the page ("Try a quiet sample") and tests/make-fixtures.mjs. No imports, no network.

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a Float32Array of mono samples whose absolute peak is exactly 10^(peakDb/20).
export function makeVoiceMemo({ seconds = 8, sampleRate = 22050, peakDb = -24, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const formants = [[650, 90], [1100, 120], [2500, 200]]; // rough vowel-like resonances
  let t = 0.25;
  while (t < seconds - 0.3) {
    const words = 2 + Math.floor(rand() * 4);
    for (let w = 0; w < words && t < seconds - 0.3; w++) {
      const len = 0.12 + rand() * 0.22;
      const f0 = 120 + rand() * 80;
      const glide = (rand() - 0.5) * 50;
      const start = Math.round(t * sampleRate);
      const n = Math.round(len * sampleRate);
      const amp = 0.5 + rand() * 0.5;
      const shift = 0.8 + rand() * 0.5;
      let phase = 0;
      for (let i = 0; i < n && start + i < out.length; i++) {
        const p = i / n;
        const env = Math.sin(Math.PI * p) ** 1.5;
        const f = f0 + glide * p;
        phase += (2 * Math.PI * f) / sampleRate;
        let s = 0;
        for (let h = 1; h <= 10; h++) {
          const hf = f * h;
          let g = 0;
          for (const [fc, bw] of formants) g += 1 / (1 + ((hf - fc * shift) / bw) ** 2);
          s += (g / h) * Math.sin(h * phase);
        }
        out[start + i] += amp * env * s;
      }
      t += len + 0.04 + rand() * 0.08;
    }
    t += 0.25 + rand() * 0.45; // pause between phrases
  }
  // A faint room hiss so the "silent" gaps are not digital zero.
  for (let i = 0; i < out.length; i++) out[i] += (rand() - 0.5) * 0.004;
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = 10 ** (peakDb / 20) / peak;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

// 16-bit PCM WAV, interleaving the given channels.
export function encodeWav16(channels, sampleRate) {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = new ArrayBuffer(44 + frames * nch * 2);
  const v = new DataView(bytes);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * nch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, frames * nch * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(bytes);
}
