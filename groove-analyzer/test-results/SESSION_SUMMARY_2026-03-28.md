# Session Summary — March 28, 2026

## What We Did

### 1. Fixed Core App Issues (beginning of session)
- **Removed phase correction from Free Play mode** — Essentia places beats where they actually are in the audio; shifting the grid was erasing real musical data
- **Fixed Essentia time alignment bug** — `pcmStartTime` now uses the same half-buffer offset as onset timestamps, eliminating ~5.8ms systematic error
- **Added auto-gain** — GainNode in the signal chain measures peak level over first 0.5s and boosts quiet signals up to 32x. Zero latency, no timing impact.

### 2. Built Engine Test Harness (`groove-analyzer/engine-test.html`)
A standalone test page that:
- Records audio via mic, captures raw PCM
- Runs the same PCM through **9 FFT/buffer configurations** (FFT 512/1024/2048 × Buffer 256/512/1024) via OfflineAudioContext
- Runs **Essentia.js** RhythmExtractor2013 for BPM/beat comparison
- Runs **HPSS** (Harmonic-Percussive Source Separation) via median filtering on spectrogram
- Runs **Drum Attribution** (coincidence-based classification) — NEW, not yet validated
- Shows: 3×3 onset grid, multi-lane timeline, waveform, frequency spectrum, per-band tables (v1 + v2), HPSS comparison, amplitude analysis with histogram, ground truth accuracy (precision/recall/F-measure), performance metrics

### 3. Ran 4 Experiments (results in `groove-analyzer/test-results/`)

**Experiment 1 — Metronome Baseline (5 runs)**
- FFT 1024/Buf 512 confirmed: 92% recall, 100% precision, ±8ms jitter
- Per-onset jitter is ±8-10ms (fundamental limit of spectral flux + parabolic interpolation)
- Mean error varies ±15ms between runs (not a calibratable constant)
- Aggregate position precision ~±3-4ms with 60+ onsets

**Experiment 2 — Sensitivity & Cooldown Sweep**
- Sensitivity 4-8 optimal; 16+ kills kick detection and harms Buf 1024 recall
- Cooldown doesn't affect hi-hat recall — SPIKE_RATIO is the bottleneck, not cooldown timing

**Experiment 3 — Real Music (Chicken Grease + Funky Drummer)**
- V1 "snare" band (258-1034Hz) overcounts 7x on Chicken Grease
- V2 "snare crack" band (2-5kHz) overcounts 3.4x (hi-hat bleed)
- HPSS removes guitar/bass/keys but can't separate drums from each other
- **Amplitude thresholding breakthrough**: snare cracks are ~10x louder than hi-hat bleed in 2-5kHz. A 10% threshold isolates backbeat snare hits: 157 detected vs ~144 actual
- On Funky Drummer (isolated drums): snare crack band perfectly matches actual count (349 vs ~350)

**Experiment 4 — Isolated Instruments (GarageBand)**
- Hi-hat triggers ALL frequency bands (broadband impulse from stick impact)
- Snare triggers ALL bands including hi-hat band (wire sizzle above 6kHz)
- **Frequency bands alone cannot separate snare from hi-hat**
- Added MIN_FLUX_FLOOR (1e-4) to eliminate room noise false positives
- Added waveform and frequency spectrum diagnostic displays

### 4. Designed Drum Attribution Algorithm (implemented, not yet validated)
- Groups co-incident per-band onsets (±8ms) into single drum events
- Classifies each event by frequency profile ratios
- Eliminates multi-band double/triple counting
- Needs validation on isolated instruments then full mixes

## What's Left To Do

### Immediate (next session)
1. **Validate drum attribution** on isolated hi-hat, snare, and kick recordings
2. **Test drum attribution on Chicken Grease** to see if it gives accurate kick/snare/hi-hat counts
3. **Run Experiment 5** — isolated kick only (GarageBand)

### Remaining Experiments
4. Experiment 6 — Dynamic range test (same song at 3 volume levels)
5. Experiment 7 — Fast subdivisions (16th notes at 140+ BPM)
6. Experiment 8 — Ghost notes / soft dynamics
7. Experiment 9 — Live guitar / multi-timbral
8. Experiment 10 — CPU stress test (60+ seconds dense music)

### App Integration (after testing complete)
- V2 band definitions (attack transient focused)
- MIN_FLUX_FLOOR in onset-detector.js
- HPSS post-processing pipeline
- Drum attribution for per-band analysis
- Decide: label bands as instruments or frequency ranges?
- Consider ML source separation as future feature

## Key Files

| File | What it does |
|---|---|
| `groove-analyzer/engine-test.html` | Test harness — the main experimentation tool |
| `groove-analyzer/js/onset-detector.js` | Live onset detection engine (the app's real-time detector) |
| `groove-analyzer/js/app.js` | Main app logic (Click Mode, Free Play, analysis) |
| `groove-analyzer/test-results/*.md` | All experiment results with raw data |

## Key Technical Decisions Made

1. **Keep FFT 1024 / Buf 512** as the primary live engine config
2. **V2 bands** are better than V1 but still can't isolate instruments by frequency alone
3. **HPSS + amplitude thresholding + coincidence grouping** is the path to instrument separation (not ML, not yet)
4. **MIN_FLUX_FLOOR = 1e-4** should be added to the live onset detector too
5. **Don't integrate into the main app yet** — finish testing first
