# Experiment 4b — Sonos Isolated Instruments (Drum Attribution Validation)

**Date:** 2026-03-28
**Setup:** GarageBand isolated drums → Sonos Play 5 speaker → Shure SM57 mic → engine-test.html
**Sensitivity:** 4 (hi-hat), 30 (snare, kick)
**Cooldown:** 80ms
**Coincidence window:** 8ms (pre-fix — original algorithm)

## Why Sonos Matters

Previous Experiment 4 used laptop speakers. The Sonos Play 5 is a full-range speaker that faithfully reproduces bass frequencies. This changes the frequency profile significantly — every drum strike now has real low-frequency energy, unlike laptop speakers which roll off below ~200Hz.

## Results (Original Algorithm — 8ms window, v1 rules)

### Hi-hat Only (~140 hits, 43.7s recording)

| Drum Type | Count | Avg Bands | Avg Kick% | Avg Snare% | Avg HiHat% |
|---|---|---|---|---|---|
| **Kick** | **78** | 2.6 | 35% | 4% | 9% |
| **Snare** | **11** | 2.0 | 3% | 77% | 5% |
| **Hi-hat** | **99** | 2.7 | 0% | 27% | 65% |

- **Classification accuracy: 99/188 = 53%** (terrible)
- 188 events for ~140 actual hits (34% overcounting)
- 78 events misclassified as kick (speaker bass resonance)

### Snare Only (~30 hits, 40.6s recording)

| Drum Type | Count | Avg Bands | Avg Kick% | Avg Snare% | Avg HiHat% |
|---|---|---|---|---|---|
| **Kick** | **32** | 2.0 | 29% | 1% | 1% |
| **Snare** | **22** | 3.0 | 0% | 36% | 8% |
| **Hi-hat** | **0** | — | — | — | — |

- **Classification accuracy: 22/54 = 41%** (terrible)
- 54 events for ~30 actual hits (80% overcounting)
- 32 events misclassified as kick (low-freq resonance arriving separately)

### Kick Only (~17 hits, 48.9s recording)

| Drum Type | Count | Avg Bands | Avg Kick% | Avg Snare% | Avg HiHat% |
|---|---|---|---|---|---|
| **Kick** | **31** | 1.6 | 58% | 1% | 0% |
| **Snare** | **16** | 2.3 | 0% | 61% | 6% |
| **Hi-hat** | **0** | — | — | — | — |

- **Classification accuracy: 31/47 = 66%** (poor)
- 47 events for ~17 actual hits (176% overcounting)
- 16 events misclassified as snare (beater click in 2-5kHz arriving separately)

## Root Cause Analysis

### 1. Speaker Group Delay Creates Split Events

The Sonos Play 5 has measurable group delay between its tweeter and woofer. When a drum hit is played, the high-frequency transient arrives before the low-frequency component. This time difference exceeds the 8ms coincidence window, causing one physical hit to register as two separate events:

- **Hi-hat**: high-freq event (correctly classified) + low-freq resonance event (classified as kick)
- **Snare**: mid/high-freq event (correctly classified) + low-freq body event (classified as kick)
- **Kick**: low-freq event (correctly classified) + beater click event at 2-5kHz (classified as snare)

### 2. Fixed Threshold Classification Fails on Full-Range Speakers

The original rules used absolute thresholds (`kickRatio > 0.35`, `highRatio > 0.25`) tuned for laptop speakers where bass is absent. Through a full-range speaker, every drum produces significant energy in all bands.

## Fixes Applied

### 1. Configurable Coincidence Window (5-40ms, default 15ms)

Wider window catches more split events from speaker group delay.

### 2. Post-Grouping Merge Step

After initial coincidence grouping, a second pass merges nearby events (within 2× the coincidence window) that are **complementary** — one predominantly low-frequency, the other predominantly high-frequency. This catches speaker group delay without merging genuinely separate drum hits.

### 3. Speaker-Agnostic Classification Rules (v2)

Replaced absolute thresholds with **relative comparisons**:

| Rule | v1 (old) | v2 (new) |
|---|---|---|
| **Kick** | `kickRatio > 0.35 && highRatio < 0.15` | `lowRatio > upperRatio && lowRatio > 0.4` |
| **Hi-hat** | `highRatio > 0.25 && kickRatio < 0.1` | `hihatRatio >= snareRatio && hihatRatio >= kickRatio && upperRatio > lowRatio` |
| **Snare** | `bandsActive >= 3 && snareRatio > 0.15` | `snareRatio >= hihatRatio && (snareRatio + midRatio) > lowRatio` |
| **Fallback** | Dominant band | Dominant band (unchanged) |

The v2 rules compare frequency regions against each other rather than checking fixed thresholds, making them work regardless of the speaker's frequency response.

## Key Insights

1. **The coincidence window needs to be tunable** — 8ms works for laptop speakers, 15-20ms for full-range speakers, potentially more for speakers with ported enclosures
2. **Absolute frequency thresholds are speaker-dependent** — relative comparisons (which region has MORE energy) are speaker-agnostic
3. **Post-grouping merge is essential** for any playback system with group delay (most real speakers)
4. **The Sonos profile is closer to reality** than laptop speakers — if this works on Sonos, it will work on real instruments recorded close-mic'd

## Next Steps

- Re-run these three isolated instrument tests with the new algorithm
- Test with different coincidence window values (10, 15, 20, 25ms)
- Test on Chicken Grease (full mix) through Sonos
- Compare accuracy between laptop speakers and Sonos
