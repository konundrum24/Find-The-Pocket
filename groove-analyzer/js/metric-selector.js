// ============================================
// metric-selector.js — Multi-Signal Metric Level Selector
//
// Solves the metric level ambiguity problem: the periodicity finder
// locks onto the most regular pulse (often hi-hat eighth notes),
// but we need the quarter-note beat. This module scores candidate
// metric levels across three independent musical signals to find
// the correct beat period.
// ============================================

const MetricSelector = (() => {

  // ── Utility: Fold Onsets Into a Single Cycle ──

  /**
   * Fold all onsets into a single cycle at the given period.
   * Divide cycle into numBins equal-width bins.
   * For each bin, compute mean amplitude and onset count.
   *
   * @param {Array} onsets - [{time, amplitude}, ...]
   * @param {number} period - candidate beat period in ms
   * @param {number} numBins - bins per cycle (8 recommended)
   * @returns {Array} [{binCenter, meanAmplitude, count}, ...]
   */
  function foldIntoCycle(onsets, period, numBins) {
    const binWidth = period / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => ({
      binCenter: (i + 0.5) * binWidth,
      amplitudes: [],
      count: 0
    }));

    for (const onset of onsets) {
      const phase = ((onset.time % period) + period) % period;
      const binIndex = Math.min(Math.floor(phase / binWidth), numBins - 1);
      bins[binIndex].amplitudes.push(onset.amplitude);
      bins[binIndex].count++;
    }

    return bins.map(b => ({
      binCenter: b.binCenter,
      meanAmplitude: b.amplitudes.length > 0
        ? b.amplitudes.reduce((s, a) => s + a, 0) / b.amplitudes.length
        : 0,
      count: b.count
    }));
  }

  // ── Signal 1: Accent Contour Score ──

  /**
   * Score a candidate period by how structured its amplitude contour is.
   *
   * High (> 0.4) = strong accent structure (likely the beat level)
   * Low (< 0.15) = flat contour (likely a subdivision level)
   *
   * Uses coefficient of variation + peak-to-valley ratio.
   */
  function accentContourScore(onsets, period) {
    const bins = foldIntoCycle(onsets, period, 8);
    const amplitudes = bins.map(b => b.meanAmplitude);

    const active = amplitudes.filter(a => a > 0);
    if (active.length < 3) return 0;

    const mean = active.reduce((s, a) => s + a, 0) / active.length;
    if (mean === 0) return 0;

    const variance = active.reduce((s, a) => s + (a - mean) ** 2, 0) / active.length;
    const coeffOfVariation = Math.sqrt(variance) / mean;

    // Peak-to-valley ratio for additional discrimination
    const sorted = [...active].sort((a, b) => a - b);
    const q1Count = Math.max(1, Math.floor(sorted.length / 4));
    const bottomQ = sorted.slice(0, q1Count);
    const topQ = sorted.slice(-q1Count);
    const bottomMean = bottomQ.reduce((s, a) => s + a, 0) / bottomQ.length;
    const topMean = topQ.reduce((s, a) => s + a, 0) / topQ.length;
    const peakToValley = bottomMean > 0.001 ? topMean / bottomMean : (topMean > 0 ? 8 : 0);

    // Combined: CoV is primary, peak-to-valley confirms
    const raw = (coeffOfVariation * 0.6) +
      (Math.min(Math.log2(Math.max(peakToValley, 1)), 3) / 3 * 0.4);

    return raw;
  }

  // ── Signal 2: Interval Clustering Score ──

  /**
   * Score a candidate period by how cleanly inter-onset intervals map to
   * musical subdivisions of that period.
   *
   * Expected subdivision ratios: 0.25 (16th), 0.333 (triplet 8th),
   * 0.5 (8th), 0.667 (dotted 8th), 1.0 (quarter), 1.5 (dotted quarter), 2.0 (half)
   *
   * Returns: 0 to 1, where 1 = every interval is a clean subdivision.
   */
  function intervalClusterScore(onsets, period) {
    if (onsets.length < 4) return 0;

    const expectedRatios = [0.25, 0.333, 0.5, 0.667, 1.0, 1.5, 2.0];
    const tolerance = 0.12;

    let matchCount = 0;
    let totalIntervals = 0;

    for (let i = 1; i < onsets.length; i++) {
      const interval = onsets[i].time - onsets[i - 1].time;

      if (interval > period * 3) continue;
      if (interval < period * 0.15) continue;

      totalIntervals++;
      const ratio = interval / period;

      for (const expected of expectedRatios) {
        if (Math.abs(ratio - expected) < tolerance * expected) {
          matchCount++;
          break;
        }
      }
    }

    return totalIntervals > 0 ? matchCount / totalIntervals : 0;
  }

  // ── Signal 3: Onset Density Score ──

  /**
   * Score a candidate period by how unevenly onsets distribute across
   * the folded cycle. Uses onset COUNTS only, ignoring amplitude.
   *
   * Returns: coefficient of variation of bin counts
   * (0 = uniform, higher = structured)
   */
  function onsetDensityScore(onsets, period) {
    const bins = foldIntoCycle(onsets, period, 8);
    const counts = bins.map(b => b.count);

    const active = counts.filter(c => c > 0);
    if (active.length < 3) return 0;

    const mean = active.reduce((s, c) => s + c, 0) / active.length;
    if (mean === 0) return 0;

    const variance = active.reduce((s, c) => s + (c - mean) ** 2, 0) / active.length;
    const coeffOfVariation = Math.sqrt(variance) / mean;

    return coeffOfVariation;
  }

  // ── Candidate Generation ──

  /**
   * Generate candidate metric levels from the periodicity finder's result.
   * Filters to physically possible BPM range (35–220).
   */
  function getCandidateMetricLevels(basePeriod) {
    const candidates = [
      { period: basePeriod * 0.5, label: 'double-time' },
      { period: basePeriod,       label: 'as-found' },
      { period: basePeriod * 2,   label: 'half-time' },
      { period: basePeriod * 4,   label: 'quarter-time' },
    ];

    return candidates.filter(c => {
      const bpm = 60000 / c.period;
      return bpm >= 35 && bpm <= 220;
    });
  }

  // ── Main Entry Point ──

  /**
   * Given the periodicity finder's result and all detected onsets,
   * determine the correct beat-level period.
   *
   * @param {Array} onsets - All detected onsets [{time, amplitude}, ...]
   * @param {Object} periodicityResult - Output of findPeriodicPulse()
   *        Must have: { period, bpm, score, anchors }
   * @returns {Object} {
   *   period: number,     // Beat period in ms
   *   bpm: number,        // Equivalent BPM
   *   label: string,      // Which level was selected
   *   score: number,      // Combined score
   *   debug: {            // For logging/diagnostics
   *     candidates: [...],
   *     winner: string
   *   }
   * }
   */
  function selectMetricLevel(onsets, periodicityResult) {
    const basePeriod = periodicityResult.period;
    const candidates = getCandidateMetricLevels(basePeriod);

    if (candidates.length === 0) {
      return {
        period: basePeriod,
        bpm: 60000 / basePeriod,
        label: 'as-found (fallback)',
        score: 0,
        debug: { candidates: [], winner: 'fallback' }
      };
    }

    const scored = candidates.map(candidate => {
      const accent   = accentContourScore(onsets, candidate.period);
      const interval = intervalClusterScore(onsets, candidate.period);
      const density  = onsetDensityScore(onsets, candidate.period);

      const bpm = 60000 / candidate.period;
      const rangeFactor = (bpm >= 55 && bpm <= 165) ? 1.0 : 0.75;

      // Weighted combination:
      //   Interval clustering: 40 (most syncopation-robust)
      //   Accent contour:      30 (strong for conventional music)
      //   Onset density:       20 (middle ground)
      //   BPM range:           multiplier (tiebreaker)
      const combined = (
        interval * 40 +
        accent   * 30 +
        density  * 20
      ) * rangeFactor;

      return {
        ...candidate,
        bpm,
        accent,
        interval,
        density,
        rangeFactor,
        combined
      };
    });

    scored.sort((a, b) => b.combined - a.combined);
    const winner = scored[0];

    return {
      period: winner.period,
      bpm: winner.bpm,
      label: winner.label,
      score: winner.combined,
      debug: {
        candidates: scored.map(c => ({
          label: c.label,
          bpm: Math.round(c.bpm * 10) / 10,
          period: Math.round(c.period * 10) / 10,
          accent: Math.round(c.accent * 1000) / 1000,
          interval: Math.round(c.interval * 1000) / 1000,
          density: Math.round(c.density * 1000) / 1000,
          rangeFactor: c.rangeFactor,
          combined: Math.round(c.combined * 10) / 10
        })),
        winner: winner.label
      }
    };
  }

  // ── Public API ──

  return {
    selectMetricLevel,
    // Exposed for isolated testing / diagnostics
    foldIntoCycle,
    accentContourScore,
    intervalClusterScore,
    onsetDensityScore,
    getCandidateMetricLevels
  };

})();
