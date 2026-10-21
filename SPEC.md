# Audio Volume Booster and Normalizer — specification

**Tagline:** Make quiet audio louder or normalize it to a target level in your browser, with no upload.

**Category:** Audio & Video

**Free alternative to:** Online MP3 volume booster and louder tools such as Clideo Change Volume and 123apps Volume Changer (upload your audio, ads, watermarks or account walls on longer files)

**Search phrases:** increase volume of mp3, make audio louder, audio volume booster, normalize audio online, volume changer, boost volume of audio file, quiet recording louder

**Allowed libraries:** lamejs

**Published at:** https://turhe123.github.io/audio-volume-booster/

## Acceptance checks (each must have a test)

- Loading quiet-sample.wav shows a peak level and loudness readout in decibels
- Choosing Boost by 6 dB raises the reported output peak by about 6 dB or limits it at 0 dB
- Choosing Normalize to a peak of minus 1 dB makes the output peak close to minus 1 dB
- Download saves an MP3 or WAV with the chosen name suffix
- A non audio file shows an error message
- Works at 390px wide

## Spec

Recordings from phones, meetings, lectures and old tapes are often too quiet. People search for increase volume of mp3, make audio louder and normalize audio online. Typical web tools upload the recording to a server, which is a poor idea for private calls or interviews, show ads, and sometimes limit length or add a watermark or sign-up on larger files. Our version changes loudness of a local file and saves the result. That is the one job.

Feature set: load one audio file. Analyse it and show duration, peak level in dBFS and an average loudness estimate as RMS in dB. Two modes. Boost: a gain slider from minus 20 to plus 30 dB, default plus 6, with a preview of the resulting peak and a clipping warning, plus an optional Prevent clipping checkbox which applies a gentle limiter at minus 0.5 dB. Normalize: choose Peak target (default minus 1 dB) or RMS target (default minus 16 dB) and the tool computes the gain automatically. Export as MP3 (default 192 kbps) or WAV. Preview the before and after with a toggle button.

UI: a drop zone at the top. After loading, a waveform overview, the analysis numbers, the mode tabs with inputs and a before and after play toggle. A Save button creates the file. The result card shows new peak, new RMS, size and a Download link named with the suffix louder. Empty state explains privacy. Errors are inline. Keyboard: space toggles preview, arrow keys change gain by 0.5 dB and shift by 3 dB.

Technical approach: decode with decodeAudioData. Peak is the maximum absolute sample, RMS is the square root of the mean of squares, both converted to decibels with twenty times log base ten. For preview connect an AudioBufferSourceNode through a GainNode, and swap the gain between one and the computed value for the toggle. For export render with the same gain in plain JavaScript over the Float32 arrays, apply the soft limiter using a tanh style curve above a threshold when Prevent clipping is on, hard clamp otherwise, and encode with lamejs in a worker or write WAV by hand. Report the measured peak of the real output after processing, not the prediction. Free buffers after export.

Edge cases: silent files produce minus infinity decibels, so show Silent and disable the controls. Very long files need memory, so warn above about an hour. Heavily clipped sources cannot be repaired, and the note should say so. Mobile Safari requires a tap to start audio, so create the context in the click handler. Mono and stereo are both handled, and the sample rate is preserved. Unicode names are kept.

Demo data: a bundled eight second generated recording called Quiet Voice Memo made from a soft speech-like tone burst pattern at about minus 24 dB peak, so the boost has a clear audible effect.
