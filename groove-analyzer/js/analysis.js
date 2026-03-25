// ============================================
// analysis.js — Offset computation, metrics, calibration
// ============================================

const Analysis = (() => {

  /**
   * Find nearest grid point and compute signed offset.
   * Positive = behind the beat, negative = ahead.
   *
   * @param {number} onsetTimeMs
   * @param {number[]} gridTimes - sorted array of grid timestamps in ms
   * @returns {{ offset: number, gridTime: number, distance: number } | null}
   */
  function computeOffset(onsetTimeMs, gridTimes) {
    let nearest = null;
    let minDist = Infinity;

    for (const gt of gridTimes) {
      const dist = Math.abs(onsetTimeMs - gt);
      if (dist < minDist) {
        minDist = dist;
        nearest = gt;
      }
    }

    if (nearest === null) return null;

    return {
      offset: onsetTimeMs - nearest,
      gridTime: nearest,
      distance: minDist
    };
  }

  /**
   * Compute the latency offset from calibration hits.
   * Trims top and bottom 15%, returns median of trimmed set.
   *
   * @param {number[]} offsets - raw calibration offsets
   * @returns {number} latency offset in ms
   */
  function computeLatencyOffset(offsets) {
    const sorted = [...offsets].sort((a, b) => a - b);
    const trimCount = Math.max(1, Math.floor(sorted.length * 0.15));
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
    return trimmed[Math.floor(trimmed.length / 2)];
  }

  /**
   * Compute all session metrics from corrected onset offsets.
   *
   * @param {Array<{time: number, offset: number, raw: number, amplitude: number}>} sessionOnsets
   * @param {number} msPerBeat
   * @param {number} tempo - set BPM
   * @returns {object} metrics
   */
  function computeSessionMetrics(sessionOnsets, msPerBeat, tempo) {
    const offsets = sessionOnsets.map(o => o.offset);

    // Pocket position (average offset)
    const avgOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;

    // Consistency (standard deviation)
    const variance = offsets.reduce((a, b) => a + (b - avgOffset) ** 2, 0) / offsets.length;
    const stdDev = Math.sqrt(variance);

    // Tempo stability from inter-onset intervals
    const times = sessionOnsets.map(o => o.time);
    const bpms = [];
    for (let i = 1; i < times.length; i++) {
      const interval = times[i] - times[i - 1];
      if (interval > msPerBeat * 0.65 && interval < msPerBeat * 1.35) {
        bpms.push(60000 / interval);
      }
    }

    const avgBpm = bpms.length > 0
      ? bpms.reduce((a, b) => a + b, 0) / bpms.length
      : tempo;

    const bpmStdDev = bpms.length > 2
      ? Math.sqrt(bpms.reduce((a, b) => a + (b - avgBpm) ** 2, 0) / bpms.length)
      : 0;

    return {
      avgOffset,
      stdDev,
      avgBpm,
      bpmStdDev,
      hitCount: sessionOnsets.length,
      offsets
    };
  }

  /**
   * Maximum allowed offset (28% of beat interval).
   * Used by Click Mode and Playground against quarter-note grids.
   */
  function maxOffsetMs(msPerBeat) {
    return msPerBeat * 0.28;
  }

  /**
   * Maximum allowed offset for 16th-note subdivision grid (35% of grid unit).
   * Tighter threshold since onsets are much closer to their correct grid point.
   */
  function maxSubdivisionOffsetMs(gridUnitMs) {
    return gridUnitMs * 0.35;
  }

  /**
   * Cooldown in samples (55% of the given interval).
   * Pass msPerBeat for quarter-note cooldown, or gridUnitMs for 16th-note cooldown.
   */
  function cooldownSamples(intervalMs, sampleRate) {
    return Math.floor((intervalMs * 0.55 / 1000) * sampleRate);
  }

  /**
   * Classify each matched onset by its position within the beat.
   *
   * In a 16th-note grid (subdivisions=4), positions within each beat are:
   *   0 = downbeat (the beat itself: "1", "2", "3", "4")
   *   1 = first subdivision ("e")
   *   2 = upbeat ("and" / "&")
   *   3 = second subdivision ("ah")
   *
   * @param {Array<{offset: number, gridTime: number, time: number, amplitude: number}>} matchedOnsets
   * @param {{ points: number[], subdivisions: number }} grid
   * @returns {Array} onsets with beatPosition, beatNumber, isDownbeat, isUpbeat, isSubdivision
   */
  function classifyOnsets(matchedOnsets, grid) {
    return matchedOnsets.map(onset => {
      // Find which grid point this onset matched to
      let gridIndex = -1;
      let minDist = Infinity;
      for (let i = 0; i < grid.points.length; i++) {
        const d = Math.abs(onset.gridTime - grid.points[i]);
        if (d < minDist) { minDist = d; gridIndex = i; }
      }

      // Position within the beat (0 = downbeat, 1 = "e", 2 = "&", 3 = "ah")
      const beatPosition = ((gridIndex % grid.subdivisions) + grid.subdivisions) % grid.subdivisions;
      const beatNumber = Math.floor(gridIndex / grid.subdivisions);

      return {
        time: onset.time,
        offset: onset.offset,
        gridTime: onset.gridTime,
        amplitude: onset.amplitude,
        beatPosition,
        beatNumber,
        isDownbeat: beatPosition === 0,
        isUpbeat: beatPosition === 2,
        isSubdivision: beatPosition === 1 || beatPosition === 3
      };
    });
  }

  /**
   * Compute amplitude-weighted pocket metrics with breakdown by beat position.
   *
   * @param {Array} classifiedOnsets - onsets with beatPosition, amplitude, offset
   * @param {number} gridUnitMs - 16th-note grid spacing in ms
   * @returns {object|null}
   */
  function computeWeightedMetrics(classifiedOnsets, gridUnitMs) {
    if (classifiedOnsets.length === 0) return null;

    // Overall (amplitude-weighted)
    const totalAmp = classifiedOnsets.reduce((s, o) => s + o.amplitude, 0);
    const weightedAvg = classifiedOnsets.reduce((s, o) => s + o.offset * o.amplitude, 0) / totalAmp;
    const weightedVar = classifiedOnsets.reduce((s, o) => {
      return s + o.amplitude * (o.offset - weightedAvg) ** 2;
    }, 0) / totalAmp;
    const weightedStdDev = Math.sqrt(weightedVar);

    // Breakdown by position
    const downbeats = classifiedOnsets.filter(o => o.isDownbeat);
    const upbeats = classifiedOnsets.filter(o => o.isUpbeat);
    const subdivisions = classifiedOnsets.filter(o => o.isSubdivision);

    const downbeatMetrics = downbeats.length >= 4 ? computeSimpleSubMetrics(downbeats) : null;
    const upbeatMetrics = upbeats.length >= 4 ? computeSimpleSubMetrics(upbeats) : null;
    const subdivMetrics = subdivisions.length >= 4 ? computeSimpleSubMetrics(subdivisions) : null;

    // Rhythmic density: fraction of 16th-note slots used
    const durationMs = classifiedOnsets[classifiedOnsets.length - 1].time - classifiedOnsets[0].time;
    const totalGridSlots = Math.max(1, Math.round(durationMs / gridUnitMs));
    const density = classifiedOnsets.length / totalGridSlots;

    return {
      position: weightedAvg,
      consistency: weightedStdDev,
      onsetCount: classifiedOnsets.length,
      downbeats: downbeatMetrics,
      upbeats: upbeatMetrics,
      subdivisions: subdivMetrics,
      density,
      densityLabel: density > 0.7 ? 'Dense' : density > 0.4 ? 'Moderate' : 'Sparse'
    };
  }

  /**
   * Simple (unweighted) metrics for a subset of onsets.
   */
  function computeSimpleSubMetrics(onsets) {
    const offs = onsets.map(o => o.offset);
    const avg = offs.reduce((a, b) => a + b, 0) / offs.length;
    const sd = Math.sqrt(offs.reduce((a, b) => a + (b - avg) ** 2, 0) / offs.length);
    return { position: avg, consistency: sd, count: onsets.length };
  }

  /**
   * Compute swing factor from classified onsets.
   *
   * Swing measures how much the upbeat ("and") is displaced from the exact
   * midpoint between beats. Returns a ratio where:
   *   50% = perfectly straight (upbeat at exact midpoint)
   *   >50% = swung (upbeat delayed, "long-short" feel)
   *   67% = triplet swing (2:1 ratio)
   *
   * Method: For each upbeat onset, compare (downbeat→upbeat interval) vs
   * (upbeat→next downbeat interval) using actual onset times.
   *
   * @param {Array} classifiedOnsets - onsets with isDownbeat, isUpbeat, time, beatNumber
   * @returns {{ swingPercent: number, swingLabel: string, sampleCount: number } | null}
   */
  function computeSwingFactor(classifiedOnsets) {
    // Sort by time
    const sorted = [...classifiedOnsets].sort((a, b) => a.time - b.time);

    // Build lookup: beatNumber → downbeat onset time
    const downbeatByBeat = {};
    for (const o of sorted) {
      if (o.isDownbeat) {
        downbeatByBeat[o.beatNumber] = o.time;
      }
    }

    // For each upbeat, compute the long/short ratio
    const ratios = [];
    for (const o of sorted) {
      if (!o.isUpbeat) continue;

      const prevDownbeat = downbeatByBeat[o.beatNumber];
      const nextDownbeat = downbeatByBeat[o.beatNumber + 1];

      if (prevDownbeat == null || nextDownbeat == null) continue;

      const beatDuration = nextDownbeat - prevDownbeat;
      if (beatDuration < 100 || beatDuration > 2000) continue; // sanity check

      const longPart = o.time - prevDownbeat;   // downbeat → upbeat
      const shortPart = nextDownbeat - o.time;   // upbeat → next downbeat

      if (longPart <= 0 || shortPart <= 0) continue;

      const ratio = longPart / beatDuration; // 0.5 = straight, >0.5 = swung
      if (ratio > 0.3 && ratio < 0.8) {      // filter outliers
        ratios.push(ratio);
      }
    }

    if (ratios.length < 4) return null;

    // Trimmed mean (drop top/bottom 10%)
    ratios.sort((a, b) => a - b);
    const trim = Math.max(1, Math.floor(ratios.length * 0.1));
    const trimmed = ratios.slice(trim, ratios.length - trim);
    const avgRatio = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    const swingPercent = Math.round(avgRatio * 100);

    let swingLabel;
    if (swingPercent <= 52) swingLabel = 'Straight';
    else if (swingPercent <= 56) swingLabel = 'Light swing';
    else if (swingPercent <= 62) swingLabel = 'Medium swing';
    else if (swingPercent <= 68) swingLabel = 'Heavy swing (triplet feel)';
    else swingLabel = 'Extreme swing';

    return { swingPercent, swingLabel, sampleCount: trimmed.length };
  }

  return {
    computeOffset,
    computeLatencyOffset,
    computeSessionMetrics,
    maxOffsetMs,
    maxSubdivisionOffsetMs,
    cooldownSamples,
    classifyOnsets,
    computeWeightedMetrics,
    computeSwingFactor
  };
})();
