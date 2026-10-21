// worker.js — renders the gain (with soft limiter or hard clamp), measures the real output and encodes WAV or MP3.
// Classic worker; lamejs is loaded from vendor/ only when MP3 is requested.
/* global lamejs */

const LIMIT_CEILING = 10 ** (-0.5 / 20); // -0.5 dBFS
const LIMIT_KNEE = LIMIT_CEILING * 0.7;   // the curve starts bending about 3 dB below the ceiling

function softLimit(x) {
  const a = Math.abs(x);
  if (a <= LIMIT_KNEE) return x;
  const room = LIMIT_CEILING - LIMIT_KNEE;
  const y = LIMIT_KNEE + room * Math.tanh((a - LIMIT_KNEE) / room);
  return x < 0 ? -y : y;
}

const toInt16 = (x) => (x < 0 ? Math.max(-32768, Math.round(x * 32768)) : Math.min(32767, Math.round(x * 32767)));

self.onmessage = (e) => {
  const { channels, sampleRate, gain, limit, format, kbps } = e.data;
  try {
    const nch = channels.length;
    const frames = channels[0].length;
    const total = frames * nch;
    const pcm = channels.map(() => new Int16Array(frames));
    let peak = 0;
    let sumSq = 0;
    let done = 0;
    let lastReport = 0;
    const report = (p) => { if (p - lastReport >= 0.01 || p >= 1) { lastReport = p; self.postMessage({ type: 'progress', value: p }); } };

    // 1. Render: gain, then soft limiter or hard clamp, then 16-bit quantisation. Measure what is actually written.
    for (let c = 0; c < nch; c++) {
      const src = channels[c];
      const dst = pcm[c];
      for (let i = 0; i < frames; i++) {
        let x = src[i] * gain;
        x = limit ? softLimit(x) : x > 1 ? 1 : x < -1 ? -1 : x;
        const q = toInt16(x);
        dst[i] = q;
        const v = q < 0 ? q / 32768 : q / 32767;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumSq += v * v;
        if ((i & 0xffff) === 0) report(((done + i) / total) * (format === 'mp3' ? 0.25 : 0.7));
      }
      done += frames;
      channels[c] = null; // free the float copy as soon as it is rendered
    }

    // 2. Encode.
    let blob;
    if (format === 'mp3') {
      if (typeof lamejs === 'undefined') importScripts('vendor/lamejs/lame.min.js');
      const enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
      const parts = [];
      const block = 1152 * 8;
      for (let i = 0; i < frames; i += block) {
        const l = pcm[0].subarray(i, i + block);
        const r = nch > 1 ? pcm[1].subarray(i, i + block) : undefined;
        const out = enc.encodeBuffer(l, r);
        if (out.length) parts.push(out);
        report(0.25 + 0.75 * (i / frames));
      }
      const tail = enc.flush();
      if (tail.length) parts.push(tail);
      blob = new Blob(parts, { type: 'audio/mpeg' });
    } else {
      const bytes = 44 + total * 2;
      const buf = new ArrayBuffer(bytes);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, total * 2, true);
      const body = new Int16Array(buf, 44);
      for (let i = 0, o = 0; i < frames; i++) {
        for (let c = 0; c < nch; c++) body[o++] = pcm[c][i];
        if ((i & 0xffff) === 0) report(0.7 + 0.3 * (i / frames));
      }
      blob = new Blob([buf], { type: 'audio/wav' });
    }
    report(1);
    self.postMessage({ type: 'done', blob, peak, rms: Math.sqrt(sumSq / total) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
