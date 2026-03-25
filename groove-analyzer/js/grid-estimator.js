// ============================================
// grid-estimator.js — Grid construction from estimated tempo
//
// Supports 16th-note subdivision grids for Free Play mode.
// Click Mode continues to use Grid.js with quarter-note grids.
// ============================================

const GridEstimator = (() => {

  /**
   * Build a beat grid from estimated tempo by finding optimal phase alignment.
   *
   * @param {number[]} onsetTimesMs - array of onset timestamps in ms
   * @param {number} bpm - estimated BPM
   * @param {number} [subdivisions=4] - grid subdivisions per beat (1=quarter, 2=eighth, 4=sixteenth)
   * @returns {{ points: number[], gridUnitMs: number, beatMs: number, subdivisions: number, phase: number }}
   */
  function buildGrid(onsetTimesMs, bpm, subdivisions) {
    subdivisions = subdivisions || 4;
    const beatMs = 60000 / bpm;
    const gridUnitMs = beatMs / subdivisions;
    const totalDuration = onsetTimesMs[onsetTimesMs.length - 1];

    // Find optimal phase (test across one quarter-note beat, not one grid unit)
    let bestPhase = 0, bestScore = Infinity;
    const phaseSteps = 50;

    for (let p = 0; p < phaseSteps; p++) {
      const phase = (p / phaseSteps) * beatMs;
      let score = 0;
      for (const t of onsetTimesMs) {
        // Distance to nearest grid point at this phase
        const gridPos = ((t - phase) % gridUnitMs + gridUnitMs) % gridUnitMs;
        const dist = Math.min(gridPos, gridUnitMs - gridPos);
        score += dist * dist;
      }
      if (score < bestScore) { bestScore = score; bestPhase = phase; }
    }

    // Generate all grid points
    const points = [];
    let t = bestPhase;
    while (t > -gridUnitMs) t -= gridUnitMs;
    while (t <= totalDuration + gridUnitMs) {
      points.push(t);
      t += gridUnitMs;
    }

    return {
      points,
      gridUnitMs,
      beatMs,
      subdivisions,
      phase: bestPhase
    };
  }

  return {
    buildGrid
  };
})();
