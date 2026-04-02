# Find The Pocket — Groove Analyzer Architecture (v0.5)

## Project Overview

A browser-based groove analysis tool that captures live audio (microphone input), detects musical onsets in real time, and analyzes where those onsets sit relative to the beat grid — revealing the "pocket" of a performance or recording.

The app answers: **"Where does each frequency band sit in the groove?"** — ahead of the beat, behind it, or right on it — and how consistent that placement is.

**Tech stack:** Pure vanilla JavaScript, no build step, no framework. Single external dependency: Essentia.js (WASM, loaded from CDN).

---

## System Architecture (Hybrid Pipeline)

The system uses a **hybrid approach**: a custom real-time onset detection engine runs during recording, while Essentia.js performs post-recording beat grid analysis. The two are stitched together via careful time-base alignment.

### Why Hybrid?

| Concern | Custom Engine | Essentia.js |
|---------|--------------|-------------|
| Real-time onset detection | Yes (spectral flux) | No (needs full recording) |
| Tempo detection accuracy | Weak (octave errors common) | Strong (dynamic programming) |
| Beat grid adaptiveness | Static/self-centering | Adaptive (tracks tempo drift) |
| Grid neutrality | Anchors on loudest onsets | Independent of onset amplitude |
| Processing speed | ~200ms | ~4-9 seconds (scales with duration) |
| Dependencies | None | WASM (~2MB CDN) |

---

## The Custom Audio Engine (onset-detector.js)

### Signal Chain

```
Microphone → AudioContext.createMediaStreamSource()
    → GainNode (auto-gain, zero-latency)
    → AnalyserNode (FFT, size=1024, no smoothing)
    → ScriptProcessorNode (buffer=512, ~11.6ms frames)
    → audioCtx.destination (required for ScriptProcessor to fire)
```

**Key: Gain is applied BEFORE the FFT analyser.** Higher gain = larger spectrum magnitudes = larger spectral flux values. This is intentional — it brings quiet signals above the noise floor.

### Auto-Gain System

Quiet signals (phone speakers, distant mics) produce flux values below the AnalyserNode's noise floor. The auto-gain system measures peak amplitude over the first ~0.5s (~40 frames), then sets a GainNode multiplier:

- **Target:** 0.25 linear (~-12 dBFS)
- **Max boost:** 32x (30 dB)
- **Min:** 1x (never attenuate)
- Gain ramp: `linearRampToValueAtTime` over 50ms (smooth transition prevents flux spikes)

### Warmup Window

After each `setActive(true)`, onset detection is suppressed for 45 frames (~0.5s). This eliminates two artifacts:

1. **Frame 1 spike:** `prevSpectrum` filled with `-Infinity` after reset → first frame computes massive flux across all bands
2. **Gain step spike:** Auto-gain kicks in at frame ~40 → spectrum magnitudes jump proportionally

During warmup, flux computation and peak envelope tracking still run (so state stabilizes), but no onsets are emitted.

### Spectral Flux Onset Detection

Each frame (~11.6ms at 44.1kHz/512 buffer):

1. Pull FFT magnitude spectrum from AnalyserNode (dB values, 512 bins)
2. Convert dB to linear magnitude: `Math.pow(10, dB / 20)`
3. Compute **spectral flux**: sum of positive magnitude differences vs previous frame
4. Normalize: `flux / (binEnd - binStart)`
5. Track adaptive peak envelope (slow decay: `*= 0.9999`)
6. **Onset trigger** requires ALL of:
   - Flux exceeds `(sensitivity / 100) * peakEnvelope`
   - Flux exceeds previous frame's flux by **spike ratio 2.0x**
   - Cooldown period has elapsed (~80ms for free play)

### Sub-Frame Parabolic Interpolation

**Problem:** Frame-locked timestamps quantize onset times to ~11.6ms steps.

**Solution:** 1-frame lookahead detects flux peaks, then parabolic interpolation across three consecutive flux values:

```
δ = 0.5 × (α − γ) / (α − 2β + γ)
refined_time = peak_frame_time + δ × frame_duration
```

Provides ~1-2ms timing precision.

### Five Frequency Bands (v2 — attack transient focused)

The engine runs independent onset detection for each band with separate flux tracking, peak envelopes, cooldowns, and parabolic interpolation:

| Band | Frequency Range | FFT Bins | sensScale | Purpose |
|------|----------------|----------|-----------|---------|
| kick | 40–150 Hz | 1-4 (3 bins) | 1.4 | Kick drum body |
| bass | 150–400 Hz | 4-9 (5 bins) | 1.2 | Bass resonance (neutral — not diagnostic) |
| mid | 400 Hz–2 kHz | 9-47 (38 bins) | 1.0 | Snare body, guitar, keys |
| snare | 2–5 kHz | 47-116 (69 bins) | 1.0 | Snare crack, attack transients |
| hihat | 6–16 kHz | 140-372 (232 bins) | 0.4 | Hi-hat shimmer |

**Per-band sensitivity scaling (sensScale):** The global sensitivity threshold is multiplied by each band's `sensScale`. Hi-hat energy through speakers is 10-100x quieter than kick, so it needs `0.4x` (lower threshold) to catch closed hi-hats. Kick gets `1.4x` (higher threshold) to reduce ghost triggers from speaker resonance.

Effective threshold at sensitivity=15: kick=21%, bass=18%, mid=15%, snare=15%, hihat=6%.

### MIN_FLUX_FLOOR

Per-band flux below `1e-4` is treated as zero. This eliminates room noise false positives in narrow bands (especially kick with only 3 bins).

### Key Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| FFT size | 1024 | 43Hz bin resolution at 44.1kHz |
| Buffer size | 512 | ~11.6ms frames |
| Spike ratio | 2.0 | Onset must be 2x previous frame |
| Cooldown | ~80ms (free play) | Prevents double-triggers |
| Sensitivity | User-adjustable (1-70, default 8) | Threshold as % of peak envelope |
| Auto-gain window | 40 frames (~0.5s) | Measure period before setting gain |
| Warmup frames | 45 | Suppress onsets until gain + spectrum stabilize |
| Peak decay | 0.9999 per frame | Slow adaptation to level changes |
| MIN_FLUX_FLOOR | 1e-4 | Eliminates room noise |

---

## The Essentia.js Engine

### What It Does

Essentia.js is a WASM port of the C++ Essentia audio analysis library. We use two algorithms:

1. **RhythmExtractor2013** (post-recording): Takes full PCM signal, returns beat tick positions (seconds), global BPM estimate, confidence. Uses method='multifeature', minTempo=40, maxTempo=220.

2. **PercivalBpmEstimator** (live, during recording): Quick BPM estimate for live display. Run every ~12 seconds via Web Worker.

### Critical WASM Memory Handling

```javascript
// MUST deep-copy immediately — WASM heap views are invalidated by subsequent operations
const ticksRaw = essentia.vectorToArray(rhythmResult.ticks);
const ticks = Array.from(ticksRaw).map(Number);

// MUST delete ALL WASM vectors before any further processing
rhythmResult.ticks.delete();
rhythmResult.estimates.delete();
rhythmResult.bpmIntervals.delete();
vectorSignal.delete();
```

### Performance Note

Essentia processing time scales with recording length. At 44.1kHz:
- 1 minute: ~4-5 seconds
- 2 minutes: ~8-9 seconds (with multiple WASM heap resizes)

This runs synchronously on the main thread and blocks the UI. The timing logs in `analyzeFreePlayAdaptive()` show exactly how long each phase takes.

---

## How the Two Engines Integrate

### Time Base Alignment

- **Custom onset detector:** Timestamps use `e.playbackTime` (AudioContext time), stored relative to `sessionStartTime`
- **Essentia:** Beat ticks are relative to PCM sample 0 (in seconds)
- **Alignment offset:** `pcmStartTime - sessionStartTime`

```javascript
const timeOffsetMs = pcmData.pcmStartTime - sessionStartTime;
const timeMs = validTicks[i] * 1000 + timeOffsetMs;
```

### The Full Free Play Pipeline

```
DURING RECORDING:
  Custom engine → real-time onsets (sessionOnsets[])
                → 5-band flux tracking (bandOnsets per band)
                → raw PCM capture (for Essentia)
                → live BPM display (PercivalBpmEstimator, every ~12s)
                → continuous flux envelope (for custom tempo fallback)

AFTER STOP:
  1. Flux autocorrelation → coarse BPM estimate
  2. Essentia RhythmExtractor2013(PCM) → beat ticks + BPM → anchors
  3. Anchors → adaptive grid (16th-note resolution)
  4. sessionOnsets matched to 16th-note grid → classifiedOnsets
     (each onset gets: offset, beatPosition, isDownbeat/isUpbeat/isSubdivision)
  5. Weighted metrics, swing factor, tempo curve
  6. Per-band analysis (pattern detection → resolution selection → offset computation)
  7. Drum attribution (coincidence grouping + frequency profile classification)
  8. Feel line, diagnostics, render results, save session
```

---

## Adaptive Grid Engine (adaptive-grid.js)

### Multi-Resolution Grid Construction

`buildAdaptiveGrid(anchors, subdivisions)` creates grids at different subdivision levels:

| Subdivisions | Grid type | At 91 BPM (659ms beat) |
|-------------|-----------|----------------------|
| 1 | Quarter note | 659ms spacing, ±231ms maxOffset |
| 2 | 8th note | 330ms spacing, ±115ms maxOffset |
| 4 | 16th note | 165ms spacing, ±58ms maxOffset |

Between each pair of anchors, the interval is divided into `subdivisions` equal parts. Each grid point stores: `time, beatPosition, localBeatMs, localBpm, anchorIndex`.

The grid **bends** with the music — if the performer speeds up or slows down, local grid spacing follows.

### Binary Search Matching

`matchToAdaptiveGrid(onsets, grid)` uses binary search (`findNearestGridPoint`) for O(N log M) matching instead of linear scan. Critical for performance when running multiple resolution tests per band.

For each onset:
1. Binary search for nearest grid point
2. Compute offset: `onset.time - gridPoint.time` (positive = behind)
3. Reject if offset exceeds 35% of the local grid unit
4. Tag with beat classification

### Per-Instrument Resolution Selection

`selectBestResolution(onsets, anchors)` tests quarter, 8th, and 16th grids for each band's onsets:

- **Score:** `matchRate - (normalizedSD * 0.5)` where SD is normalized by grid unit size
- Quarter grid has wider maxOffset (catches deep-pocket onsets)
- 16th grid has tighter maxOffset (more precise but drops far-behind onsets)
- The resolution where onsets cluster most tightly with highest match rate wins

**Example at 91 BPM:** A snare 70ms behind beat 2:
- 16th grid: 70ms > 58ms maxOffset → **dropped** (silent data loss)
- Quarter grid: 70ms < 231ms maxOffset → matched as +70ms behind ✓

---

## Pattern Detection (pattern-grid.js)

### The Problem

Resolution selection (quarter/8th/16th) works for instruments with simple rhythmic roles (snare on 2&4, hi-hat on 8ths). But instruments with **complex repeating patterns** — like a syncopated kick that hits multiple subdivision levels — need a pattern-specific grid.

### Algorithm

1. **Normalize to beat positions:** Convert absolute-time onsets to fractional beat positions using local anchor intervals (factors out tempo drift)
2. **Circular histograms:** For each candidate cycle length (1, 2, 4, 8 beats), wrap positions modulo cycle and build amplitude-weighted histogram (bin resolution = 1/16th note)
3. **Smooth + find peaks:** Triangular kernel smoothing, local maxima above noise floor (mean + 0.5σ), parabolic interpolation for sub-bin precision
4. **Score:** `coverage × 0.7 - complexity × 0.2 - meanOffset × 0.1`. Coverage = fraction of onsets explained by peaks. Complexity = peaks/maxSlots (Occam's razor).
5. **Build pattern grid:** Tile winning peak positions across session using local tempo from anchors
6. **Match onsets** to pattern grid with same 35% maxOffset threshold

### Key Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| BIN_RESOLUTION | 1/16 beat | Finest musically meaningful subdivision |
| MATCH_RADIUS | 0.025 beats | 40% of a 16th note for onset-to-peak matching |
| CANDIDATE_CYCLES | [1, 2, 4, 8] beats | Tested cycle lengths |
| MIN_COVERAGE | 0.5 | Pattern must explain 50% of onsets |
| MIN_REPETITIONS | 3 | Cycle must repeat at least 3 times |

### Layered Strategy (app.js per-band analysis)

For each band:
1. **Try pattern detection** → if a repeating pattern explains ≥50% of onsets, use it
2. **Fall back to resolution selection** (quarter/8th/16th) if no clear pattern found
3. Band cards show result: "2-beat pattern (4 positions) · 92% matched" or "8th-note grid · 88% matched"

### Validated Results

- **Chicken Grease hi-hat:** 2-beat pattern, 4 positions detected, 92% matched, ±12ms consistency
- **Funky Drummer:** All bands chose 16th-note grid (correct — dense 16th pattern fills every position)
- **Chicken Grease kick:** No pattern detected (kick pattern varies across song — honest result)

---

## Drum Attribution (v3)

Groups co-incident per-band onsets into single drum events and classifies by frequency profile.

### Algorithm

1. Collect all band onsets, sort by time
2. Group within 15ms coincidence window
3. Post-grouping merge: single-band events within 50ms + complementary profiles within 30ms
4. Classify each event by frequency ratio:
   - Kick: kickRatio > 0.25 and dominant
   - Hi-hat: upperRatio > kickRatio and hihat > snare
   - Snare: remaining (including fallback)

### Hybrid Counting

- **Kick/Snare:** Use attribution counts (reliable)
- **Hi-hat:** Use raw band onset count (attribution undercounts due to simultaneous events being won by louder instruments)

### Accuracy (Chicken Grease benchmark)

| Drum | Expected | v3 Attribution | Error |
|------|----------|---------------|-------|
| Kick | ~350 | 304 | -13% |
| Snare | ~96 | 174 | +81% (snare fallback over-captures) |
| Hi-hat | ~385 | 320 (raw band) | -17% |

---

## Analysis Pipeline (analysis.js)

### Onset Classification

Each matched onset is tagged with:
- `beatPosition` (0=downbeat, 1="e", 2=upbeat/"&", 3="ah")
- `isDownbeat`, `isUpbeat`, `isSubdivision` flags

### Weighted Metrics

Overall pocket metrics are amplitude-weighted — louder notes contribute more:

```
weightedAvg = Σ(offset × amplitude) / Σ(amplitude)
weightedStdDev = √(Σ(amplitude × (offset - weightedAvg)²) / Σ(amplitude))
```

### Swing Factor

Measures upbeat displacement: 50% = straight, 53-56% = light, 57-62% = medium, 63-68% = heavy (triplet), >68% = extreme.

### Rhythmic Density

`density = onsetsDetected / total16thNoteSlots` — >0.7 dense, 0.4-0.7 moderate, <0.4 sparse.

---

## Tempo Detection (flux-tempo.js)

Custom flux autocorrelation (coarse BPM input + fallback if Essentia fails):

1. **Autocorrelate** spectral flux envelope (lag range 30-220 BPM)
2. **Rayleigh prior**: weight toward ~110 BPM (σ=45)
3. **Harmonic enhancement**: reinforce beat-level peaks via subharmonic agreement
4. **Octave resolution**: explicit half/double check

Known limitations: sometimes locks to 2x or 2/3x tempo. This is why Essentia is primary.

---

## App Modes (app.js)

### Free Play Mode (Primary)

**Flow:** Home → FP Setup → Sound Check → Recording → Results

No metronome. User plays along to music from speakers. Sound check calibrates sensitivity. During recording: live BPM display, onset counter, timer. Post-recording: full hybrid pipeline.

### Click Mode

**Flow:** Home → Setup (tempo) → Sound Check → Auto-Calibration → Playing → Results

Metronome at user-specified BPM. Auto-calibration measures round-trip speaker→mic latency (needs ≥4 clicks). Click grid IS the beat reference.

### Pocket Playground

**Flow:** Home → Target Selection → Setup → Sound Check → Auto-Cal → Playing → Results

8 named pocket targets: Driving Rock (-15 to -5ms), On the One (-10 to +2ms), Straight Down the Middle (-5 to +5ms), Motown Pocket (+3 to +10ms), The Pino (+8 to +18ms), Greasy Funk (+10 to +22ms), Boom-Bap (+10 to +20ms), The Questlove (+15 to +28ms).

---

## File Structure

```
groove-analyzer/
├── index.html              # All screens in single file, script loading order
├── css/
│   └── styles.css          # Dark theme, responsive, DM Sans font
├── js/
│   ├── app.js              # Main orchestrator (1673 lines) — mode flows, Essentia,
│   │                       #   per-band analysis, drum attribution, results rendering
│   ├── onset-detector.js   # Custom engine (407 lines) — spectral flux, 5 bands,
│   │                       #   auto-gain, warmup, per-band sensitivity, PCM capture
│   ├── audio.js            # AudioContext, mic access, click sound
│   ├── adaptive-grid.js    # Multi-resolution grid building, binary search matching,
│   │                       #   resolution selection, tempo curve
│   ├── pattern-grid.js     # Pattern detection — circular histograms, peak finding,
│   │                       #   pattern grid tiling, onset matching
│   ├── analysis.js         # Offset computation, classification, weighted metrics,
│   │                       #   swing factor, phase correction
│   ├── flux-tempo.js       # Flux autocorrelation tempo with Rayleigh prior
│   ├── metric-selector.js  # Metric level selection (quarter vs eighth note)
│   ├── tempo-estimator.js  # IOI-based tempo (legacy fallback)
│   ├── grid-estimator.js   # Grid estimation for tempo override
│   ├── grid.js             # Click mode grid — metronome, 16th-note scheduling
│   ├── feedback.js         # Natural language feel line generation
│   ├── pocket-targets.js   # 8 named pocket targets
│   ├── visualizations.js   # Canvas rendering — scatter plots, timelines, tempo curve
│   ├── diagnostics.js      # Grid accuracy diagnostics (phase sweep, circular stats)
│   ├── storage.js          # localStorage CRUD, quota management
│   └── bpm-worker.js       # Web Worker for live Essentia BPM estimation
├── test-results/           # Experiment logs and session summaries
└── assets/
```

### Script Loading Order

```
audio.js → onset-detector.js → grid.js → analysis.js → tempo-estimator.js
→ grid-estimator.js → adaptive-grid.js → pattern-grid.js → flux-tempo.js
→ metric-selector.js → feedback.js → visualizations.js → diagnostics.js
→ storage.js → pocket-targets.js → [Essentia WASM CDN] → [Essentia JS CDN]
→ app.js (last)
```

---

## Visualizations (visualizations.js)

All canvas-based, DPR-aware, responsive.

- **Pocket Landing:** Gaussian-jittered scatter, 3 dot types (downbeats teal, upbeats purple, ghost notes amber), average marker + spread ellipse
- **Per-Band Pocket Landing:** Compact (44-50px), band-colored dots
- **Session Timeline:** Time vs offset with rolling average trend
- **Per-Band Timelines:** Band-specific colors, independent Y-axis ranges
- **Tempo Curve:** BPM vs time with median reference line

### Band Colors

| Band | Color |
|------|-------|
| kick | Coral rgba(251, 113, 133) |
| bass | Light teal rgba(64, 180, 150) |
| mid | Purple rgba(139, 127, 212) |
| snare | Amber rgba(251, 191, 36) |
| hihat | Teal rgba(45, 212, 191) |

---

## Key Validated Findings

### Funky Drummer (Clyde Stubblefield) — Best Validation

| Band | Position | Consistency | Grid |
|------|----------|-------------|------|
| Kick | +20ms | ±20ms | 16th-note, 77% |
| Bass | +19ms | ±13ms | 16th-note, 83% |
| Mid | +19ms | ±12ms | 16th-note, 84% |
| Snare | +21ms | ±11ms | 16th-note, 84% |
| Hi-hat | +20ms | ±11ms | 16th-note, 88% |

All bands unified at +19-21ms behind. 16th-note grid correct (dense funk pattern). Ghost notes (+25ms) further behind than downbeats (+15ms) — characteristic of laid-back funk.

### Chicken Grease (Questlove) — Complex Case

| Band | Position | Consistency | Grid |
|------|----------|-------------|------|
| Kick | -20ms | ±57ms | 8th-note, 90% |
| Snare | +3ms | ±29ms | quarter, 75% |
| Hi-hat | +17ms | ±12ms | 2-beat pattern (4 pos), 92% |

Wide kick consistency reflects Questlove's deliberately varying kick pattern (syncopated 50%, quarter notes 25%, drops 25%). Hi-hat pattern detection correctly found the 8th-note pattern.

### Run-to-Run Variance

Essentia's beat grid can shift ±10-15ms between runs of the same song. Per-band *relative* positions and consistency values are more stable than absolute position.

---

## Dependencies

- **Essentia.js v0.1.3** — WASM audio analysis (CDN): `essentia-wasm.web.js` + `essentia.js-core.js`
- **Google Fonts** — DM Sans, Instrument Serif (CDN)
- No npm, no bundler, no framework. Opens directly in a browser.

---

## Version History

| Version | Commit | Key Changes |
|---------|--------|-------------|
| v0.3 | 129cbdf | Engine test harness, 4 experiments, drum attribution designed |
| v0.4 | ee0cf4c | v2 bands, MIN_FLUX_FLOOR, drum attribution integrated into main app |
| v0.5 | da5d91d | Per-band sensitivity, warmup window, multi-resolution grids, pattern detection, binary search |
