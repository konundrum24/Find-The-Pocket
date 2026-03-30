/**
 * Phase Alignment Module
 *
 * Decouples Essentia's tempo (inter-beat intervals) from its phase (absolute
 * beat positions).  Uses amplitude-weighted onset alignment to find the phase
 * that best matches the musical content, eliminating run-to-run variance
 * caused by Essentia's arbitrary phase placement.
 *
 * Only applied in Free Play mode with Essentia-derived anchors.
 */
const PhaseAlignment = (function () {
  'use strict';

  /**
   * Extract inter-beat intervals from anchor array.
   * Preserves Essentia's tempo tracking (including drift) while discarding
   * its absolute phase.
   *
   * @param {Array<{time: number}>} anchors - beat anchors (ms, session-relative)
   * @returns {{ intervals: number[], firstTime: number }}
   */
  function extractIntervals(anchors) {
    const intervals = [];
    for (let i = 1; i < anchors.length; i++) {
      intervals.push(anchors[i].time - anchors[i - 1].time);
    }
    return {
      intervals,
      firstTime: anchors[0].time  // Essentia's original phase
    };
  }

  /**
   * Reconstruct anchor times from intervals + a phase offset.
   *
   * @param {number[]} intervals - beat-to-beat durations (ms)
   * @param {number} phaseOffset - time of first beat (ms)
   * @returns {number[]} array of beat times (ms)
   */
  function reconstructTicks(intervals, phaseOffset) {
    const ticks = [phaseOffset];
    for (let i = 0; i < intervals.length; i++) {
      ticks.push(ticks[i] + intervals[i]);
    }
    return ticks;
  }

  /**
   * Binary search for the nearest tick to a given time.
   *
   * @param {number[]} ticks - sorted array of beat times (ms)
   * @param {number} timeMs - onset time to match (ms)
   * @returns {number} nearest tick time (ms)
   */
  function findNearestTick(ticks, timeMs) {
    let lo = 0, hi = ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] < timeMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(ticks[lo - 1] - timeMs) < Math.abs(ticks[lo] - timeMs)) {
      return ticks[lo - 1];
    }
    return ticks[lo];
  }

  /**
   * Score a candidate phase alignment.
   *
   * Returns the amplitude-weighted mean of squared offsets between onsets and
   * their nearest grid tick.  Lower is better.  Louder onsets contribute more,
   * so the phase locks to the musically prominent hits (backbeat, downbeat).
   *
   * @param {number[]} candidateTicks - beat positions for this candidate (ms)
   * @param {Array<{time: number, amplitude: number}>} onsets - session onsets
   * @returns {number} weighted mean squared offset (ms²)
   */
  function computePhaseScore(candidateTicks, onsets) {
    if (candidateTicks.length < 2) return Infinity;

    // Use median interval for the beat-period window
    const beatPeriodMs = candidateTicks[1] - candidateTicks[0];
    const windowMs = beatPeriodMs * 0.4;

    let weightedSumSq = 0;
    let totalWeight = 0;

    for (const onset of onsets) {
      const nearestTick = findNearestTick(candidateTicks, onset.time);
      const offsetMs = onset.time - nearestTick;

      // Only consider onsets within ±40% of beat period
      if (Math.abs(offsetMs) > windowMs) continue;

      const weight = onset.amplitude;
      weightedSumSq += weight * offsetMs * offsetMs;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSumSq / totalWeight : Infinity;
  }

  /**
   * Search for the phase offset that minimises onset-to-grid deviation.
   *
   * Scans ±half a beat period around Essentia's original phase in 1 ms steps.
   *
   * @param {number[]} intervals - inter-beat intervals (ms)
   * @param {Array<{time: number, amplitude: number}>} onsets - session onsets
   * @param {number} essentiaFirstTime - Essentia's original first-anchor time (ms)
   * @returns {number} optimal first-beat time (ms)
   */
  function findOptimalPhase(intervals, onsets, essentiaFirstTime) {
    if (intervals.length === 0 || onsets.length === 0) return essentiaFirstTime;

    const firstInterval = intervals[0]; // one beat period (ms)
    const halfBeat = firstInterval / 2;
    const searchStepMs = 1;
    const searchSteps = Math.round(firstInterval / searchStepMs);

    let bestPhase = essentiaFirstTime;
    let bestScore = Infinity;

    for (let step = 0; step < searchSteps; step++) {
      const candidatePhase = essentiaFirstTime - halfBeat + step * searchStepMs;
      const candidateTicks = reconstructTicks(intervals, candidatePhase);
      const score = computePhaseScore(candidateTicks, onsets);

      if (score < bestScore) {
        bestScore = score;
        bestPhase = candidatePhase;
      }
    }

    return bestPhase;
  }

  // ── Minimum-onset and improvement guardrails ──────────────────────────
  const MIN_ONSETS = 10;
  const MIN_IMPROVEMENT = 0.15; // 15 %

  /**
   * Apply onset-anchored phase correction to Essentia anchors.
   *
   * Returns phase-corrected anchors (same shape as input) or the original
   * anchors unchanged if the correction doesn't meet guardrail thresholds.
   *
   * @param {Array<{time: number, amplitude: number, interpolated: boolean}>} anchors
   * @param {Array<{time: number, amplitude: number}>} onsets - sessionOnsets
   * @returns {{ anchors: Array, phaseShiftMs: number, improved: boolean }}
   */
  function correctPhase(anchors, onsets) {
    if (anchors.length < 4 || onsets.length < MIN_ONSETS) {
      return { anchors, phaseShiftMs: 0, improved: false };
    }

    const { intervals, firstTime } = extractIntervals(anchors);
    const originalTicks = anchors.map(a => a.time);

    // Score Essentia's original phase
    const originalScore = computePhaseScore(originalTicks, onsets);

    // Find optimal phase
    const optimalPhase = findOptimalPhase(intervals, onsets, firstTime);
    const correctedTicks = reconstructTicks(intervals, optimalPhase);
    const correctedScore = computePhaseScore(correctedTicks, onsets);

    const phaseShiftMs = optimalPhase - firstTime;
    const improvement = originalScore > 0
      ? (originalScore - correctedScore) / originalScore
      : 0;

    // Guardrail: skip if improvement is negligible
    if (improvement < MIN_IMPROVEMENT) {
      console.log('[PhaseAlign] Correction skipped — improvement ' +
        (improvement * 100).toFixed(1) + '% < ' + (MIN_IMPROVEMENT * 100) + '% threshold');
      return { anchors, phaseShiftMs: 0, improved: false };
    }

    // Build corrected anchors (same shape as originals)
    const correctedAnchors = correctedTicks.map((t, i) => ({
      time: t,
      amplitude: i < anchors.length ? anchors[i].amplitude : 1,
      interpolated: i < anchors.length ? anchors[i].interpolated : false
    }));

    console.log('[PhaseAlign] Phase correction applied: ' +
      (phaseShiftMs >= 0 ? '+' : '') + phaseShiftMs.toFixed(1) + 'ms shift, ' +
      (improvement * 100).toFixed(1) + '% score improvement ' +
      '(score ' + originalScore.toFixed(1) + ' → ' + correctedScore.toFixed(1) + ')');

    return { anchors: correctedAnchors, phaseShiftMs, improved: true };
  }

  return {
    extractIntervals,
    reconstructTicks,
    findNearestTick,
    computePhaseScore,
    findOptimalPhase,
    correctPhase
  };
})();
