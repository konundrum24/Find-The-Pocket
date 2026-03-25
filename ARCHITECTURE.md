# Find The Pocket — Groove Analyzer Architecture

## Project Overview

A browser-based groove analysis tool that captures live audio (microphone input), detects musical onsets in real time, and analyzes where those onsets sit relative to the beat grid — revealing the "pocket" of a performance or recording.

The app answers: **"Where does each instrument sit in the groove?"** — ahead of the beat, behind it, or right on it — and how consistent that placement is.

---

## System Architecture (Hybrid Pipeline)

The system uses a **hybrid approach**: custom real-time onset detection during recording, combined with Essentia.js post-recording beat grid analysis.

### Why Hybrid?

| Concern | Custom Pipeline | Essentia.js |
|---------|----------------|-------------|
| Real-time onset detection | Yes (spectral flux) | No (needs full recording) |
| Tempo detection accuracy | Weak (octave errors) | Strong (dynamic programming) |
| Beat grid adaptiveness | Static/self-centering | Adaptive (tracks tempo drift) |
| Grid neutrality | Anchors on loudest onsets | Independent of onset amplitude |
| Processing speed | ~200ms | ~4-5 seconds |
| Dependencies | None | WASM (~2MB CDN) |

**Decision**: Use custom for what it does well (real-time onset detection), Essentia for what it does well (beat grid). Validated through side-by-side testing on J Dilla, D'Angelo, James Brown, Beatles, and live guitar.

---

## Processing Pipeline

### Phase 1: Recording (Real-Time — Custom Engine)

```
Microphone → AudioContext → ScriptProcessorNode
                              ↓
                    ┌─────────┴──────────┐
                    ↓                    ↓
              AnalyserNode          Raw PCM Capture
              (FFT, 1024)          (Float32Array chunks)
                    ↓
           Spectral Flux Computation
           (dB → linear, positive differences)
                    ↓
          ┌─────────┴──────────┐
          ↓                    ↓
    Full-Spectrum Flux    Per-Band Flux (5 bands)
          ↓                    ↓
    Peak Detection +      Band Peak Detection +
    Parabolic Interp.     Parabolic Interp.
    (sub-frame timing)    (sub-frame timing)
          ↓                    ↓
    sessionOnsets[]       bandState[].allOnsets[]
    (time, amplitude)     (time, amplitude)
```

**Onset Detection — Peak Detection with Sub-Frame Interpolation:**

Instead of timestamping onsets at FFT frame boundaries (~11.6ms steps), the detector uses a 1-frame lookahead to identify flux peaks (local maxima), then applies **parabolic interpolation** across three consecutive flux values to estimate the true peak position between frames:

```
δ = 0.5 × (α − γ) / (α − 2β + γ)
refined_time = peak_frame_time + δ × frame_duration
```

Where α, β, γ are the flux values at frames n-1, n (peak), n+1. This provides sub-frame timing precision (~1-2ms) and eliminates the quantized "column" artifacts in scatter plots that occurred with frame-locked timestamps.

**Frequency Bands (5 bands):**

| Band | Label | Frequency Range | FFT Bins (44.1kHz) |
|------|-------|----------------|-------------------|
| subLow | Sub-Low (Kick) | 43–129 Hz | 1–3 |
| low | Low (Bass) | 129–258 Hz | 3–6 |
| lowMid | Low-Mid (Snare) | 258–1034 Hz | 6–24 |
| mid | Mid (Guitar/Keys) | 1034–4050 Hz | 24–94 |
| high | High (Hi-hat/Cymbal) | 4050–16kHz | 94–372 |

Note: Band labels use frequency-range descriptions, not instrument names. At this FFT resolution (43Hz per bin), sub-low and low bands have only 2-3 bins each — enough to separate frequency regions but not enough for reliable instrument identification. Instrument-level labels (e.g., "Kick Drum" vs "Bass Guitar") are deferred to a future drum-learning feature that will use spectral fingerprints from isolated recordings.

**Key parameters:**
- FFT size: 1024 (43Hz bin resolution at 44.1kHz)
- Buffer size: 512 (~11.6ms frames)
- Spike ratio: 2.0 (onset must be 2x previous frame)
- Cooldown: ~80ms (prevents double-triggers)
- Sensitivity: User-adjustable (5–80, default 30)

### Phase 2: Analysis (Post-Recording)

#### Step 2a: Beat Grid Construction (Essentia.js)

```
Raw PCM (Float32Array) → Resample to 44100Hz if needed
                              ↓
                    essentia.arrayToVector()
                              ↓
                    RhythmExtractor2013(signal, maxTempo=220,
                      method='multifeature', minTempo=40)
                              ↓
                    ┌─────────┴──────────┐
                    ↓                    ↓
              BPM + Confidence     Beat Ticks (seconds)
                                         ↓
                              Deep copy from WASM memory
                              (Array.from → plain JS array)
                                         ↓
                              Clean up WASM vectors immediately
                                         ↓
                              Filter invalid ticks
                              Remove ticks <200ms apart
                                         ↓
                              Convert to ms anchor objects
                              [{time, amplitude, interpolated}]
                                         ↓
                              AdaptiveGrid.buildAdaptiveGrid()
                                         ↓
                              Adaptive beat grid with
                              local tempo segments
```

**Critical WASM note:** `essentia.vectorToArray()` returns a typed array *view* into WASM heap memory. Must immediately deep-copy with `Array.from().map(Number)` and delete WASM vectors before any further Essentia operations, or the data will be corrupted.

**What Essentia's RhythmExtractor2013 does internally:**
- Uses multiple onset detection functions (complex spectral difference, energy bands)
- Dynamic programming to find optimal beat positions
- Produces beat positions that adapt to local tempo (not evenly spaced)
- Tested and validated: IBIs vary across recording, tracks accelerandos and section changes

**Known variance:** Essentia's beat grid can shift ±10-15ms between runs of the same song due to mic capture variability (different start/stop points, ambient noise). This produces run-to-run variance in overall pocket position readings. The per-band *relative* positions are more stable.

#### Step 2b: Onset-to-Grid Matching

```
sessionOnsets[] + Essentia Grid
          ↓
  AdaptiveGrid.matchToAdaptiveGrid()
          ↓
  For each onset:
    - Find nearest grid point (16th-note resolution)
    - Compute offset (ms ahead/behind)
    - Classify: downbeat / upbeat / subdivision
          ↓
  classifiedOnsets[]
  [{time, offset, isDownbeat, isUpbeat, beatPosition, beatNumber, ...}]
          ↓
  Analysis.computeWeightedMetrics()
          ↓
  Weighted metrics:
    - Overall position (amplitude-weighted avg offset, ms)
    - Overall consistency (amplitude-weighted std dev, ms)
    - Downbeat metrics (position, consistency, count)
    - Upbeat metrics (position, consistency, count)
    - Subdivision metrics (position, consistency, count)
    - Rhythmic density (fraction of 16th-note slots used)
```

#### Step 2c: Per-Band Analysis

```
For each frequency band (subLow, low, lowMid, mid, high):
    bandOnsets[] + Essentia Grid
              ↓
    AdaptiveGrid.matchToAdaptiveGrid()
              ↓
    Compute per-band position & consistency
              ↓
    bandAnalysis[]
    [{name, label, position, consistency, count, onsets}]
```

This reveals **where each frequency range sits in the pocket**:
- Sub-Low (kick region): typically the loosest, often behind
- Low (bass region): can be ahead or behind depending on genre
- Low-Mid (snare region): snare placement relative to the beat
- Mid (guitar/keys): harmonic instruments
- High (hi-hat/cymbal): often the tightest, reveals ride-hand groove

#### Step 2d: Swing Factor

```
classifiedOnsets[] (with beatNumber, isDownbeat, isUpbeat)
          ↓
  Analysis.computeSwingFactor()
          ↓
  For each upbeat:
    - Find preceding and following downbeats
    - Compute ratio: (downbeat→upbeat) / (downbeat→next downbeat)
    - 50% = straight, >50% = swung, 67% = triplet
          ↓
  Trimmed mean of ratios (drop top/bottom 10%)
          ↓
  swingPercent + swingLabel
    ≤52%: Straight
    53-56%: Light swing
    57-62%: Medium swing
    63-68%: Heavy swing (triplet feel)
    >68%: Extreme swing
```

#### Step 2e: Tempo Curve

```
Essentia beat ticks → compute inter-beat intervals
          ↓
  IBI → instantaneous BPM at each beat
          ↓
  tempoCurve[]
  [{time, bpm}]
          ↓
  Tempo stability (BPM std dev)
```

#### Step 2f: Feel Line Generation

```
Weighted metrics + BPM + tempo stability
          ↓
  Feedback.generateSubdivisionFeelLine()
          ↓
  Natural language description:
  "91 BPM, 6ms behind the beat. Downbeats: ±18ms. Ghost notes: ±40ms..."
```

### Phase 3: Display

Results rendered in a responsive dashboard layout (2-column on desktop ≥900px, single-column on mobile):

- **Pocket Landing** — Gaussian-jittered scatter plot showing onset distribution around the grid center, with separate colors for downbeats, upbeats, and ghost notes
- **Summary Metrics** — position, consistency, tempo, swing percentage
- **Downbeat / Ghost Note Metrics** — separate position and consistency for each
- **Tempo Curve** — BPM over time (full-width row)
- **Session Timeline** — all-instruments onset offsets over time with rolling average trend line (full-width row)
- **Per-Band Rows** — for each of the 5 frequency bands, side-by-side:
  - **Band Analysis Card** — position, consistency, onset count, and compact pocket landing scatter
  - **Band Timeline** — per-band onset offsets over time with band-colored trend line

---

## App Modes

### Free Play Mode (Primary)
- No metronome, no target tempo
- User plays along to music or records a performance
- Post-recording: full pipeline analysis with Essentia grid
- Shows: pocket position, consistency, band analysis, swing, tempo curve

### Click Mode
- Click track at user-specified BPM
- Grid is the click itself (no Essentia needed)
- Simpler analysis: how tight are you to the click?

### Pocket Playground
- Practice hitting a specific pocket position (e.g., "play 5-10ms behind")
- Uses fixed tempo grid
- Feedback on whether you're hitting the target zone

---

## File Structure

```
groove-analyzer/
├── index.html              # Main app entry point
├── css/
│   └── styles.css          # All styles (responsive desktop/mobile layout)
├── js/
│   ├── app.js              # Main application logic, UI, session management
│   ├── onset-detector.js   # Real-time spectral flux onset detection + 5 bands
│   │                       #   Peak detection with parabolic interpolation
│   ├── audio.js            # AudioContext management, mic access
│   ├── adaptive-grid.js    # Adaptive grid construction + onset matching
│   ├── analysis.js         # Weighted metrics, swing factor, onset classification
│   ├── flux-tempo.js       # Flux autocorrelation tempo (custom, legacy)
│   ├── tempo-estimator.js  # IOI-based tempo estimation (custom, legacy)
│   ├── metric-selector.js  # Beat level selection (quarter/half/whole)
│   ├── grid-estimator.js   # Grid estimation utilities
│   ├── grid.js             # Fixed grid utilities
│   ├── feedback.js         # Natural language feel line generation
│   ├── pocket-targets.js   # Target zone definitions
│   ├── visualizations.js   # Canvas-based visualizations (pocket landing,
│   │                       #   timelines, band timelines, band pocket landings)
│   └── storage.js          # localStorage session CRUD (with quota management)
└── assets/                 # Static assets
```

---

## Key Validated Findings

### Pocket Taxonomy (discovered through testing)

| Style | Artist Example | Signature |
|-------|---------------|-----------|
| Centered scatter | J Dilla | All bands near 0ms, wide consistency (±18ms). Deliberate randomness around the beat center. |
| Directional drag | D'Angelo | High-frequency leads, low-frequency drags. Creates a "leaning back" feel. |
| Tight funk | James Brown | All bands slightly behind, very tight consistency (±8ms). Disciplined pocket. |

### Chicken Grease (Questlove) — Canonical Result

| Band | Position | Consistency |
|------|----------|-------------|
| Kick/Bass | +7ms (behind) | ±27ms |
| Snare | -2ms (slightly ahead) | ±29ms |
| Guitar/Keys | -3ms (slightly ahead) | ±23ms |
| Hi-hat | +9ms (most behind) | ±4ms (tightest) |

Hi-hat is the most behind and tightest — the ride hand keeps a steady, laid-back groove. Kick is behind but loose, giving an elastic feel. Overall: +6ms behind, 91 BPM.

### Essentia vs Custom Pipeline (validated results)

| Track | Custom BPM | Essentia BPM | Actual | Winner |
|-------|-----------|-------------|--------|--------|
| So Far To Go (Dilla) | 91 | 91 | ~91 | Tie (tempo), Essentia (grid) |
| Spanish Joint (D'Angelo) | ~165 | ~161 | ~161 | Essentia |
| Funky Drummer | 131 (wrong) | 99 | ~100 | Essentia |
| Live guitar | 66 (wrong) | 99 | ~99 | Essentia |
| A Day in the Life | 165 | 161 | Variable | Essentia (adaptive) |

### Custom Pipeline Known Limitations
1. **Octave resolution failures** — flux autocorrelation sometimes locks to 2x or 2/3x the true tempo
2. **Grid self-centering bias** — anchors placed on strongest onsets, so downbeats always read 0ms ±0ms
3. Both issues are architectural and not easily patched

### Run-to-Run Variance
Essentia's beat grid can shift ±10-15ms between runs of the same song due to mic capture variability. This means overall pocket position can swing (e.g., +6ms one run, -6ms the next). The per-band *relative* positions and consistency values are more stable than the absolute position.

---

## Dependencies

- **Essentia.js v0.1.3** — WASM audio analysis library (loaded from CDN)
  - `essentia-wasm.web.js` — WASM module
  - `essentia.js-core.js` — JS API wrapper
- No other external dependencies. Pure vanilla JS, no build step, no framework.

---

## Session Data Model

```javascript
{
  id: 'sess_1711152000000',
  timestamp: 1711152000000,
  mode: 'freeplay',
  tempo: 91,                    // Detected BPM
  sensitivity: 8,
  latencyOffset: null,
  pocketPosition: 6,            // Average offset (ms, positive = behind)
  pocketConsistency: 16,        // Std dev (ms)
  tempoStability: 1.2,          // BPM std dev
  detectedBpm: 91,
  onsetCount: 488,
  durationMs: 265000,
  offsets: [-12, 3, -8, ...],   // All onset offsets
  onsets: [{time, offset, isDownbeat, isUpbeat}],
  feelLine: "91 BPM, 6ms behind the beat...",
  tempoCurve: [{time, bpm}],
  downbeatMetrics: {position, consistency, count},
  subdivisionMetrics: {position, consistency, count},
  density: 0.45,
  densityLabel: 'Moderate',
  bandAnalysis: [
    {name: 'subLow', label: 'Sub-Low (Kick)', position: 3, consistency: 30, count: 551},
    {name: 'low', label: 'Low (Bass)', position: 6, consistency: 28, count: 492},
    {name: 'lowMid', label: 'Low-Mid (Snare)', position: -1, consistency: 29, count: 582},
    {name: 'mid', label: 'Mid (Guitar/Keys)', position: -3, consistency: 24, count: 219},
    {name: 'high', label: 'High (Hi-hat/Cymbal)', position: 8, consistency: 11, count: 497}
  ],
  swingPercent: 50,
  swingLabel: 'Straight'
}
```

**Storage notes:** Before persisting to localStorage, `saveSession()` strips per-band `onsets` arrays and slims main onsets (keeps only `time`, `offset`, `isDownbeat`, `isUpbeat`). If localStorage quota is exceeded, oldest sessions are trimmed until the save succeeds. Max 200 sessions stored.

---

## Future: Drum Learning (Phase 3)

An optional advanced setup where the user records each drum in isolation (kick, snare, hi-hat, etc.) to capture spectral fingerprints. These fingerprints would enable true instrument-level classification rather than frequency-band approximations. Deferred until the current frequency-band approach is fully validated.
