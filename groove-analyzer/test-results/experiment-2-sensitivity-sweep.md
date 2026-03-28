# Experiment 2: Sensitivity Sweep + Chicken Grease Real Music Test

## Context

**Date:** 2026-03-28
**Test harness:** `engine-test.html`

## Part A: Sensitivity Sweep on Metronome (120 BPM, SM57, ~30s)

### Setup
- Same metronome setup as Experiment 1
- Cooldown held constant at 80ms
- Sensitivity varied: 4, 8, 16, 30

### Results — FFT 1024 / Buf 512 (our current app engine)

| Sensitivity | Onsets | Recall | Precision | Kicks | Mean Err | Std Err |
|---|---|---|---|---|---|---|
| 4 | 56 | 91.8% | 100% | 27 | -26.5ms | ±14.0ms |
| 8 | 56 | 91.7% | 98.2% | 9 | -46.1ms | ±13.7ms |
| 16 | 58 | 95.1% | 100% | 2 | -17.4ms | ±8.0ms |
| 30 | 55 | 91.7% | 100% | 0 | -27.3ms | ±15.9ms |

### Key findings
1. **Broadband recall is insensitive to the sensitivity parameter on clean signals** — all four values land in 91-95% range
2. **Sensitivity 30 destroys Buf 1024 recall** — FFT 512/Buf 1024 drops from 96.7% (sens 4) to 48.3% (sens 30)
3. **Sensitivity 30 kills kick detection entirely** — 0 kicks across all configs
4. **Sensitivity 4 improves kick detection** without adding false positives on metronome
5. **Don't go above 16** — actively harms larger-buffer configs

## Part B: Chicken Grease — Real Music (~190s, SM57)

### Setup
- Source: D'Angelo "Chicken Grease" played through speakers, SM57 recording
- Duration: ~190 seconds (~3 minutes)
- Tested at sensitivity 4 and 8, cooldown 80ms
- Known musical content: ~91 BPM, snare on 2 & 4 only (~144 snare hits), clean 8th note hi-hat (~578 hi-hat hits)

### Essentia Results
- BPM: 91.1 (correct)
- Beats: 285-289 (correct — quarter notes over 3 min)

### Broadband Onset Counts

| Config | Sens 4 | Sens 8 |
|---|---|---|
| FFT 512 / Buf 256 | 854 | 643 |
| FFT 512 / Buf 512 | 784 | 645 |
| FFT 512 / Buf 1024 | 817 | 675 |
| FFT 1024 / Buf 256 | 643 | 514 |
| FFT 1024 / Buf 512 | 692 | 595 |
| FFT 1024 / Buf 1024 | 776 | 648 |
| FFT 2048 / Buf 256 | 64 | 39 |
| FFT 2048 / Buf 512 | 520 | 468 |
| FFT 2048 / Buf 1024 | 722 | 591 |

### Per-Band Analysis (FFT 1024 / Buf 512)

| Band | Sens 4 | Sens 8 | Expected (musical) | Over-count ratio (sens 8) |
|---|---|---|---|---|
| Sub-Low (Kick) | 799 | 576 | unknown | unknown |
| Low (Bass) | 759 | 577 | unknown | unknown |
| Low-Mid (Snare) | 1034 | 531 | ~144 | **3.7x** |
| Mid (Guitar/Keys) | 465 | 284 | unknown | unknown |
| High (Hi-hat) | 494 | 486 | ~578 | 0.84x (under-count) |

### Critical Finding: Band separation ≠ instrument separation

The "Low-Mid (Snare)" band (258-1034 Hz) detected 531 onsets at sens 8, but only ~144 are actual snare hits. The 3.7x over-count comes from:
- Kick drum "punch" (300-800 Hz energy in every kick hit)
- Bass guitar fundamentals and harmonics
- Lower guitar/keys harmonics

The hi-hat band (4050-16000 Hz) is the cleanest — 486 detected vs ~578 expected = 84% recall, mostly genuine hi-hat hits.

### Frequency Research (from user's Google research)

**Snare drum frequency anatomy:**
- 150-400 Hz: fundamental, body, "thump"
- 2-5 kHz: "crack" or attack (most distinctive/isolatable)
- 5 kHz+: snare wire sizzle

**Hi-hat frequency anatomy:**
- < 200-300 Hz: rumble/mud (typically filtered out)
- 300-500 Hz: body
- 2-4 kHz: "bite," attack, definition
- 6-12 kHz+: clarity, brightness, "sizzle"

### Implication for Band Redesign

Current bands were designed around instrument labels but use frequency ranges that don't isolate instruments well in a mix. A redesign targeting the *attack transients* (which are what onset detection measures) rather than the full instrument range:

- **Snare crack: 2-5 kHz** — the most distinctive snare transient, less shared with other instruments
- **Hi-hat sizzle: 6-16 kHz** — relatively clean, few other instruments have significant energy here
- **Kick thump: 40-150 Hz** — already roughly what we have
- **Bass: 80-300 Hz** — overlaps with kick but captures bass note attacks
- **Mid/harmonic: 300-2000 Hz** — the "mud zone" where everything overlaps, less useful for isolation

This would require redefining BANDS in onset-detector.js and the test harness.
