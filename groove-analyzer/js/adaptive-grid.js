// ============================================
// adaptive-grid.js — Adaptive grid engine for Free Play
//
// Builds a 16th-note grid that follows the music's actual tempo
// by anchoring to the most periodic onsets. Uses periodicity
// scoring to find the true pulse regardless of loudness.
// ============================================

const AdaptiveGrid = (() => {

  // ── Periodicity-Based Anchor Selection ──

  /**
   * Generate candidate beat periods to test.
   * Searches ±15% of coarse estimate in 0.5ms steps.
   */
  function getCandidatePeriods(coarseBpm) {
    const coarsePeriod = 60000 / coarseBpm;
    const candidates = [];
    const minPeriod = coarsePeriod * 0.85;
    const maxPeriod = coarsePeriod * 1.15;
    for (let p = minPeriod; p <= maxPeriod; p += 0.5) {
      candidates.push(p);
    }
    return candidates;
  }

  /**
   * Score a candidate beat period by how well onsets align to it.
   * Tests multiple phase offsets. Returns the best score with
   * the matching anchor indices.
   */
  function scoreCandidatePeriod(onsets, period) {
    const dev = period * 0.15;
    let bestScore = -Infinity;
    let bestCoverage = 0;
    let bestPhase = 0;
    let bestAnchors = [];

    const phaseSteps = 30;
    const totalDuration = onsets[onsets.length - 1].time - onsets[0].time;
    const expectedBeats = Math.floor(totalDuration / period) + 1;

    for (let p = 0; p < phaseSteps; p++) {
      const phase = onsets[0].time + (p / phaseSteps) * period;
      const matches = [];

      for (let beatNum = 0; beatNum < expectedBeats; beatNum++) {
        const expectedTime = phase + beatNum * period;

        let bestMatch = null;
        let bestDist = Infinity;

        for (let i = 0; i < onsets.length; i++) {
          const dist = Math.abs(onsets[i].time - expectedTime);
          if (dist < bestDist) {
            bestDist = dist;
            bestMatch = i;
          }
          if (onsets[i].time > expectedTime + dev) break;
        }

        if (bestMatch !== null && bestDist <= dev) {
          matches.push({
            onsetIndex: bestMatch,
            deviation: bestDist,
            expectedTime: expectedTime,
            actualTime: onsets[bestMatch].time,
            amplitude: onsets[bestMatch].amplitude
          });
        }
      }

      if (matches.length < 3) continue;

      const coverage = matches.length / expectedBeats;
      const avgDeviation = matches.reduce((s, m) => s + m.deviation, 0) / matches.length;
      const deviationConsistency = Math.sqrt(
        matches.reduce((s, m) => s + (m.deviation - avgDeviation) ** 2, 0) / matches.length
      );

      const normalizedDev = avgDeviation / period;
      const normalizedConsistency = deviationConsistency / period;

      const score = (coverage * 100)
                  - (normalizedDev * 200)
                  - (normalizedConsistency * 100)
                  + (matches.length * 0.5);

      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
        bestAnchors = matches;
        bestCoverage = coverage;
      }
    }

    return {
      period,
      bpm: 60000 / period,
      score: bestScore,
      coverage: bestCoverage,
      phase: bestPhase,
      anchors: bestAnchors
    };
  }

  /**
   * Find the beat period that produces the most periodic anchor pattern.
   *
   * @param {Array<{time: number, amplitude: number}>} onsets
   * @param {number} coarseBpm - approximate BPM from autocorrelation
   * @returns {object} best result with period, bpm, score, anchors
   */
  function findPeriodicPulse(onsets, coarseBpm) {
    const candidates = getCandidatePeriods(coarseBpm);

    let best = { score: -Infinity, coverage: 0 };
    for (const period of candidates) {
      const result = scoreCandidatePeriod(onsets, period);
      if (result.score > best.score) best = result;
    }

    // Note: BPM clamping removed — metric level selection in
    // MetricSelector.selectMetricLevel() now handles choosing the
    // correct beat level using multi-signal scoring.
    return best;
  }

  /**
   * Convert periodic pulse matches into anchor array for buildAdaptiveGrid.
   * Fills gaps where expected beats had no matching onset.
   *
   * @param {object} pulseResult - from findPeriodicPulse()
   * @param {Array} onsets - all detected onsets
   * @returns {Array} anchor array sorted by time
   */
  function pulseToAnchors(pulseResult, onsets) {
    const anchors = pulseResult.anchors.map(match => ({
      time: onsets[match.onsetIndex].time,
      amplitude: onsets[match.onsetIndex].amplitude,
      interpolated: false
    }));

    anchors.sort((a, b) => a.time - b.time);

    // Fill gaps with interpolated anchors
    const period = pulseResult.period;
    const filled = [];

    for (let i = 0; i < anchors.length; i++) {
      filled.push(anchors[i]);

      if (i < anchors.length - 1) {
        const gap = anchors[i + 1].time - anchors[i].time;
        const expectedBeats = Math.round(gap / period);

        if (expectedBeats > 1) {
          const actualInterval = gap / expectedBeats;
          for (let j = 1; j < expectedBeats; j++) {
            filled.push({
              time: anchors[i].time + actualInterval * j,
              amplitude: 0,
              interpolated: true
            });
          }
        }
      }
    }

    return filled;
  }

  /**
   * Find anchors using periodicity-based selection.
   * Replaces the old loudness-based approach.
   *
   * @param {Array<{time: number, amplitude: number}>} onsets
   * @param {number} coarseBpm - approximate BPM from autocorrelation
   * @returns {Array} anchor array for buildAdaptiveGrid
   */
  function findAnchors(onsets, coarseBpm) {
    if (onsets.length < 4) return [];

    const pulse = findPeriodicPulse(onsets, coarseBpm);
    if (!pulse.anchors || pulse.anchors.length < 3) return [];

    return pulseToAnchors(pulse, onsets);
  }

  // ── Grid Building ──

  /**
   * Build a 16th-note grid that adapts to local tempo between anchors.
   */
  function buildAdaptiveGrid(anchors) {
    if (anchors.length < 2) return null;

    const points = [];
    const localTempos = [];

    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      const localBeatMs = b.time - a.time;
      const localBpm = 60000 / localBeatMs;
      const gridUnitMs = localBeatMs / 4;

      localTempos.push({ time: a.time, bpm: localBpm, beatMs: localBeatMs });

      for (let sub = 0; sub < 4; sub++) {
        points.push({
          time: a.time + sub * gridUnitMs,
          beatPosition: sub,
          localBeatMs: localBeatMs,
          localBpm: localBpm,
          anchorIndex: i
        });
      }
    }

    // Final anchor as downbeat
    const last = anchors[anchors.length - 1];
    const prevBeatMs = localTempos.length > 0
      ? localTempos[localTempos.length - 1].beatMs
      : 600;
    points.push({
      time: last.time,
      beatPosition: 0,
      localBeatMs: prevBeatMs,
      localBpm: 60000 / prevBeatMs,
      anchorIndex: anchors.length - 1
    });

    // Compute median grid unit for density calculations
    const beatMsValues = localTempos.map(lt => lt.beatMs);
    beatMsValues.sort((a, b) => a - b);
    const medianBeatMs = beatMsValues[Math.floor(beatMsValues.length / 2)];

    return {
      points,
      localTempos,
      anchors,
      medianBeatMs,
      medianGridUnitMs: medianBeatMs / 4,
      subdivisions: 4
    };
  }

  // ── Onset Matching ──

  /**
   * Match all onsets to the adaptive grid.
   * Returns already-classified onsets.
   */
  function matchToAdaptiveGrid(onsets, grid) {
    const matched = [];

    for (const onset of onsets) {
      let nearest = null;
      let minDist = Infinity;

      for (const gp of grid.points) {
        const dist = Math.abs(onset.time - gp.time);
        if (dist < minDist) {
          minDist = dist;
          nearest = gp;
        }
      }

      if (!nearest) continue;

      const localGridUnit = nearest.localBeatMs / 4;
      const maxOffset = localGridUnit * 0.35;
      const offset = onset.time - nearest.time;

      if (Math.abs(offset) <= maxOffset) {
        matched.push({
          time: onset.time,
          offset: offset,
          amplitude: onset.amplitude,
          gridTime: nearest.time,
          beatPosition: nearest.beatPosition,
          beatNumber: nearest.anchorIndex,
          localBpm: nearest.localBpm,
          isDownbeat: nearest.beatPosition === 0,
          isUpbeat: nearest.beatPosition === 2,
          isSubdivision: nearest.beatPosition === 1 || nearest.beatPosition === 3
        });
      }
    }

    return matched;
  }

  // ── Tempo Curve ──

  /**
   * Get tempo curve from anchor intervals.
   * Smoothed with rolling median of 4 (resistant to outlier anchors).
   */
  function getTempoFromAnchors(grid) {
    const raw = grid.localTempos;
    if (raw.length < 4) return raw.map(lt => ({ time: lt.time, bpm: lt.bpm }));

    const smoothed = [];
    const w = 4;
    for (let i = 0; i < raw.length; i++) {
      const start = Math.max(0, i - Math.floor(w / 2));
      const end = Math.min(raw.length, start + w);
      const windowBpms = [];
      for (let j = start; j < end; j++) windowBpms.push(raw[j].bpm);
      windowBpms.sort((a, b) => a - b);
      const median = windowBpms[Math.floor(windowBpms.length / 2)];
      smoothed.push({ time: raw[i].time, bpm: median });
    }
    return smoothed;
  }

  /**
   * Get global BPM as median of local tempos.
   */
  function getGlobalBpm(grid) {
    const bpms = grid.localTempos.map(lt => lt.bpm);
    const sorted = [...bpms].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * Shift all grid point times by a phase correction.
   * Returns a new grid object with shifted times (does not mutate original).
   */
  function shiftGridPhase(grid, correctionMs) {
    return {
      ...grid,
      points: grid.points.map(p => ({
        ...p,
        time: p.time + correctionMs
      })),
      anchors: grid.anchors.map(a => ({
        ...a,
        time: a.time + correctionMs
      })),
      localTempos: grid.localTempos.map(lt => ({
        ...lt,
        time: lt.time + correctionMs
      }))
    };
  }

  return {
    findAnchors,
    findPeriodicPulse,
    pulseToAnchors,
    buildAdaptiveGrid,
    matchToAdaptiveGrid,
    shiftGridPhase,
    getTempoFromAnchors,
    getGlobalBpm
  };
})();
