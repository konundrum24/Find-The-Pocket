# Experiment 3: Chicken Grease — Band Separation & HPSS

## Context

**Date:** 2026-03-28
**Source:** D'Angelo "Chicken Grease" played through speakers, SM57 recording
**Duration:** ~190 seconds (~3 minutes)
**BPM:** 91.1 (confirmed by Essentia across all runs)
**Known musical content:** Snare on 2 & 4 only (~144 snare hits), clean 8th note hi-hat (~578 hi-hat hits), active kick pattern

## Part A: Sensitivity Comparison on Real Music

### FFT 1024 / Buf 512 — Sensitivity 4 vs 8

| Band (v2) | Sens 4 | Sens 8 |
|---|---|---|
| Kick (40-150) | 758 | 576 |
| Bass (150-400) | 869 | 577 |
| Mid (400-2k) | 464 | 284 |
| Snare Crack (2-5k) | 560 | 526 |
| Hi-hat (6-16k) | 513 | 486 |
| **Broadband** | **692** | **595** |

- Hi-hat detection is nearly identical between sens 4 and 8
- Lower bands show much more sensitivity to the parameter
- Sensitivity 4 catches 16% more broadband onsets

## Part B: Band Definition Comparison (V1 vs V2)

### V1 (original) vs V2 (attack transient) — FFT 1024 / Buf 512, Sens 4

| Metric | V1 "Snare" (258-1034Hz) | V2 "Snare Crack" (2-5kHz) | Actual snare hits |
|---|---|---|---|
| Onset count | ~997 | ~546 | ~144 |
| Over-count ratio | 6.9x | 3.8x | — |

V2 bands reduced snare over-counting by ~45%, but still 3.8x over due to hi-hat attack bleed in 2-5kHz.

### Key insight: band separation ≠ instrument separation
The "Low-Mid (Snare)" band (258-1034 Hz) detects everything with energy in that range: kick punch, bass guitar, guitar lower harmonics. Moving to 2-5kHz (snare crack) helped but hi-hat attacks also live at 2-4kHz.

## Part C: HPSS (Harmonic-Percussive Source Separation)

### Implementation
- STFT: FFT 1024, hop 512, Hann window
- Horizontal median filter: kernel 17 frames (~200ms) → harmonic signal
- Vertical median filter: kernel 17 bins (~730Hz) → percussive signal
- Soft masking: P / (H + P + epsilon)
- Processing time: ~12.7 seconds for 190s of audio

### HPSS Results — FFT 1024 / Buf 512 equivalent

| Band (v2) | Raw | HPSS Percussive | Change |
|---|---|---|---|
| Kick (40-150) | 749 | 928 | +24% (kick enhanced) |
| Bass (150-400) | 843 | 816 | -3% |
| Mid (400-2k) | 489 | 408 | -17% |
| Snare Crack (2-5k) | 546 | 491 | -10% |
| Hi-hat (6-16k) | 510 | 510 | 0% |
| Broadband | 734 | 659 | -10% |

HPSS reduced snare crack band from 546→491 (10% reduction). Not enough on its own — HPSS separates percussive from harmonic, but can't separate drums from each other.

## Part D: Amplitude Thresholding — The Breakthrough

### Snare Crack (2-5kHz) HPSS Percussive — Amplitude Analysis

| Threshold | Min Amplitude | Onsets Above | % of Total |
|---|---|---|---|
| 10% of max | 7.06e-4 | **157** | 32.0% |
| 15% (interpolated) | ~1.06e-3 | **~140** | ~28.5% |
| 20% of max | 1.41e-3 | 126 | 25.7% |
| 30% of max | 2.12e-3 | 119 | 24.2% |
| 40% of max | 2.82e-3 | 101 | 20.6% |
| 50% of max | 3.53e-3 | 78 | 15.9% |

**10% threshold yields 157 onsets — very close to the expected ~144 snare hits.**

### Key finding
- Snare cracks are ~10x louder than hi-hat bleed in the 2-5kHz range
- The amplitude histogram shows a clear cliff/transition at the ~144 mark
- Top ~30% of 2-5kHz onsets by amplitude = actual snare hits
- Bottom ~70% = hi-hat attack bleed

### Amplitude statistics
- Max: 7.06e-3
- Median: 4.30e-4
- Min: 7.91e-5
- P25 (loud): 1.93e-3
- P75 (quiet): 2.95e-4
- Snare/hi-hat amplitude ratio: ~10x

## Recommended Architecture for Instrument Separation

1. **HPSS** on captured PCM → percussive signal (removes guitar/bass/keys sustained tones)
2. **Onset detection** on percussive signal with v2 bands
3. **Amplitude thresholding** on snare crack band (2-5kHz): top ~10-15% by amplitude = snare
4. **Hi-hat band** (6-16kHz) is already clean (~510 onsets vs ~578 expected = 88% recall)
5. **Kick band** (40-150Hz) on percussive signal — enhanced by HPSS

### Open questions
- Does the 10-15% amplitude threshold generalize to other songs?
- Does the snare/hi-hat amplitude ratio hold for different mixing styles?
- Need to validate on: Funky Drummer (isolated drums), other genres
