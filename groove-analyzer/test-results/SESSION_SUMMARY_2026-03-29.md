# Session Summary — March 29, 2026

## What We Did

### 1. Added Validation UI to Engine Test Harness
- Source instrument selector (kick/snare/hi-hat/unknown)
- Expected count input for accuracy scoring
- Configurable coincidence window slider (5-40ms)
- Per-event detail table with misclassification highlighting
- Copy Results as Markdown button

### 2. Evolved Drum Attribution Through 3 Algorithm Versions

**v1 → v2:** Widened coincidence window (8ms → 15ms), added post-grouping merge for speaker group delay, switched from fixed thresholds to relative frequency comparisons.

**v2 → v3:** Excluded bass band (150-400Hz) from "low" ratio — bass is ambiguous across all instruments through full-range speakers. Added 50ms single-band merge window. Refined classification to compare kick (40-150Hz) directly against snare and hi-hat bands.

### 3. Ran 3 Rounds of Isolated Instrument Tests (Sonos Play 5)

| Test | v1 (8ms) | v2 (15ms) | v3 (15ms, kick-only low) |
|---|---|---|---|
| Kick classification | 66% | 100% | 70% |
| Hi-hat classification | 53% | 65% | 73% |
| Snare classification | 41% | 22% | 68% |

Key finding: bass band (150-400Hz) is a zero-sum tradeoff between kick accuracy and snare/hi-hat accuracy. v3 is the best overall balance.

### 4. Tested Chicken Grease Full Mix (Experiment 5)

| Drum | Expected | Attributed | Accuracy |
|---|---|---|---|
| Kick | ~350 | 364 | +4% |
| Snare | ~95 | 115 | +21% |
| Hi-hat | ~350 | 128 | -63% |

**Hi-hat undercount is architectural** — coincidence grouping merges simultaneous hi-hat + kick/snare into one event, and the louder instrument wins. Raw HPSS hi-hat band count (317) is much more accurate for hi-hat.

### 5. Established Version Control Strategy
- Tagged `v0.3-pre-integration` at commit 129cbdf (before any changes this session)
- All engine-test.html improvements committed
- Ready for main app integration as v0.4

## Key Technical Decisions

1. **v3 classification is the production algorithm** — best overall balance across instruments
2. **Hybrid approach for the app:**
   - Attribution for kick count (±5%) and snare count (±20%)
   - Raw HPSS band count for hi-hat (±10%)
   - Essentia.js for BPM
3. **Bass band (150-400Hz) treated as neutral** — not diagnostic for any specific instrument through speakers
4. **50ms single-band merge window** catches speaker group delay artifacts
5. **Sensitivity 15** works well for Sonos playback (vs 4-8 for direct recording)

## Git Tags

| Tag | Commit | Description |
|---|---|---|
| `v0.3-pre-integration` | 129cbdf | Last session's state: engine test harness, 4 experiments, drum attribution designed |
| `v0.4` | *(after integration)* | Main app with HPSS, v2 bands, MIN_FLUX_FLOOR, drum attribution |

## What's Left To Do

### Immediate
1. **Integrate into main app** — v2 bands, MIN_FLUX_FLOOR, hybrid drum counting
2. **Tag as v0.4** after integration

### Remaining Experiments (lower priority — can do after integration)
3. Experiment 6 — Dynamic range (same song at 3 volumes)
4. Experiment 7 — Fast subdivisions (16th notes at 140+ BPM)
5. Experiment 8 — Ghost notes / soft dynamics
6. Experiment 9 — Live guitar / multi-timbral
7. Experiment 10 — CPU stress test (60+ seconds dense music)

## Key Files

| File | What it does |
|---|---|
| `groove-analyzer/engine-test.html` | Test harness with v3 attribution + validation UI |
| `groove-analyzer/js/onset-detector.js` | Live onset detection (needs integration) |
| `groove-analyzer/js/app.js` | Main app logic (needs integration) |
| `groove-analyzer/test-results/experiment-4b-*.md` | Sonos isolated instrument results (v1/v2/v3) |
| `groove-analyzer/test-results/experiment-5-*.md` | Chicken Grease full mix attribution |
