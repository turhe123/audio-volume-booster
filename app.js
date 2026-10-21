// app.js — Audio Volume Booster and Normalizer. Everything runs on this device; no network access.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import { makeVoiceMemo, encodeWav16 } from './sample-audio.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const editor = $('editor');
const controls = $('controls');
const gainEl = $('gain');
const canvas = $('wave');

const AUDIO_EXT = /\.(mp3|wav|wave|m4a|mp4|aac|ogg|oga|opus|flac|weba|webm|aif|aiff|caf|3gp|amr)$/i;
const LONG_SECONDS = 3600;
const LIMIT_CEILING_DB = -0.5;
const HIST_MIN_DB = -120;  // level histogram: 0.1 dB bins from -120 to 0 dBFS
const HIST_BINS = 1200;
const ENVELOPE_COLS = 1200;

const state = {
  name: '',
  buffer: null,        // decoded AudioBuffer (original, untouched)
  analysis: null,      // { peak, rms, peakDb, rmsDb, hist, total, envelope, clippedSource }
  mode: 'boost',
  ctx: null,           // AudioContext, created on the first user tap (mobile Safari)
  source: null,
  gainNode: null,
  playStart: 0,
  hearingAfter: true,
  busy: false,
  resultUrl: null,
};

/* ---------- small helpers ---------- */
const MINUS = '−';
const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fromDb = (db) => 10 ** (db / 20);
function fmtDb(db, unit = 'dB', signed = false) {
  if (!Number.isFinite(db)) return db < 0 ? `${MINUS}∞ ${unit}` : `+∞ ${unit}`;
  const v = Math.abs(db) < 0.05 ? 0 : db;
  const s = Math.abs(v).toFixed(1);
  return `${v < 0 ? MINUS : signed && v > 0 ? '+' : ''}${s} ${unit}`;
}
function fmtTime(sec) {
  const s = Math.round(sec * 10) / 10;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
// Honest percentages: never round a partial value up to 100% or down to 0%.
function fmtPct(fraction) {
  const p = fraction * 100;
  if (p <= 0) return '0%';
  if (p < 0.1) return 'under 0.1%';
  if (p >= 100) return '100%';
  return `${Math.min(99.9, Math.floor(p * 10) / 10)}%`;
}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function showError(message) {
  const a = el('div', 'alert alert--error', message);
  a.setAttribute('role', 'alert');
  results.prepend(a);
}
function clearErrors() { results.querySelectorAll('.alert--error').forEach((n) => n.remove()); }

/* ---------- loading and decoding ---------- */
const isAudioFile = (f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name);

// Read the original sample rate from the container so decoding does not resample it.
function sniffSampleRate(b) {
  const tag = (o, s) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (tag(0, 'RIFF') && tag(8, 'WAVE')) {
    for (let o = 12; o + 8 <= b.length;) {
      const size = u32(o + 4);
      if (tag(o, 'fmt ')) return u32(o + 12);
      o += 8 + size + (size & 1);
    }
    return null;
  }
  if (tag(0, 'FORM') && (tag(8, 'AIFF') || tag(8, 'AIFC'))) return null;
  if (tag(0, 'fLaC')) return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  if (tag(0, 'OggS')) {
    for (let o = 0; o < Math.min(b.length - 16, 4096); o++) {
      if (tag(o, 'OpusHead')) return 48000;
      if (b[o] === 1 && tag(o + 1, 'vorbis')) return u32(o + 12);
    }
    return null;
  }
  let o = 0;
  if (tag(0, 'ID3')) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  const end = Math.min(b.length - 4, o + 65536);
  for (; o < end; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[o + 1] >> 3) & 3;
    const layer = (b[o + 1] >> 1) & 3;
    const br = b[o + 2] >> 4;
    const sr = (b[o + 2] >> 2) & 3;
    if (layer === 0) { // ADTS AAC
      const aac = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][(b[o + 2] >> 2) & 15];
      if (aac) return aac;
      continue;
    }
    if (ver === 1 || br === 0 || br === 15 || sr === 3) continue;
    const base = [44100, 48000, 32000][sr];
    return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
  }
  return null;
}

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 131072));
  let rate = sniffSampleRate(head);
  if (!rate || rate < 3000 || rate > 768000) rate = 44100;
  const ctx = new OfflineAudioContext(1, 1, rate);
  return ctx.decodeAudioData(bytes);
}

function handleFiles(files) {
  if (state.busy) { toast('Please wait until the current file is saved.'); return; }
  clearErrors();
  const audio = files.filter(isAudioFile);
  const rejected = files.filter((f) => !isAudioFile(f));
  if (rejected.length) {
    const names = rejected.map((f) => `"${f.name}"`).join(', ');
    showError(`${names} ${rejected.length > 1 ? 'are not audio files' : 'is not an audio file'}. Choose an MP3, WAV, M4A, OGG, FLAC or another audio recording.`);
  }
  if (!audio.length) return;
  if (audio.length > 1) toast(`One file at a time: using "${audio[0].name}".`, 3500);
  loadFile(audio[0]);
}

async function loadFile(file) {
  stopPreview();
  const status = el('p', 'vb-status');
  status.append(el('span', 'spinner'), ` Decoding "${file.name}"…`);
  results.querySelectorAll('.vb-status').forEach((n) => n.remove());
  results.append(status);
  try {
    const buffer = await decodeFile(file);
    if (!buffer.length) throw new Error('empty');
    status.textContent = ` Measuring "${file.name}"…`;
    const analysis = await analyse(buffer);
    clearResult();
    state.name = file.name;
    state.buffer = buffer;
    state.analysis = analysis;
    showEditor(file.size);
  } catch (err) {
    console.warn('decode failed', err);
    showError(`"${file.name}" could not be read as audio. The file may be damaged, or this browser cannot decode its format. Try MP3 or WAV.`);
  } finally {
    status.remove();
  }
}

// Peak, RMS, a level histogram (for clipping predictions) and a min/max envelope (for the waveform).
async function analyse(buffer) {
  const nch = buffer.numberOfChannels;
  const n = buffer.length;
  const hist = new Uint32Array(HIST_BINS);
  const envMin = new Float32Array(ENVELOPE_COLS).fill(1);
  const envMax = new Float32Array(ENVELOPE_COLS).fill(-1);
  const binsPerDb = HIST_BINS / -HIST_MIN_DB;
  let peak = 0;
  let sumSq = 0;
  let fullScale = 0;
  let work = 0;
  for (let c = 0; c < nch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const x = d[i];
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
      sumSq += x * x;
      if (a >= 0.999) fullScale++;
      if (a > 0) {
        const bin = Math.floor((20 * Math.log10(a) - HIST_MIN_DB) * binsPerDb);
        if (bin >= 0) hist[Math.min(HIST_BINS - 1, bin)]++;
      }
      const col = Math.floor((i / n) * ENVELOPE_COLS);
      if (x < envMin[col]) envMin[col] = x;
      if (x > envMax[col]) envMax[col] = x;
      if (++work === 4_000_000) { work = 0; await new Promise((r) => setTimeout(r)); }
    }
  }
  const total = n * nch;
  const rms = Math.sqrt(sumSq / total);
  return {
    peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms), hist, total, envMin, envMax,
    clippedSource: fullScale / total > 0.0005 && fullScale >= 20,
  };
}

/* ---------- editor ---------- */
function showEditor(fileSize) {
  const { buffer: b, analysis: a } = state;
  editor.hidden = false;
  $('empty').hidden = true;
  zone.classList.add('dropzone--compact');
  $('dropzone-title').innerHTML = 'Drop another file or <span class="link">choose a different one</span>';
  $('file-name').textContent = state.name;
  $('file-info').textContent = `${b.numberOfChannels === 1 ? 'Mono' : b.numberOfChannels === 2 ? 'Stereo' : `${b.numberOfChannels} channels`} · ${b.sampleRate.toLocaleString('en-US')} Hz · ${formatBytes(fileSize)}`;
  $('stat-duration').textContent = fmtTime(b.duration);
  const silent = a.peak === 0;
  const peakEl = $('stat-peak');
  const rmsEl = $('stat-rms');
  peakEl.textContent = silent ? 'Silent' : fmtDb(a.peakDb, 'dBFS');
  rmsEl.textContent = silent ? 'Silent' : fmtDb(a.rmsDb);
  peakEl.dataset.db = String(a.peakDb);
  rmsEl.dataset.db = String(a.rmsDb);

  const notes = $('notes');
  notes.replaceChildren();
  if (silent) notes.append(el('p', 'alert vb-note', 'This file is completely silent (−∞ dB), so there is nothing to make louder. Choose another recording.'));
  if (a.clippedSource) notes.append(el('p', 'alert vb-note vb-note--warn', 'The original is already clipped: some peaks were cut flat when it was recorded. Making it louder cannot repair that distortion, and it will become more noticeable.'));
  if (b.duration > LONG_SECONDS) notes.append(el('p', 'alert vb-note vb-note--warn', `This recording is ${fmtTime(b.duration)} long. Saving needs a lot of memory; on a phone, close other tabs first or split the file.`));

  controls.disabled = silent;
  const mp3ok = b.numberOfChannels <= 2 && [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(b.sampleRate);
  const fmt = $('format');
  fmt.querySelector('option[value="mp3"]').disabled = !mp3ok;
  if (!mp3ok) fmt.value = 'wav';
  updateFormat();
  update();
  drawWave();
}

function currentGainDb() {
  const a = state.analysis;
  if (!a || a.peak === 0) return 0;
  if (state.mode === 'boost') return Number(gainEl.value);
  if ($('norm-rms').checked) return clampNum($('rms-target'), -40, -3, -16) - a.rmsDb;
  return clampNum($('peak-target'), -30, 0, -1) - a.peakDb;
}
function clampNum(inputEl, min, max, fallback) {
  const v = parseFloat(inputEl.value);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

// Fraction of samples that would exceed 0 dBFS with this gain, from the level histogram.
function clipFraction(gainDb) {
  const a = state.analysis;
  const threshold = -gainDb; // input level (dBFS) that reaches 0 dBFS after gain
  const binsPerDb = HIST_BINS / -HIST_MIN_DB;
  const start = Math.ceil((threshold - HIST_MIN_DB) * binsPerDb);
  if (start >= HIST_BINS) return 0;
  let count = 0;
  for (let i = Math.max(0, start); i < HIST_BINS; i++) count += a.hist[i];
  return count / a.total;
}

function update() {
  const a = state.analysis;
  if (!a) return;
  const g = currentGainDb();
  const limit = $('limit').checked;
  $('gain-out').textContent = fmtDb(Number(gainEl.value), 'dB', true);
  gainEl.setAttribute('aria-valuetext', fmtDb(Number(gainEl.value), 'decibels', true));
  $('norm-gain').textContent = a.peak === 0 ? '–' : fmtDb(g, 'dB', true);

  const predict = $('predict');
  predict.replaceChildren();
  predict.className = 'vb-predict';
  if (a.peak === 0) {
    predict.textContent = 'Controls are disabled because the file is silent.';
  } else {
    const newPeak = a.peakDb + g;
    const clips = newPeak > 0;
    predict.append('Predicted peak: ', el('strong', 'stat', fmtDb(newPeak, 'dBFS')), ' · predicted RMS: ', el('strong', 'stat', fmtDb(a.rmsDb + g)));
    if (clips && limit) {
      predict.classList.add('vb-predict--ok');
      predict.append(el('span', 'vb-predict__msg', `Peaks above ${fmtDb(LIMIT_CEILING_DB, 'dBFS')} will be softly limited (${fmtPct(clipFraction(g))} of samples).`));
    } else if (clips) {
      predict.classList.add('vb-predict--warn');
      predict.append(el('span', 'vb-predict__msg', `Clipping warning: about ${fmtPct(clipFraction(g))} of samples will be cut off at 0 dBFS. Lower the gain or turn on Prevent clipping.`));
    }
  }
  $('save').textContent = g < 0 ? 'Save quieter file' : 'Save louder file';
  if (state.gainNode && state.ctx) state.gainNode.gain.setTargetAtTime(state.hearingAfter ? fromDb(g) : 1, state.ctx.currentTime, 0.015);
  drawWave();
}

function setMode(mode) {
  state.mode = mode;
  for (const m of ['boost', 'normalize']) {
    const tab = $(`tab-${m}`);
    tab.setAttribute('aria-selected', String(m === mode));
    tab.tabIndex = m === mode ? 0 : -1;
    $(`panel-${m}`).hidden = m !== mode;
  }
  update();
}

function updateFormat() {
  const fmt = $('format').value;
  const b = state.buffer;
  $('bitrate-field').hidden = fmt !== 'mp3';
  const hint = $('format-hint');
  hint.textContent = '';
  if (!b) return;
  if (fmt === 'mp3') {
    const want = Number($('bitrate').value);
    const kbps = effectiveKbps(want, b.sampleRate);
    if (kbps !== want) hint.textContent = `At ${b.sampleRate.toLocaleString('en-US')} Hz the MP3 format allows at most ${kbps} kbps, so ${kbps} kbps will be used.`;
  } else if ($('format').querySelector('option[value="mp3"]').disabled) {
    hint.textContent = 'MP3 is not available for this file (it needs 1 or 2 channels and a standard sample rate), so it will be saved as WAV.';
  }
}
const effectiveKbps = (kbps, rate) => (rate >= 32000 ? kbps : rate >= 16000 ? Math.min(kbps, 160) : Math.min(kbps, 64));

/* ---------- waveform ---------- */
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function drawWave() {
  const a = state.analysis;
  if (!a || editor.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g2 = canvas.getContext('2d');
  g2.clearRect(0, 0, w, h);
  const mid = h / 2;
  const scale = (h / 2) * 0.96;
  const gain = a.peak === 0 ? 1 : fromDb(currentGainDb());
  const limit = $('limit').checked;
  const ceiling = limit ? fromDb(LIMIT_CEILING_DB) : 1;
  const colAt = (x) => Math.min(ENVELOPE_COLS - 1, Math.floor((x / w) * ENVELOPE_COLS));
  const range = (x0, x1) => {
    let lo = 1, hi = -1;
    for (let c = colAt(x0); c <= colAt(x1); c++) { lo = Math.min(lo, a.envMin[c]); hi = Math.max(hi, a.envMax[c]); }
    return lo > hi ? [0, 0] : [lo, hi];
  };
  // full-scale guides
  g2.fillStyle = cssVar('--line');
  g2.fillRect(0, Math.round(mid - scale), w, Math.max(1, dpr));
  g2.fillRect(0, Math.round(mid + scale), w, Math.max(1, dpr));
  g2.fillRect(0, Math.round(mid), w, Math.max(1, dpr / 2));
  const after = cssVar('--accent');
  const before = cssVar('--muted');
  const clip = cssVar('--danger');
  for (let x = 0; x < w; x++) {
    const [lo, hi] = range(x, x + 1);
    const top = Math.min(ceiling, hi * gain);
    const bottom = Math.max(-ceiling, lo * gain);
    g2.fillStyle = after;
    g2.globalAlpha = 0.85;
    g2.fillRect(x, mid - top * scale, 1, Math.max(1, (top - bottom) * scale));
    if (!limit && (hi * gain > 1 || lo * gain < -1)) {
      g2.fillStyle = clip;
      g2.globalAlpha = 1;
      g2.fillRect(x, 0, 1, 3 * dpr);
      g2.fillRect(x, h - 3 * dpr, 1, 3 * dpr);
    }
    g2.fillStyle = before;
    g2.globalAlpha = 0.9;
    g2.fillRect(x, mid - hi * scale, 1, Math.max(1, (hi - lo) * scale));
  }
  g2.globalAlpha = 1;
}
new ResizeObserver(() => drawWave()).observe(canvas);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWave);
new MutationObserver(drawWave).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ---------- preview ---------- */
function ensureContext() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
  }
  if (state.ctx.state === 'suspended') state.ctx.resume();
  return state.ctx;
}

function startPreview() {
  if (!state.buffer || state.analysis.peak === 0) return;
  const ctx = ensureContext(); // created inside the tap/keypress handler (required by mobile Safari)
  const src = ctx.createBufferSource();
  src.buffer = state.buffer;
  src.loop = true;
  const gn = ctx.createGain();
  gn.gain.value = state.hearingAfter ? fromDb(currentGainDb()) : 1;
  src.connect(gn).connect(ctx.destination);
  src.start();
  state.source = src;
  state.gainNode = gn;
  state.playStart = ctx.currentTime;
  $('play').setAttribute('aria-pressed', 'true');
  $('play-label').textContent = 'Stop preview';
  $('playhead').hidden = false;
  requestAnimationFrame(tickPlayhead);
}

function stopPreview() {
  if (state.source) {
    try { state.source.stop(); } catch { /* already stopped */ }
    state.source.disconnect();
    state.gainNode.disconnect();
  }
  state.source = null;
  state.gainNode = null;
  $('play').setAttribute('aria-pressed', 'false');
  $('play-label').textContent = 'Play preview';
  $('playhead').hidden = true;
}

function togglePreview() { if (state.source) stopPreview(); else startPreview(); }

function toggleBeforeAfter() {
  state.hearingAfter = !state.hearingAfter;
  $('ab').setAttribute('aria-pressed', String(state.hearingAfter));
  $('ab-label').textContent = state.hearingAfter ? 'After' : 'Before';
  update();
}

function tickPlayhead() {
  if (!state.source) return;
  const d = state.buffer.duration;
  const t = ((state.ctx.currentTime - state.playStart) % d) / d;
  $('playhead').style.left = `${t * 100}%`;
  requestAnimationFrame(tickPlayhead);
}

/* ---------- export ---------- */
let worker = null;
function save() {
  if (!state.buffer || state.busy || state.analysis.peak === 0) return;
  clearErrors();
  const b = state.buffer;
  const fmt = $('format').value;
  const kbps = effectiveKbps(Number($('bitrate').value), b.sampleRate);
  const gainDb = currentGainDb();
  const limit = $('limit').checked;
  const suffix = ($('suffix').value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-') || 'louder');
  const base = state.name.replace(/\.[^.]+$/, '') || 'audio';
  const outName = `${base}-${suffix}.${fmt}`;

  // Copies, so the original stays intact for preview and another save; the worker frees them as it goes.
  const channels = [];
  try {
    for (let c = 0; c < b.numberOfChannels; c++) channels.push(new Float32Array(b.getChannelData(c)));
  } catch {
    showError('Not enough memory to process this file. Close other tabs or try a shorter recording.');
    return;
  }
  state.busy = true;
  const saveBtn = $('save');
  saveBtn.disabled = true;
  const prog = $('progress');
  prog.hidden = false;
  setProgress(0);

  worker = worker || new Worker('worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { setProgress(m.value); return; }
    state.busy = false;
    saveBtn.disabled = false;
    prog.hidden = true;
    if (m.type === 'error') { showError(`Saving failed: ${m.message}`); return; }
    showResult({ blob: m.blob, name: outName, peak: m.peak, rms: m.rms, gainDb, limit, fmt, kbps });
  };
  worker.onerror = (e) => {
    e.preventDefault();
    state.busy = false;
    saveBtn.disabled = false;
    prog.hidden = true;
    worker.terminate();
    worker = null;
    showError('Saving failed: the processing worker stopped, most likely because the file is too large for the available memory.');
  };
  worker.postMessage({ channels, sampleRate: b.sampleRate, gain: fromDb(gainDb), limit, format: fmt, kbps }, channels.map((c) => c.buffer));
}

function setProgress(v) {
  const pct = Math.floor(v * 1000) / 10;
  const p = $('progress');
  p.querySelector('span').style.width = `${pct}%`;
  p.setAttribute('aria-valuenow', String(Math.floor(pct)));
  $('save').textContent = `Saving… ${pct.toFixed(1)}%`;
}

function clearResult() {
  results.querySelectorAll('.vb-result').forEach((n) => n.remove());
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
}

function showResult({ blob, name, peak, rms, gainDb, limit, fmt, kbps }) {
  clearResult();
  update();
  const peakDb = toDb(peak);
  const rmsDb = toDb(rms);
  const card = el('div', 'result vb-result');
  const meta = el('div', 'result__meta');
  meta.append(el('div', 'result__name', name));
  const info = el('div', 'result__info', `${fmt === 'mp3' ? `MP3 ${kbps} kbps` : 'WAV 16-bit'} · ${formatBytes(blob.size)} · gain ${fmtDb(gainDb, 'dB', true)}${limit ? ' · limiter on' : ''}`);
  info.id = 'out-info';
  meta.append(info);
  const stats = el('dl', 'vb-stats vb-stats--result');
  const add = (label, id, text, db) => {
    const d = el('div');
    const dd = el('dd', 'stat', text);
    dd.id = id;
    if (db != null) dd.dataset.db = String(db);
    d.append(el('dt', null, label), dd);
    stats.append(d);
  };
  add('New peak', 'out-peak', fmtDb(peakDb, 'dBFS'), peakDb);
  add('New RMS', 'out-rms', fmtDb(rmsDb), rmsDb);
  add('File size', 'out-size', formatBytes(blob.size));
  meta.append(stats);
  meta.append(el('p', 'field__hint', fmt === 'mp3' ? 'Measured on the processed audio that went into the MP3 encoder.' : 'Measured on the samples written to the file.'));
  const dl = el('button', 'btn btn--primary', `Download ${name}`);
  dl.type = 'button';
  dl.id = 'download';
  dl.addEventListener('click', () => downloadBlob(blob, name));
  card.append(meta, dl);
  results.append(card);
  card.scrollIntoView({ block: 'nearest' });
  toast(`${name} is ready (${formatBytes(blob.size)}).`);
}

/* ---------- wiring ---------- */
wireDropzone(zone, input, handleFiles);
gainEl.addEventListener('input', update);
$('limit').addEventListener('change', update);
$('tab-boost').addEventListener('click', () => setMode('boost'));
$('tab-normalize').addEventListener('click', () => setMode('normalize'));
for (const id of ['tab-boost', 'tab-normalize']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const next = id === 'tab-boost' ? 'normalize' : 'boost';
    setMode(next);
    $(`tab-${next}`).focus();
  });
}
for (const [radio, num] of [['norm-peak', 'peak-target'], ['norm-rms', 'rms-target']]) {
  $(radio).addEventListener('change', update);
  $(num).addEventListener('input', () => { $(radio).checked = true; update(); });
  $(num).addEventListener('focus', () => { if (!$(radio).checked) { $(radio).checked = true; update(); } });
}
$('format').addEventListener('change', updateFormat);
$('bitrate').addEventListener('change', updateFormat);
$('play').addEventListener('click', togglePreview);
$('ab').addEventListener('click', toggleBeforeAfter);
$('save').addEventListener('click', save);

function nudge(delta) {
  if (state.mode === 'boost') {
    gainEl.value = String(Math.min(30, Math.max(-20, Number(gainEl.value) + delta)));
  } else {
    const rms = $('norm-rms').checked;
    const t = $(rms ? 'rms-target' : 'peak-target');
    const v = clampNum(t, rms ? -40 : -30, rms ? -3 : 0, rms ? -16 : -1) + delta;
    t.value = String(Math.round(Math.min(rms ? -3 : 0, Math.max(rms ? -40 : -30, v)) * 10) / 10);
  }
  update();
}

gainEl.addEventListener('keydown', (e) => {
  const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  e.stopPropagation();
  nudge(dir * (e.shiftKey ? 3 : 0.5));
});

document.addEventListener('keydown', (e) => {
  if (!state.buffer || editor.hidden || controls.disabled || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.matches('input, select, textarea, [contenteditable]') || t.isContentEditable);
  const activates = t instanceof HTMLElement && t.matches('button, a, summary, [role="button"]');
  if (e.key === ' ' && !typing && !activates) { e.preventDefault(); togglePreview(); return; }
  if ((e.key === 'b' || e.key === 'B') && !typing) { e.preventDefault(); toggleBeforeAfter(); return; }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing && !t.matches?.('[role="tab"]')) {
    e.preventDefault();
    nudge((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 3 : 0.5));
  }
});

$('try-sample').addEventListener('click', () => {
  const wav = encodeWav16([makeVoiceMemo({ seconds: 8, sampleRate: 22050, peakDb: -24, seed: 7 })], 22050);
  handleFiles([new File([wav], 'Quiet Voice Memo.wav', { type: 'audio/wav' })]);
});

// Called by the factory's screenshot script: load the fictional Quiet Voice Memo and show a finished result.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/quiet-voice-memo.wav');
  const file = new File([await res.blob()], 'Quiet Voice Memo.wav', { type: 'audio/wav' });
  await loadFile(file);
  gainEl.value = '12';
  $('limit').checked = true;
  update();
  save();
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (!state.busy) { clearInterval(iv); resolve(); } }, 50);
  });
};

export { handleFiles, sniffSampleRate };
