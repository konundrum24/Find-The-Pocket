// ============================================
// tempo-estimator.js — Autocorrelation-based tempo detection
//
// Improved half-time resolution using 16th-note grid alignment scoring.
// ============================================

const TempoEstimator = (() => {

  /**
   * Estimate tempo from onset times using autocorrelation histogram.
   *
   * @param {number[]} onsetTimesMs - array of onset timestamps in ms
   * @returns {number|null} estimated BPM, or null if insufficient data
   */
  function estimateTempo(onsetTimesMs) {
    if (onsetTimesMs.length < 8) return null;

    // Step 1: Compute all inter-onset intervals
    const intervals = [];
    for (let i = 1; i < onsetTimesMs.length; i++) {
      intervals.push(onsetTimesMs[i] - onsetTimesMs[i - 1]);
    }

    // Step 2: Build histogram (200ms–1500ms range = 40–300 BPM)
    const minInterval = 200, maxInterval = 1500, binSize = 2;
    const numBins = Math.ceil((maxInterval - minInterval) / binSize);
    const histogram = new Float32Array(numBins);

    for (const iv of intervals) {
      addGaussian(histogram, iv, minInterval, binSize, numBins, 1.0);
      addGaussian(histogram, iv * 2, minInterval, binSize, numBins, 0.5);
      addGaussian(histogram, iv / 2, minInterval, binSize, numBins, 0.5);
      addGaussian(histogram, iv * 3, minInterval, binSize, numBins, 0.3);
      addGaussian(histogram, iv / 3, minInterval, binSize, numBins, 0.2);
    }

    // Step 3: Smooth with Gaussian kernel
    const smoothed = gaussianSmooth(histogram, 5);

    // Step 4: Find peak
    let maxVal = 0, maxBin = 0;
    for (let i = 0; i < numBins; i++) {
      if (smoothed[i] > maxVal) { maxVal = smoothed[i]; maxBin = i; }
    }

    const peakMs = minInterval + maxBin * binSize;
    let bpm = 60000 / peakMs;

    // Step 5: Improved half-time / double-time resolution
    // Test the detected BPM and its half/double using 16th-note grid alignment
    const candidates = [bpm];
    if (bpm > 120) candidates.push(bpm / 2);
    if (bpm < 80) candidates.push(bpm * 2);

    let bestBpm = bpm, bestScore = -Infinity;

    for (const candidateBpm of candidates) {
      if (candidateBpm < 40 || candidateBpm > 200) continue;

      const beatMs = 60000 / candidateBpm;
      const gridUnitMs = beatMs / 4; // 16th note grid

      // Score: how many onsets land close to ANY 16th-note grid point?
      let bestPhaseScore = 0;
      for (let p = 0; p < 20; p++) {
        const phase = (p / 20) * beatMs;
        let matchCount = 0;
        for (const t of onsetTimesMs) {
          const gridPos = ((t - phase) % gridUnitMs + gridUnitMs) % gridUnitMs;
          const dist = Math.min(gridPos, gridUnitMs - gridPos);
          if (dist < gridUnitMs * 0.3) matchCount++;
        }
        if (matchCount > bestPhaseScore) bestPhaseScore = matchCount;
      }

      // Prefer BPM in the 60-160 range
      const rangeBias = (candidateBpm >= 60 && candidateBpm <= 160) ? 1.1 : 1.0;
      const score = bestPhaseScore * rangeBias;

      if (score > bestScore) {
        bestScore = score;
        bestBpm = candidateBpm;
      }
    }

    if (bestBpm < 40 || bestBpm > 300) return null;
    return bestBpm;
  }

  function addGaussian(hist, value, minVal, binSize, numBins, weight) {
    const bin = Math.floor((value - minVal) / binSize);
    for (let d = -3; d <= 3; d++) {
      const idx = bin + d;
      if (idx >= 0 && idx < numBins) {
        hist[idx] += weight * Math.exp(-(d * d) / 2);
      }
    }
  }

  function gaussianSmooth(data, radius) {
    const result = new Float32Array(data.length);
    const kernel = [];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * (radius / 2) * (radius / 2)));
      kernel.push(v);
      sum += v;
    }
    kernel.forEach((v, i) => kernel[i] = v / sum);

    for (let i = 0; i < data.length; i++) {
      let val = 0;
      for (let k = 0; k < kernel.length; k++) {
        const idx = i + k - radius;
        if (idx >= 0 && idx < data.length) {
          val += data[idx] * kernel[k];
        }
      }
      result[i] = val;
    }
    return result;
  }

  /**
   * Refine a coarse BPM estimate by sweeping nearby values and
   * finding the one where onsets best align to a 16th-note grid.
   *
   * @param {number[]} onsetTimesMs - All detected onset timestamps
   * @param {number} coarseBpm - Initial estimate from autocorrelation
   * @param {number} [searchRange=6] - How far to search (±BPM)
   * @param {number} [stepSize=0.25] - Resolution of search
   * @returns {number} Refined BPM estimate
   */
  function refineTempo(onsetTimesMs, coarseBpm, searchRange, stepSize) {
    searchRange = searchRange != null ? searchRange : 6;
    stepSize = stepSize || 0.25;
    if (onsetTimesMs.length < 12) return coarseBpm;

    let bestBpm = coarseBpm;
    let bestScore = -Infinity;

    const minBpm = Math.max(40, coarseBpm - searchRange);
    const maxBpm = Math.min(300, coarseBpm + searchRange);

    for (let candidateBpm = minBpm; candidateBpm <= maxBpm; candidateBpm += stepSize) {
      const score = gridAlignmentScore(onsetTimesMs, candidateBpm);
      if (score > bestScore) {
        bestScore = score;
        bestBpm = candidateBpm;
      }
    }

    return bestBpm;
  }

  /**
   * Score how well onsets align to a 16th-note grid at a given BPM.
   * Higher = better. Tests 20 phase offsets, returns best.
   *
   * Uses a tight window (±15% of grid unit) to count matches, then
   * adds a small precision bonus from normalized distances so ties
   * break toward tighter alignment. Normalizing by gridUnitMs prevents
   * faster tempos (denser grids) from artificially scoring higher.
   */
  function gridAlignmentScore(onsetTimesMs, bpm) {
    const beatMs = 60000 / bpm;
    const gridUnitMs = beatMs / 4;
    const tightWindow = gridUnitMs * 0.15;
    const n = onsetTimesMs.length;
    let bestPhaseScore = -Infinity;

    for (let p = 0; p < 20; p++) {
      const phase = (p / 20) * beatMs;
      let tightMatches = 0;
      let normalizedErrorSum = 0;

      for (const t of onsetTimesMs) {
        const gridPos = ((t - phase) % gridUnitMs + gridUnitMs) % gridUnitMs;
        const dist = Math.min(gridPos, gridUnitMs - gridPos);
        if (dist < tightWindow) {
          tightMatches++;
          // Normalized: 0 = perfect, 1 = at window edge
          normalizedErrorSum += (dist / gridUnitMs) * (dist / gridUnitMs);
        }
      }

      // Primary: fraction of onsets matched (0–1, BPM-neutral)
      // Secondary: small precision bonus (0–1 range, scaled down)
      const matchFraction = tightMatches / n;
      const precision = tightMatches > 0
        ? 1 - (normalizedErrorSum / tightMatches)
        : 0;
      const score = matchFraction + precision * 0.1;

      if (score > bestPhaseScore) bestPhaseScore = score;
    }

    return bestPhaseScore;
  }

  /**
   * Compute stable tempo curve from classified downbeat onsets.
   * Uses inter-downbeat intervals constrained to ±15% of global BPM.
   *
   * @param {Array<{time: number, isDownbeat: boolean}>} classifiedOnsets
   * @param {number} globalBpm
   * @param {number} [windowSec=4]
   * @returns {Array<{time: number, bpm: number}>}
   */
  function computeTempoCurve(classifiedOnsets, globalBpm, windowSec) {
    windowSec = windowSec || 4;

    // Filter to downbeats only for stable tempo reading
    const downbeats = classifiedOnsets.filter(o => o.isDownbeat);
    if (downbeats.length < 6) return [];

    const windowMs = windowSec * 1000;
    const step = 1000;
    const maxTime = downbeats[downbeats.length - 1].time;
    const expectedBeatMs = 60000 / globalBpm;
    const curve = [];

    for (let center = windowMs / 2; center < maxTime - windowMs / 2; center += step) {
      const windowHits = downbeats.filter(
        o => o.time >= center - windowMs / 2 && o.time <= center + windowMs / 2
      );

      if (windowHits.length >= 3) {
        const intervals = [];
        for (let i = 1; i < windowHits.length; i++) {
          const iv = windowHits[i].time - windowHits[i - 1].time;
          // Accept intervals close to expected beat length (±50%)
          if (iv > expectedBeatMs * 0.5 && iv < expectedBeatMs * 1.5) {
            // May be 1 beat, 2 beats, etc. — normalize to single beat
            const numBeats = Math.round(iv / expectedBeatMs);
            if (numBeats > 0) intervals.push(iv / numBeats);
          }
        }

        if (intervals.length >= 2) {
          const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
          const localBpm = 60000 / avgInterval;
          // Sanity: must be within ±15% of global
          if (localBpm > globalBpm * 0.85 && localBpm < globalBpm * 1.15) {
            curve.push({ time: center, bpm: localBpm });
          }
        }
      }
    }

    return curve;
  }

  return {
    estimateTempo,
    refineTempo,
    computeTempoCurve
  };
})();
