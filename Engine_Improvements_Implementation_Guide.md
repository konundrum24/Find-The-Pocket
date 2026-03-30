# Find The Pocket — Engine Improvement Implementation Guide

**Date:** March 29, 2026
**Focus:** Two highest-impact changes to the audio analysis pipeline
**Context:** Condensed from brainstorming session reviewing architecture, experiments 1–5, and known issues

---

## Overview: The Two Changes and Why They're First

**Change 1: Multi-Resolution FFT** solves the low-frequency precision problem at the physics level. Your kick band currently has 3 FFT bins. That's not enough data to do reliable spectral flux onset detection — the ±50-60ms kick consistency you see on well-played tracks isn't musical inconsistency, it's measurement noise. A parallel large-FFT path for low frequencies gives you 12+ bins in the kick range without sacrificing the temporal resolution you need for hi-hat and snare.

**Change 2: Onset-Anchored Grid Phase** solves the run-to-run consistency problem. Right now, Essentia determines both the beat *spacing* (tempo) and the beat *placement* (phase). Its tempo detection is excellent (91.1 BPM on Chicken Grease across every run). Its phase placement is not — it can shift ±10-21ms between runs of the same audio depending on where the recording starts and stops. Your `computePhaseCorrection` already calculates what the optimal phase shift would be. The change is to actually *use* it — with a specific, well-defined algorithm.

### Why these two first

They're independent (can be built in either order), they improve the foundation everything else sits on, and they don't add user-facing complexity. Every metric the app currently reports gets more accurate. No new UI. No new modes. Just better numbers.

---

## Change 1: Multi-Resolution FFT System

### What You Have Now

A single AnalyserNode with FFT size 1024, processing all 5 frequency bands through the same spectral analysis:

```
Mic → GainNode → AnalyserNode (FFT 1024) → ScriptProcessor (Buf 512)
                                           → All 5 bands computed from same spectrum
```

At 44.1kHz and FFT 1024:
- Bin resolution: 43.07 Hz/bin
- Kick band (40–150Hz): bins 1–4 → **3 usable bins**
- Bass band (150–400Hz): bins 4–9 → **5 usable bins**
- Hi-hat band (6–16kHz): bins 140–372 → **232 usable bins**

The hi-hat band has 77x more spectral resolution than the kick band. Spectral flux in the kick band is essentially noise with occasional signal.

### What You're Building

Two parallel AnalyserNodes fed from the same GainNode. The high-resolution path uses FFT 4096 for low frequencies. The standard path keeps FFT 1024 for mid and high frequencies:

```
Mic → GainNode ──┬─ AnalyserNode (FFT 4096) → ScriptProcessor A (Buf 1024)
                │                             → kick band, bass band only
                │
                └─ AnalyserNode (FFT 1024)  → ScriptProcessor B (Buf 512)
                                              → mid, snare crack, hi-hat bands
```

At FFT 4096:
- Bin resolution: 10.77 Hz/bin
- Kick band (40–150Hz): bins 4–14 → **~10 usable bins** (3.3x improvement)
- Bass band (150–400Hz): bins 14–37 → **~23 usable bins** (4.6x improvement)

### Implementation Steps

#### Step 1: Create the Second Audio Path in onset-detector.js

In the `init()` or setup method where the AudioContext and nodes are created, add a second AnalyserNode and ScriptProcessorNode:

```javascript
// Existing high-frequency path (unchanged)
this.analyser = audioCtx.createAnalyser();
this.analyser.fftSize = 1024;
this.analyser.smoothingTimeConstant = 0;
this.processor = audioCtx.createScriptProcessor(512, 1, 1);

// NEW: low-frequency path
this.analyserLF = audioCtx.createAnalyser();
this.analyserLF.fftSize = 4096;
this.analyserLF.smoothingTimeConstant = 0;
this.processorLF = audioCtx.createScriptProcessor(1024, 1, 1);
```

**Why Buf 1024 for the LF path:** Your Experiment 1 showed that buffer size < FFT size causes broken recall (FFT 2048 / Buf 256 = 15% recall). For FFT 4096, the buffer must be ≥ 1024. Buf 1024 gives ~23.2ms frame rate, which is coarser than the HF path's 11.6ms, but parabolic interpolation recovers sub-frame precision.

#### Step 2: Connect Both Paths to the Same GainNode

```javascript
// Both analysers receive the same gained signal
this.gainNode.connect(this.analyser);     // existing
this.gainNode.connect(this.analyserLF);   // new

// Both processors need to connect to destination to fire
this.analyser.connect(this.processor);
this.processor.connect(audioCtx.destination);

this.analyserLF.connect(this.processorLF);
this.processorLF.connect(audioCtx.destination);
```

The GainNode → both AnalyserNodes connection means both FFTs see identical audio with identical gain. No gain calibration divergence.

#### Step 3: Separate Band Processing by Path

Define which bands use which analyser. Modify BANDS or create a band-to-analyser mapping:

```javascript
const BAND_CONFIG = {
  kick:  { analyser: 'LF', fftSize: 4096, binStart: 4,   binEnd: 14  },  // 40-150Hz
  bass:  { analyser: 'LF', fftSize: 4096, binStart: 14,  binEnd: 37  },  // 150-400Hz
  mid:   { analyser: 'HF', fftSize: 1024, binStart: 9,   binEnd: 47  },  // 400Hz-2kHz
  snare: { analyser: 'HF', fftSize: 1024, binStart: 47,  binEnd: 116 },  // 2-5kHz
  hihat: { analyser: 'HF', fftSize: 1024, binStart: 140, binEnd: 372 },  // 6-16kHz
};
```

Bin calculations for FFT 4096 at 44.1kHz (bin width = 10.77Hz):
- 40Hz = bin 3.7 → use bin 4
- 150Hz = bin 13.9 → use bin 14
- 400Hz = bin 37.1 → use bin 37

#### Step 4: Run Two Independent Processing Loops

The existing `onaudioprocess` callback on `this.processor` handles the HF path (mid, snare, hi-hat bands). Add a parallel callback on `this.processorLF` for the LF path (kick, bass bands):

```javascript
// HF path → existing logic, but only for mid/snare/hihat
this.processor.onaudioprocess = (e) => {
  if (!this.active) return;
  this.frameCount++;

  const spectrum = new Float32Array(512); // FFT 1024 → 512 magnitude bins
  this.analyser.getFloatFrequencyData(spectrum);

  // Process ONLY mid, snare, hihat bands
  for (const bandName of ['mid', 'snare', 'hihat']) {
    this.processBand(bandName, spectrum, e.playbackTime, BAND_CONFIG[bandName]);
  }
};

// LF path → same onset detection logic, different spectrum source
this.processorLF.onaudioprocess = (e) => {
  if (!this.active) return;
  this.frameCountLF++;

  const spectrumLF = new Float32Array(2048); // FFT 4096 → 2048 magnitude bins
  this.analyserLF.getFloatFrequencyData(spectrumLF);

  // Process ONLY kick, bass bands
  for (const bandName of ['kick', 'bass']) {
    this.processBand(bandName, spectrumLF, e.playbackTime, BAND_CONFIG[bandName]);
  }
};
```

**Critical:** Both callbacks use `e.playbackTime` from the AudioContext, which is the same time base regardless of which ScriptProcessor fires. Onsets from both paths are directly comparable in time — no additional alignment needed.

#### Step 5: Independent State Per Path

Each band already has independent flux tracking, peak envelopes, cooldowns, and parabolic interpolation state. That's the right design — it means the LF bands naturally maintain their own state at their own frame rate.

The only shared state that needs attention:

- **Warmup window:** The LF path has ~23.2ms frames vs. 11.6ms for HF. The LF path needs fewer frames for the same wall-clock warmup time. If your warmup is 45 frames × 11.6ms ≈ 522ms, the LF path needs ~22 frames × 23.2ms ≈ 510ms. Scale the warmup frame count by the frame duration ratio.

- **Auto-gain:** The gain measurement happens on the GainNode before the split, so both paths see the same gain. No change needed. But the gain ramp timing should be tied to the HF path's frame count (since that's where the amplitude measurement happens), and the LF path just benefits passively.

- **Onset collection:** `bandOnsets` arrays for kick and bass now receive onsets at ~23.2ms frame rate instead of ~11.6ms. The onsets are sparser in time but more spectrally precise. Downstream matching (grid alignment, pattern detection) is unaffected — it operates on onset timestamps regardless of their source frame rate.

#### Step 6: Parabolic Interpolation Adjustment

The interpolation formula is the same, but `frame_duration` differs between paths:

```javascript
// In the LF path
const frameDurationLF = this.bufferSizeLF / this.sampleRate; // 1024/44100 = 0.02322s
refined_time = peak_frame_time + delta * frameDurationLF;

// In the HF path (existing)
const frameDurationHF = this.bufferSize / this.sampleRate; // 512/44100 = 0.01161s
refined_time = peak_frame_time + delta * frameDurationHF;
```

The LF path's interpolation covers a wider time window per step (23.2ms vs 11.6ms), so each interpolated onset has slightly less temporal precision. Expected: ~3-5ms per-onset jitter for LF bands vs. ~1-2ms for HF bands. For kick drum analysis this is a massive improvement over the current ±50-60ms.

#### Step 7: Verify with Experiment 1 Methodology

Re-run the metronome baseline test with the dual-path system. Key metrics to compare:

| Metric | Current (FFT 1024 only) | Target (dual FFT) |
|---|---|---|
| Kick band onset count | Variable (5-31 per run) | Stable, closer to actual beat count |
| Kick timing jitter | ±50-60ms on real music | ±10-20ms |
| Hi-hat timing jitter | ±11ms | ±11ms (unchanged) |
| Broadband recall | 92% | 92% (unchanged) |
| CPU time | ~100ms for 30s | ~200-250ms for 30s |

If kick timing jitter drops below ±20ms, the change is validated. If CPU time stays under 300ms for 30s of audio, performance is acceptable.

### What This Doesn't Solve

Multi-resolution FFT improves the *precision* of low-frequency onset timing and the *reliability* of kick vs. bass spectral flux differentiation. It does NOT solve:
- Instrument classification (kick vs. bass guitar) — still requires additional approaches
- Grid phase consistency — that's Change 2
- Hi-hat recall on fast subdivisions — that's a spike ratio / cooldown issue at the HF path level

### Risks and Fallback

**Risk:** Two ScriptProcessorNodes on the same AudioContext might cause timing jitter on lower-powered mobile devices. ScriptProcessorNode is deprecated in favor of AudioWorkletNode, but AudioWorklet isn't available in all browsers yet.

**Mitigation:** If you observe timing issues, the LF path could run as a post-processing step on the captured PCM (like Essentia does) instead of in real time. You'd lose real-time LF onset display but keep the improved accuracy. Since the kick/bass onsets aren't displayed during recording anyway (the screen is minimal), this tradeoff is free from a UX perspective.

**Fallback:** If dual ScriptProcessors prove problematic, an alternative is to run a single ScriptProcessor at Buf 1024 with FFT 4096, and compute HF bands from the same 4096-point spectrum (just using the upper bins). The HF bands lose some temporal resolution (23.2ms frames vs. 11.6ms), but parabolic interpolation may recover enough. Test this as a simpler alternative if the dual-path approach has issues.

---

## Change 2: Onset-Anchored Grid Phase Alignment

### What You Have Now

Your current pipeline does this:

```
1. Essentia → beat ticks (absolute positions in seconds)
2. Beat ticks become "anchors" directly
3. Anchors → adaptive grid (subdivisions between each pair)
4. Onsets matched to grid → offsets computed
```

Essentia's beat ticks define both the **tempo** (spacing between ticks) and the **phase** (absolute position of each tick). Your `computePhaseCorrection` calculates what shift would minimize onset-to-grid offsets, but you don't apply it — you treat Essentia's ticks as ground truth.

### The Problem, Precisely

You already know Essentia's phase can shift ±10-21ms between runs. Here's *why* that matters more than it might seem:

Essentia's RhythmExtractor2013 optimizes a global objective: "find the beat grid that best explains the periodicity of this audio." It doesn't know or care about musical phase — whether beat 1 of the grid aligns with beat 1 of the song. It finds periodicity, not musical structure.

When you start recording 2 seconds earlier or later, Essentia sees different audio at the edges of the recording. Its global optimization converges to a slightly different solution. The *spacing* between beats barely changes (tempo is robust), but the *absolute position* of every beat can shift by 10-20ms. Since your pocket measurements are offsets from these absolute positions, a 15ms phase shift means the difference between reporting "+5ms behind" and "+20ms behind" for the exact same performance.

### What You're Building

Decouple Essentia's two outputs: use its **inter-beat intervals** (tempo tracking) but replace its **phase** with a phase derived from your own detected onsets.

```
1. Essentia → beat ticks
2. Extract inter-beat intervals from ticks (spacing, NOT absolute positions)
3. Find optimal phase using amplitude-weighted onset alignment
4. Reconstruct anchors from intervals + optimal phase
5. Anchors → adaptive grid (unchanged from here)
6. Onsets matched to grid → offsets computed
```

### Why This Isn't What You Already Have

Your current hybrid approach uses Essentia for the grid and your custom engine for the onsets. That's hybrid in terms of *data sources*, but the grid itself is 100% Essentia-determined. The phase correction algorithm computes a diagnostic but doesn't apply it.

The proposed change makes the grid a true hybrid: Essentia's tempo + your onsets' phase. The key difference is philosophical: **Essentia tells you how fast the music goes; your onsets tell you where the beats are.**

Think of it like this. If you asked a musician to find beat 1 of a song, they wouldn't run a mathematical optimization over the whole recording. They'd listen for the loudest, most emphatic hit and call that the downbeat. That's what onset-anchored phase does — it uses the musical content to establish phase, not a signal-processing algorithm's global minimum.

### Implementation Steps

#### Step 1: Extract Inter-Beat Intervals from Essentia's Ticks

After Essentia returns its beat ticks, compute the intervals between consecutive ticks instead of using the ticks directly as anchors:

```javascript
function extractIntervals(essentiaTicks) {
  // essentiaTicks: array of beat positions in seconds
  // Returns: { intervals: number[], firstTick: number }

  const intervals = [];
  for (let i = 1; i < essentiaTicks.length; i++) {
    intervals.push(essentiaTicks[i] - essentiaTicks[i - 1]);
  }

  return {
    intervals,                    // beat-to-beat durations in seconds
    firstTick: essentiaTicks[0],  // Essentia's original phase (used as starting guess)
  };
}
```

These intervals encode Essentia's tempo tracking — including any tempo drift, push into a chorus, etc. That's the part of Essentia that works well. We preserve it completely.

#### Step 2: Build a Phase-Adjustable Grid Constructor

Create a function that reconstructs beat ticks from intervals + a phase offset:

```javascript
function reconstructTicks(intervals, phaseOffset) {
  // phaseOffset: time of the first beat (seconds)
  // intervals: array of beat-to-beat durations
  // Returns: array of beat positions (same format as Essentia ticks)

  const ticks = [phaseOffset];
  for (let i = 0; i < intervals.length; i++) {
    ticks.push(ticks[i] + intervals[i]);
  }
  return ticks;
}
```

If `phaseOffset = firstTick` (Essentia's original), you get back exactly Essentia's grid. The shift is relative to this starting point.

#### Step 3: Implement the Phase Optimization

Search for the phase offset that minimizes the weighted sum of squared offsets between onsets and grid points. The search space is one beat period (the first interval).

```javascript
function findOptimalPhase(intervals, onsets, essentiaTicks) {
  const firstInterval = intervals[0]; // one beat period in seconds
  const searchStepMs = 1;             // 1ms resolution
  const searchSteps = Math.round(firstInterval * 1000 / searchStepMs);

  // Starting point: Essentia's original phase
  const basePhase = essentiaTicks[0];

  let bestPhase = basePhase;
  let bestScore = Infinity;

  for (let step = 0; step < searchSteps; step++) {
    const candidatePhase = basePhase - (firstInterval / 2) + (step * searchStepMs / 1000);
    // Search ±half a beat period around Essentia's guess

    const candidateTicks = reconstructTicks(intervals, candidatePhase);
    const score = computePhaseScore(candidateTicks, onsets);

    if (score < bestScore) {
      bestScore = score;
      bestPhase = candidatePhase;
    }
  }

  return bestPhase;
}
```

**Search range:** ±half a beat period around Essentia's original phase. At 90 BPM, one beat = 667ms, so the search covers ±333ms in 1ms steps = ~667 evaluations. Each evaluation is a grid match operation (binary search, already fast). Total: trivial computation time.

**Why not just use `computePhaseCorrection` directly?** Your existing phase correction computes a single median-offset shift. That's a reasonable approximation but it's sensitive to outliers and doesn't account for amplitude weighting. The search approach tests every candidate and picks the true minimum.

#### Step 4: The Scoring Function

This is the heart of it. The score should favor phase alignments where the loudest onsets land closest to grid points:

```javascript
function computePhaseScore(candidateTicks, onsets) {
  // Build a temporary grid from candidate ticks (quarter-note level is sufficient)
  // We only need to test phase, not subdivisions

  let weightedSumSq = 0;
  let totalWeight = 0;

  for (const onset of onsets) {
    // Find nearest candidate tick
    const nearestTick = findNearestTick(candidateTicks, onset.time);
    const offsetMs = (onset.time - nearestTick) * 1000;

    // Only consider onsets within a reasonable window (±40% of beat period)
    const beatPeriodMs = (candidateTicks[1] - candidateTicks[0]) * 1000;
    if (Math.abs(offsetMs) > beatPeriodMs * 0.4) continue;

    // Weight by amplitude — louder hits contribute more to phase determination
    const weight = onset.amplitude;
    weightedSumSq += weight * offsetMs * offsetMs;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSumSq / totalWeight : Infinity;
}

function findNearestTick(ticks, timeSeconds) {
  // Binary search for nearest tick — same approach as your existing
  // findNearestGridPoint but operating on the tick array
  let lo = 0, hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] < timeSeconds) lo = mid + 1;
    else hi = mid;
  }
  // Check both lo and lo-1 for nearest
  if (lo > 0 && Math.abs(ticks[lo - 1] - timeSeconds) < Math.abs(ticks[lo] - timeSeconds)) {
    return ticks[lo - 1];
  }
  return ticks[lo];
}
```

**Why amplitude-weighted:** In most grooves, the loudest hits are the backbeat (snare on 2 and 4) and the kick on 1. These are the hits that define where the beat IS in the musical sense. Ghost notes, hi-hat 16ths, and incidental percussion are rhythmically important but don't define phase. Weighting by amplitude naturally prioritizes the structurally important hits.

**Why squared offsets:** Minimizing the sum of squared offsets (rather than absolute offsets) penalizes large deviations more heavily. A phase where all loud onsets are 5ms off scores better than one where most are 0ms off but a few are 20ms off. This matches musical reality — a few badly-aligned accents are more disruptive than everything being slightly shifted.

#### Step 5: Integrate Into the Pipeline

Replace the direct use of Essentia ticks as anchors with the phase-corrected ticks. The change is localized to the analysis entry point — everything downstream (adaptive grid, matching, metrics) stays the same.

In `app.js`, in the `analyzeFreePlayAdaptive()` function (or wherever Essentia results are processed into anchors):

```javascript
// CURRENT CODE (conceptual):
// const anchors = essentiaTicks.map(t => ({ time: t * 1000 + timeOffsetMs, ... }));

// NEW CODE:
const { intervals, firstTick } = extractIntervals(essentiaTicks);
const optimalPhase = findOptimalPhase(intervals, sessionOnsets, essentiaTicks);
const phaseCorrectedTicks = reconstructTicks(intervals, optimalPhase);

// Log the correction for diagnostics
const phaseShiftMs = (optimalPhase - firstTick) * 1000;
console.log(`Phase correction: ${phaseShiftMs.toFixed(1)}ms from Essentia's original`);

// Build anchors from corrected ticks (same conversion as before)
const anchors = phaseCorrectedTicks.map(t => ({
  time: t * 1000 + timeOffsetMs,
  // ... other anchor properties
}));
```

Everything downstream — `buildAdaptiveGrid`, `matchToAdaptiveGrid`, per-band analysis, pattern detection — operates on anchors the same way. They don't know or care that the anchors were phase-corrected.

#### Step 6: Validation — The Consistency Test

The most important validation for this change: **run the same recording multiple times and compare results.**

Test protocol:
1. Record Chicken Grease (or any reference track) 5 times
2. Vary the start time by 2-5 seconds each run (press record at different points in the intro)
3. Measure overall pocket position for each run
4. Compare variance with and without phase correction

| Metric | Without Phase Correction | With Phase Correction |
|---|---|---|
| Mean pocket position across 5 runs | Should be ~similar | Should be ~similar |
| Standard deviation across 5 runs | Currently ±10-15ms | Target: ±3-5ms |
| Max spread across 5 runs | Currently 20-30ms | Target: <10ms |

If the standard deviation drops by 2-3x, the change is validated. The absolute pocket position may shift slightly (because Essentia's arbitrary phase is replaced by a musically-grounded phase), but that's the correct behavior — the new phase is more musically meaningful.

#### Step 7: Diagnostic Output

Keep a diagnostic display (maybe in the existing diagnostics panel) showing:
- Essentia's original phase (first tick position)
- Onset-anchored optimal phase
- The shift in milliseconds
- The score improvement (old score vs. new score)

This helps you verify the algorithm is working correctly and gives you data on how much Essentia's phase typically diverges from the onset-anchored phase.

### Edge Cases and Guardrails

**Edge case 1: Recording starts in the middle of a bar.** If the recording starts on beat 3, the loudest onsets might be on beats 4 and 1 (kick) and beat 2 (snare). The phase optimization naturally handles this because it's searching over a full beat period — it'll find the alignment where these accent patterns match the beat grid, regardless of which beat the recording starts on.

**Edge case 2: Very quiet or sparse recording.** If the musician plays very few notes (under 10-15 onsets), the phase optimization has little data. Guardrail: if fewer than 10 onsets are detected, fall back to Essentia's original phase. You can also check whether the optimization actually improved the score meaningfully (>15% reduction in weighted squared offsets) — if not, keep Essentia's phase.

```javascript
const essentiaScore = computePhaseScore(essentiaTicks, sessionOnsets);
const correctedScore = computePhaseScore(phaseCorrectedTicks, sessionOnsets);
const improvement = (essentiaScore - correctedScore) / essentiaScore;

if (improvement < 0.15 || sessionOnsets.length < 10) {
  // Phase correction didn't help enough or not enough data — use Essentia's original
  return essentiaTicks;
}
```

**Edge case 3: The onsets include the reference track (Free Play mode).** In Free Play mode with a song playing through speakers, the detected onsets include both the musician's playing AND the recording's onsets. This is actually fine for phase alignment — the recording's onsets are also on the beat, so they reinforce the correct phase rather than competing with it. The musician's onsets, if they're in the pocket, also reinforce the same phase. If the musician is significantly ahead or behind, the recording's (louder) onsets dominate the weighting and establish the correct grid — which is exactly what you want, since the pocket position should be measured relative to the song's beats.

**Edge case 4: Click mode.** In Click Mode, the grid is already known (the app generated the click). Phase correction is unnecessary and should be skipped. Only apply in Free Play mode.

### Performance Impact

The phase search is trivially fast:
- ~667 candidate phases to test (one beat period at 1ms resolution at 90 BPM)
- Each test: binary search through ~200 ticks, evaluate ~500 onsets
- Total: ~333,000 operations, each a comparison and multiply
- Expected time: <50ms on any modern device

This runs once per session, after Essentia processing. Adds negligible time to the pipeline.

---

## Implementation Order and Testing Plan

### Recommended order: Change 2 first, then Change 1

**Rationale:** Change 2 (phase alignment) is smaller in scope — it's a single function inserted at one point in the pipeline, with a clear before/after test (run-to-run variance). You can validate it in a day. Change 1 (multi-resolution FFT) requires modifying the audio signal chain, which affects everything and should be done once the grid is stable.

### Phase 1: Onset-Anchored Phase (1-2 days)

1. Implement `extractIntervals`, `reconstructTicks`, `findOptimalPhase`, `computePhaseScore` as standalone functions (can go in `analysis.js` or a new `phase-alignment.js`)
2. Wire into `analyzeFreePlayAdaptive()` between Essentia result processing and anchor construction
3. Add diagnostic logging (phase shift amount, score improvement)
4. Run the 5-run consistency test on Chicken Grease
5. Run the 5-run consistency test on Funky Drummer
6. Compare run-to-run variance with and without correction
7. If validated: make it the default for Free Play mode

### Phase 2: Multi-Resolution FFT (2-3 days)

1. Add second AnalyserNode + ScriptProcessorNode in `onset-detector.js`
2. Split band processing between paths
3. Adjust warmup frame count for LF path
4. Adjust parabolic interpolation frame duration for LF path
5. Re-run Experiment 1 (metronome baseline) — verify kick band onset count and timing jitter
6. Re-run Experiments 3/3b (Chicken Grease, Funky Drummer) — verify kick pocket consistency improvement
7. CPU stress test on mobile device — verify dual processors don't cause timing issues
8. If timing issues on mobile: fall back to post-processing approach for LF bands

### Success Criteria

| Metric | Current | After Phase Fix | After Multi-FFT |
|---|---|---|---|
| Run-to-run pocket position variance | ±10-15ms | **±3-5ms** | ±3-5ms |
| Kick band timing jitter | ±50-60ms | ±50-60ms | **±10-20ms** |
| Kick band onset reliability | Variable (5-31/run) | Variable | **Stable, near actual count** |
| Hi-hat timing jitter | ±11ms | ±11ms | ±11ms (unchanged) |
| Overall pocket position precision | ±3-4ms aggregate | **±2-3ms** | ±2-3ms |
| Processing time increase | Baseline | +<50ms | +100-150ms |

---

## What These Changes Enable Next

Once the grid phase is stable and low-frequency detection is precise:

- **Per-band pocket analysis becomes trustworthy for low frequencies.** "Your sub-bass onsets sit 15ms behind while your highs are 8ms behind" becomes a reliable statement, not noise.
- **Kick vs. bass separation improves.** With 10+ bins in the kick range instead of 3, the spectral profile of a kick drum onset (broadband thump concentrated below 100Hz) looks measurably different from a bass guitar onset (harmonic series peaking at 80-200Hz). Not perfect separation, but enough to differentiate in most cases.
- **The consistency problem shrinks dramatically.** Stable phase + better LF resolution means the same performance produces the same numbers regardless of when you press record. That's the foundation the entire product experience depends on.
- **Pattern detection on kick patterns becomes viable.** Currently, the noisy kick data means pattern detection often fails on kick (Chicken Grease kick: "No pattern detected"). With cleaner kick onsets, the circular histogram approach can actually find kick patterns, enabling rhythmically-informed kick identification.
