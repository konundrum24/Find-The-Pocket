# Experiment 4: Isolated Instrument Tests (GarageBand)

## Context

**Date:** 2026-03-28
**Source:** GarageBand drum machine, individual instruments isolated, played through speakers, SM57 recording
**Sensitivity:** 30 (raised to filter low-end noise)
**Cooldown:** 80ms
**BPM:** ~100 (GarageBand tempo)
**MIN_FLUX_FLOOR:** 1e-4 (added during this experiment to filter room noise)

## Ambient Noise Baseline (30s of silence)

### Before flux floor fix
| Band | FFT 1024/Buf 512 |
|---|---|
| Kick (40-150) | 63 |
| Bass (150-400) | 53 |
| Snare Crack (2-5k) | 1 |
| Hi-hat (6-16k) | 1 |
| Broadband | 5 |

### After flux floor fix
| Band | FFT 1024/Buf 512 |
|---|---|
| Kick (40-150) | 3 |
| Bass (150-400) | 2 |
| Snare Crack (2-5k) | 0 |
| Hi-hat (6-16k) | 0 |
| Broadband | 0 |

Room noise is dominated by sub-400Hz energy (HVAC, 60Hz hum, building vibration). The flux floor eliminated virtually all false positives.

## Hi-Hat Only (~80 expected hits, 20 bars, sensitivity 30)

### HPSS Percussive (FFT 1024 / Buf 512)
| Band | Count | Expected |
|---|---|---|
| Kick (40-150) | 9 | 0 |
| Bass (150-400) | 72 | 0 |
| Mid (400-2k) | 68 | — |
| Snare Crack (2-5k) | 75 | 0 |
| Hi-hat (6-16k) | 71 | ~80 |
| Broadband | 73 | ~80 |

**Key finding:** Hi-hat triggers onsets across ALL frequency bands because the initial stick-on-metal impact creates a broadband transient. The hi-hat's spectral energy peaks at 3-6kHz (visible in spectrum), not 6-16kHz as our band assumes. The hi-hat band (6-16kHz) captures the upper "sizzle" portion.

Hi-hat band recall: 71/80 = **89%** — good, but the snare crack band (2-5k) also shows 75 hits from hi-hat bleed.

## Snare Only (~50 expected hits, 25 bars, sensitivity 30)

### HPSS Percussive (FFT 1024 / Buf 512)
| Band | Count | Expected |
|---|---|---|
| Kick (40-150) | 14 | 0 |
| Bass (150-400) | 44 | 0 |
| Mid (400-2k) | 45 | — |
| Snare Crack (2-5k) | 43 | ~50 |
| Hi-hat (6-16k) | 48 | 0 |
| Broadband | 39 | ~50 |

**Key finding:** The snare is the most broadband drum instrument — it triggers onsets in EVERY band including the hi-hat band (48 out of ~50 hits). The snare wire sizzle extends well above 6kHz.

### Frequency spectrum analysis
- Snare energy is relatively flat from 200Hz to 10kHz
- No clean frequency separation point between snare and hi-hat
- The "snare crack" at 2-5kHz is real but the snare also has significant energy above 6kHz (wire sizzle)

## Cross-Instrument Band Fingerprints

| Band | Hi-hat (~80 hits) | Snare (~50 hits) | Ratio HH/Snr |
|---|---|---|---|
| Kick (40-150) | 9 (11%) | 14 (28%) | 0.6 |
| Bass (150-400) | 72 (90%) | 44 (88%) | 1.6 |
| Mid (400-2k) | 68 (85%) | 45 (90%) | 1.5 |
| Snare Crack (2-5k) | 75 (94%) | 43 (86%) | 1.7 |
| Hi-hat (6-16k) | 71 (89%) | 48 (96%) | 1.5 |

Both instruments light up all bands — the ratios between bands are too similar to create a reliable "fingerprint" from band patterns alone.

## Conclusions

1. **Frequency bands cannot separate snare from hi-hat** — both are broadband percussive instruments
2. **The hi-hat band (6-16kHz) is NOT a clean hi-hat detector** — snare wire sizzle triggers it at nearly the same rate as actual hi-hats
3. **The minimum flux floor (1e-4) effectively eliminates room noise** with minimal impact on real onset detection
4. **Amplitude thresholding remains the most promising approach** for separating drums in a mix — snare cracks are ~10x louder than hi-hat bleed in the 2-5kHz range (validated on Chicken Grease)
5. **Coincidence-based source attribution** (detecting simultaneous onsets across multiple bands as one physical event) is the next approach to explore
