// Generates the small, fictional audio fixtures used by smoke.spec.js and window.__demo.
//   node tests/make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeVoiceMemo, encodeWav16 } from '../sample-audio.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));

// 3 s stereo at 22050 Hz, peak about -24 dBFS (right channel slightly softer).
const left = makeVoiceMemo({ seconds: 3, sampleRate: 22050, peakDb: -24, seed: 11 });
const right = left.map((x) => x * 0.8);
writeFileSync(dir + 'quiet-sample.wav', encodeWav16([left, right], 22050));

// The 8 s "Quiet Voice Memo" shown by window.__demo, mono 22050 Hz, peak about -24 dBFS.
writeFileSync(dir + 'quiet-voice-memo.wav', encodeWav16([makeVoiceMemo({ seconds: 8, sampleRate: 22050, peakDb: -24, seed: 7 })], 22050));

// 1 s of digital silence.
writeFileSync(dir + 'silent.wav', encodeWav16([new Float32Array(16000)], 16000));

console.log('fixtures written to', dir);
