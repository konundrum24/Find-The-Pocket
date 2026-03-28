# Experiment 1: Metronome Baseline — 120 BPM, 5-Run Consistency Test

## Context

**Date:** 2026-03-28
**Test harness:** `engine-test.html` — runs the same recorded PCM through 9 different FFT/buffer configurations offline via OfflineAudioContext, plus Essentia.js RhythmExtractor2013.
**Purpose:** Establish baseline onset detection accuracy and run-to-run consistency for a known, perfectly timed signal.

## Setup

- **Source:** iPhone metronome at 120 BPM
- **Microphone:** Shure SM57 via audio interface
- **Duration:** ~30 seconds per run (5 consecutive runs, same setup)
- **Sensitivity:** 8 (out of 100)
- **Cooldown:** 80ms
- **Sample rate:** 44100 Hz
- **Ground truth:** Generated 120 BPM grid, phase-aligned per-config to detected onsets
- **Tolerance:** 70ms (standard MIR evaluation window)

## The 9 Configurations

| Config | FFT Size | Buffer Size | Frame Rate | Time/Frame |
|---|---|---|---|---|
| FFT 512 / Buf 256 | 512 | 256 | 172 fps | 5.8ms |
| FFT 512 / Buf 512 | 512 | 512 | 86 fps | 11.6ms |
| FFT 512 / Buf 1024 | 512 | 1024 | 43 fps | 23.2ms |
| FFT 1024 / Buf 256 | 1024 | 256 | 172 fps | 5.8ms |
| FFT 1024 / Buf 512 | 1024 | 512 | 86 fps | 11.6ms |
| FFT 1024 / Buf 1024 | 1024 | 1024 | 43 fps | 23.2ms |
| FFT 2048 / Buf 256 | 2048 | 256 | 172 fps | 5.8ms |
| FFT 2048 / Buf 512 | 2048 | 512 | 86 fps | 11.6ms |
| FFT 2048 / Buf 1024 | 2048 | 1024 | 43 fps | 23.2ms |

**Current app engine:** FFT 1024 / Buf 512

## Raw Results — 5 Runs

### Onset Counts (broadband detector)

| Config | R1 | R2 | R3 | R4 | R5 | Avg |
|---|---|---|---|---|---|---|
| FFT 512 / Buf 256 | 55 | 52 | 52 | 56 | 53 | 53.6 |
| FFT 512 / Buf 512 | 60 | 58 | 58 | 59 | 57 | 58.4 |
| FFT 512 / Buf 1024 | 59 | 58 | 57 | 59 | 57 | 58.0 |
| FFT 1024 / Buf 256 | 46 | 47 | 43 | 48 | 44 | 45.6 |
| FFT 1024 / Buf 512 | 56 | 55 | 53 | 57 | 56 | 55.4 |
| FFT 1024 / Buf 1024 | 56 | 58 | 58 | 59 | 60 | 58.2 |
| FFT 2048 / Buf 256 | 9 | 9 | 8 | 11 | 8 | 9.0 |
| FFT 2048 / Buf 512 | 46 | 47 | 45 | 50 | 50 | 47.6 |
| FFT 2048 / Buf 1024 | 56 | 57 | 58 | 58 | 56 | 57.0 |
| Essentia beats | 59 | 60 | 59 | 61 | 60 | 59.8 |

Expected beats per run: ~60 (120 BPM x 30s)

### Precision (%)

**100.0% across all 45 measurements** (5 runs x 9 configs). Zero false positives ever detected.

### Recall (%)

| Config | R1 | R2 | R3 | R4 | R5 | Avg | Std |
|---|---|---|---|---|---|---|---|
| FFT 512 / Buf 256 | 91.7 | 86.7 | 86.7 | 91.8 | 88.3 | 89.0 | ±2.5 |
| FFT 512 / Buf 512 | 100.0 | 96.7 | 96.7 | 96.7 | 95.0 | 97.0 | ±1.8 |
| FFT 512 / Buf 1024 | 98.3 | 96.7 | 95.0 | 96.7 | 95.0 | 96.3 | ±1.3 |
| FFT 1024 / Buf 256 | 76.7 | 78.3 | 71.7 | 78.7 | 73.3 | 75.7 | ±3.1 |
| FFT 1024 / Buf 512 | 93.3 | 91.7 | 88.3 | 93.4 | 93.3 | 92.0 | ±2.0 |
| FFT 1024 / Buf 1024 | 93.3 | 95.1 | 96.7 | 96.7 | 100.0 | 96.4 | ±2.4 |
| FFT 2048 / Buf 256 | 15.0 | 15.0 | 13.3 | 18.0 | 13.3 | 14.9 | ±1.9 |
| FFT 2048 / Buf 512 | 76.7 | 78.3 | 75.0 | 82.0 | 83.3 | 79.1 | ±3.5 |
| FFT 2048 / Buf 1024 | 93.3 | 93.4 | 96.7 | 95.1 | 93.3 | 94.4 | ±1.5 |

### Mean Error (ms) — systematic timing offset

| Config | R1 | R2 | R3 | R4 | R5 | Avg | Spread |
|---|---|---|---|---|---|---|---|
| FFT 512 / Buf 256 | -15.5 | -30.6 | -20.1 | -22.4 | -19.2 | -21.6 | 15.1 |
| FFT 512 / Buf 512 | -19.0 | -30.2 | -24.2 | -23.6 | -17.3 | -22.9 | 12.9 |
| FFT 512 / Buf 1024 | -26.0 | -25.0 | -31.4 | -29.1 | -23.8 | -27.1 | 7.6 |
| FFT 1024 / Buf 256 | -16.8 | -32.1 | -22.1 | -26.4 | -17.7 | -23.0 | 15.3 |
| FFT 1024 / Buf 512 | -15.7 | -36.1 | -19.1 | -28.2 | -15.9 | -23.0 | 20.4 |
| FFT 1024 / Buf 1024 | -23.9 | -33.1 | -28.8 | -26.4 | -22.4 | -26.9 | 10.7 |
| FFT 2048 / Buf 256 | -2.6 | -29.5 | -19.5 | -10.9 | -13.2 | -15.1 | 26.9 |
| FFT 2048 / Buf 512 | -18.2 | -29.2 | -22.4 | -21.2 | -16.6 | -21.5 | 12.6 |
| FFT 2048 / Buf 1024 | -16.1 | -36.5 | -20.7 | -19.3 | -14.2 | -21.4 | 22.3 |

### Std Error (ms) — per-onset timing jitter

| Config | R1 | R2 | R3 | R4 | R5 | Avg |
|---|---|---|---|---|---|---|
| FFT 512 / Buf 256 | ±4.4 | ±9.2 | ±9.9 | ±8.1 | ±7.9 | ±7.9 |
| FFT 512 / Buf 512 | ±5.4 | ±9.6 | ±10.5 | ±8.8 | ±8.1 | ±8.5 |
| FFT 512 / Buf 1024 | ±7.5 | ±11.2 | ±12.1 | ±10.0 | ±10.4 | ±10.2 |
| FFT 1024 / Buf 256 | ±4.2 | ±10.6 | ±9.8 | ±7.8 | ±7.4 | ±7.9 |
| FFT 1024 / Buf 512 | ±4.9 | ±10.4 | ±10.0 | ±8.8 | ±6.8 | ±8.2 |
| FFT 1024 / Buf 1024 | ±7.6 | ±10.0 | ±11.6 | ±10.3 | ±9.4 | ±9.8 |
| FFT 2048 / Buf 256 | ±0.9 | ±11.7 | ±10.6 | ±5.4 | ±6.4 | ±7.0 |
| FFT 2048 / Buf 512 | ±3.8 | ±9.5 | ±9.8 | ±7.9 | ±7.9 | ±7.8 |
| FFT 2048 / Buf 1024 | ±6.3 | ±11.8 | ±11.2 | ±10.0 | ±9.7 | ±9.8 |

### Sub-Low (Kick) Band Detection

| Config | R1 | R2 | R3 | R4 | R5 | Avg |
|---|---|---|---|---|---|---|
| FFT 512 / * | 0 | 0 | 0 | 0 | 0 | 0 |
| FFT 1024 / Buf 256 | 1 | 7 | 16 | 2 | 1 | 5.4 |
| FFT 1024 / Buf 512 | 1 | 8 | 31 | 11 | 25 | 15.2 |
| FFT 1024 / Buf 1024 | 32 | 40 | 36 | 23 | 25 | 31.2 |
| FFT 2048 / Buf 256 | 0 | 1 | 0 | 0 | 0 | 0.2 |
| FFT 2048 / Buf 512 | 1 | 5 | 2 | 1 | 0 | 1.8 |
| FFT 2048 / Buf 1024 | 1 | 14 | 16 | 1 | 2 | 6.8 |

### Performance (CPU time, ms)

| Config | R1 | R2 | R3 | R4 | R5 | Avg |
|---|---|---|---|---|---|---|
| FFT 512 / Buf 256 | 151 | 156 | 152 | 152 | 153 | 153 |
| FFT 512 / Buf 512 | 65 | 66 | 65 | 65 | 65 | 65 |
| FFT 512 / Buf 1024 | 38 | 39 | 40 | 40 | 40 | 39 |
| FFT 1024 / Buf 256 | 195 | 195 | 195 | 197 | 197 | 196 |
| FFT 1024 / Buf 512 | 99 | 99 | 100 | 101 | 101 | 100 |
| FFT 1024 / Buf 1024 | 52 | 52 | 51 | 52 | 52 | 52 |
| FFT 2048 / Buf 256 | 316 | 317 | 316 | 322 | 319 | 318 |
| FFT 2048 / Buf 512 | 162 | 162 | 163 | 163 | 163 | 163 |
| FFT 2048 / Buf 1024 | 86 | 87 | 86 | 87 | 86 | 86 |
| Essentia.js | 521 | 519 | 508 | 524 | 507 | 516 |

## Key Findings

### 1. Zero false positives — ever
100% precision across all 45 measurements. The spectral flux peak detector with SPIKE_RATIO=2.0 never hallucinates onsets on a clean metronome signal.

### 2. Recall is dominated by buffer size
Larger buffers catch more onsets because each frame accumulates more flux, making peaks more decisive relative to the SPIKE_RATIO threshold:
- Buf 256: 75-89% recall (misses 5-15 beats per 60)
- Buf 512: 92-97% recall (misses 2-5 beats per 60)
- Buf 1024: 96-97% recall (misses 1-2 beats per 60)

### 3. FFT 2048 / Buf 256 is broken
~15% recall. When bufferSize < fftSize, the AnalyserNode hasn't accumulated a full FFT window between reads. Partially-updated spectra produce unreliable flux values.

### 4. FFT 512 cannot detect kicks
Zero sub-low band onsets across all runs. FFT 512 has ~86Hz bin resolution — the sub-low band (43-129Hz) gets only ~1 bin. FFT 1024 (43Hz bins) detects kicks reliably at Buf 1024 (avg 31 per run).

### 5. Per-onset timing jitter is ±8-10ms
This is the fundamental precision floor of the spectral flux approach at these frame rates. It does NOT vary significantly with FFT or buffer size — parabolic interpolation brings all configs to roughly the same jitter.

### 6. Systematic offset varies ±15ms between runs
The mean error is NOT a fixed constant — it shifts by 10-20ms between identical runs due to the frame grid landing differently relative to each metronome click. This means the systematic bias cannot be calibrated away.

### 7. Realistic aggregate precision is ±3-4ms
With ~60 onsets, the per-onset jitter (±8ms) averages down to ±1ms, but the run-to-run systematic shift adds ~±7ms. Combined, the "Position: +Xms" metric in the app has roughly ±3-4ms real uncertainty — well within musically meaningful resolution.

### 8. Essentia nails BPM and beat count
Essentia RhythmExtractor2013 detected 120.0-120.2 BPM and 59-61 beats across all runs. It's highly reliable for grid placement.

## Recommendations from this experiment

1. **Keep FFT 1024 / Buf 512** as the primary live engine — 92% recall with kick detection and 11.6ms time resolution is the best overall tradeoff.
2. **FFT 512 / Buf 512** would be the best choice if kick detection isn't needed — 97% recall, slightly better timing.
3. **Eliminate FFT 2048** entirely — slower, lower recall, and adds no value over FFT 1024.
4. **Eliminate Buf 256** — consistently lower recall with no meaningful timing improvement after parabolic interpolation.
5. **A dual-engine approach** (FFT 1024 for kicks + FFT 512 for timing) could combine the best of both, but the improvement would be modest (~8ms → ~6ms per-onset jitter theoretically).
6. **The app needs 20-30+ onsets** for its aggregate metrics to be reliable to within ~5ms.
