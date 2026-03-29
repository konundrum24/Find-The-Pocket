// ============================================
// pattern-grid.js — Repeating pattern detection for per-band analysis
//
// Detects the repeating rhythmic pattern of an instrument by
// building circular histograms at candidate cycle lengths (1, 2, 4, 8 beats),
// finding peaks, and scoring how well each pattern explains the onsets.
// Builds a pattern-specific grid for offset measurement.
// ============================================

const PatternGrid = (() => {

  const BIN_RESOLUTION = 1 / 16;               // one 16th note in beats
  const MATCH_RADIUS = BIN_RESOLUTION * 0.4;   // 40% of a 16th note
  const CANDIDATE_CYCLES = [1, 2, 4, 8];
  const MIN_COVERAGE = 0.5;
  const MIN_REPETITIONS = 3;

  // ── Step 1: Normalize onsets to beat-relative positions ──

  /**
   * Convert absolute-time onsets to fractional beat positions using local
   * anchor intervals. This factors out tempo drift before pattern detection.
   */
  function onsetsToBeatPositions(onsets, anchors) {
    if (anchors.length < 2) return [];

    const positions = [];
    let ai = 0; // anchor search cursor

    for (const onset of onsets) {
      // Advance cursor to find the anchor pair bracketing this onset
      while (ai < anchors.length - 2 && anchors[ai + 1].time <= onset.time) {
        ai++;
      }

      const anchorA = anchors[ai];
      const anchorB = anchors[ai + 1];

      // Skip onsets outside the anchor range
      if (onset.time < anchorA.time || onset.time > anchorB.time) continue;

      const localBeatMs = anchorB.time - anchorA.time;
      if (localBeatMs <= 0) continue;

      const fraction = (onset.time - anchorA.time) / localBeatMs;
      const beatPos = ai + fraction;

      positions.push({
        beatPosition: beatPos,
        time: onset.time,
        amplitude: onset.amplitude,
        localBeatMs: localBeatMs
      });
    }

    return positions;
  }

  // ── Step 2: Circular histogram ──

  function buildHistogram(beatPositions, cycleLength) {
    const numBins = Math.round(cycleLength / BIN_RESOLUTION);
    const bins = new Array(numBins).fill(0);       // amplitude-weighted
    const counts = new Array(numBins).fill(0);     // raw counts

    for (const pos of beatPositions) {
      let wrapped = pos.beatPosition % cycleLength;
      if (wrapped < 0) wrapped += cycleLength;
      let binIndex = Math.floor(wrapped / BIN_RESOLUTION);
      binIndex = Math.min(binIndex, numBins - 1);
      bins[binIndex] += pos.amplitude;
      counts[binIndex] += 1;
    }

    return { bins, counts, numBins, cycleLength };
  }

  // ── Step 3: Smooth and find peaks ──

  function smoothHistogram(bins) {
    const n = bins.length;
    const smoothed = new Array(n);
    for (let i = 0; i < n; i++) {
      const left = bins[(i - 1 + n) % n];
      const center = bins[i];
      const right = bins[(i + 1) % n];
      smoothed[i] = 0.25 * left + 0.5 * center + 0.25 * right;
    }
    return smoothed;
  }

  function findPeaks(smoothed, counts, minCount) {
    const n = smoothed.length;

    // Noise floor: mean + 0.5 * stddev
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      sum += smoothed[i];
      sumSq += smoothed[i] * smoothed[i];
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const stddev = Math.sqrt(Math.max(0, variance));
    const threshold = mean + 0.5 * stddev;

    const peaks = [];
    for (let i = 0; i < n; i++) {
      if (smoothed[i] <= threshold) continue;

      const left = smoothed[(i - 1 + n) % n];
      const right = smoothed[(i + 1) % n];
      if (smoothed[i] <= left || smoothed[i] <= right) continue;

      // Check raw onset count in neighborhood
      const neighborCount = counts[(i - 1 + n) % n] + counts[i] + counts[(i + 1) % n];
      if (neighborCount < minCount) continue;

      // Parabolic interpolation for sub-bin precision
      const alpha = smoothed[(i - 1 + n) % n];
      const beta = smoothed[i];
      const gamma = smoothed[(i + 1) % n];
      const denom = alpha - 2 * beta + gamma;
      let delta = 0;
      if (Math.abs(denom) > 1e-10) {
        delta = 0.5 * (alpha - gamma) / denom;
        delta = Math.max(-0.5, Math.min(0.5, delta));
      }

      const refinedBin = i + delta;
      const refinedPosition = refinedBin * BIN_RESOLUTION;

      peaks.push({
        position: refinedPosition,
        strength: smoothed[i],
        count: neighborCount
      });
    }

    return peaks;
  }

  // ── Step 4: Score a pattern ──

  function circularDistance(a, b, modulus) {
    const diff = Math.abs(a - b);
    return Math.min(diff, modulus - diff);
  }

  function scorePattern(beatPositions, peaks, cycleLength) {
    if (peaks.length === 0) return { score: -Infinity, coverageRatio: 0, noiseRatio: 1 };

    let explained = 0;
    let totalOffsetDist = 0;

    for (const pos of beatPositions) {
      let wrapped = pos.beatPosition % cycleLength;
      if (wrapped < 0) wrapped += cycleLength;

      let bestDist = Infinity;
      for (const peak of peaks) {
        const dist = circularDistance(wrapped, peak.position, cycleLength);
        if (dist < bestDist) bestDist = dist;
      }

      if (bestDist <= MATCH_RADIUS) {
        explained++;
        totalOffsetDist += bestDist;
      }
    }

    const coverageRatio = explained / beatPositions.length;
    const meanOffset = explained > 0 ? totalOffsetDist / explained : 0;

    // Complexity penalty: ratio of peaks to max possible 16th-note slots
    const maxSlots = cycleLength * 4; // 16th notes per cycle
    const complexityPenalty = peaks.length / maxSlots;

    const score = coverageRatio * 0.7
      - complexityPenalty * 0.2
      - (MATCH_RADIUS > 0 ? meanOffset / MATCH_RADIUS * 0.1 : 0);

    return {
      score,
      coverageRatio,
      noiseRatio: 1 - coverageRatio,
      meanOffset
    };
  }

  // ── Step 5: Detect the best pattern ──

  /**
   * Detect the repeating rhythmic pattern in an instrument's onsets.
   *
   * @param {Array<{time: number, amplitude: number}>} onsets
   * @param {Array} anchors - quarter-note beat anchors
   * @returns {object|null} pattern result, or null if no clear pattern found
   */
  function detectPattern(onsets, anchors) {
    const beatPositions = onsetsToBeatPositions(onsets, anchors);
    if (beatPositions.length < 6) return null;

    const firstBeat = beatPositions[0].beatPosition;
    const lastBeat = beatPositions[beatPositions.length - 1].beatPosition;
    const durationInBeats = lastBeat - firstBeat;

    let bestResult = null;

    for (const cycleLength of CANDIDATE_CYCLES) {
      const cycleRepetitions = Math.floor(durationInBeats / cycleLength);
      if (cycleRepetitions < MIN_REPETITIONS) continue;

      const histogram = buildHistogram(beatPositions, cycleLength);
      const smoothed = smoothHistogram(histogram.bins);
      const minCount = Math.max(3, Math.floor(cycleRepetitions * 0.3));
      const peaks = findPeaks(smoothed, histogram.counts, minCount);

      if (peaks.length === 0) {
        console.log('[Pattern] cycle=' + cycleLength + ': no peaks (minCount=' + minCount +
          ', reps=' + cycleRepetitions + ', beatPositions=' + beatPositions.length + ')');
        continue;
      }

      const result = scorePattern(beatPositions, peaks, cycleLength);
      result.cycleLength = cycleLength;
      result.positions = peaks.map(p => p.position).sort((a, b) => a - b);
      result.peaks = peaks;

      console.log('[Pattern] cycle=' + cycleLength + ': ' + peaks.length + ' peaks, coverage=' +
        Math.round(result.coverageRatio * 100) + '%, score=' + result.score.toFixed(3) +
        ', positions=[' + result.positions.map(p => p.toFixed(2)).join(', ') + ']');

      if (!bestResult || result.score > bestResult.score) {
        bestResult = result;
      }
    }

    // Reject if pattern doesn't explain enough onsets
    if (!bestResult || bestResult.coverageRatio < MIN_COVERAGE) {
      console.log('[Pattern] rejected: best coverage=' +
        (bestResult ? Math.round(bestResult.coverageRatio * 100) + '%' : 'none') +
        ' (need ' + Math.round(MIN_COVERAGE * 100) + '%)');
      return null;
    }

    return bestResult;
  }

  // ── Step 6: Build the pattern grid ──

  /**
   * Tile the detected pattern positions across the session using local tempo.
   */
  function buildPatternGrid(pattern, anchors, parentGrid) {
    const points = [];
    const numAnchors = anchors.length;

    for (let cycleStart = 0; cycleStart < numAnchors - 1; cycleStart += pattern.cycleLength) {
      for (const position of pattern.positions) {
        const anchorIdx = cycleStart + Math.floor(position);
        const fractionalBeat = position - Math.floor(position);

        if (anchorIdx >= numAnchors - 1) break;

        const anchorA = anchors[anchorIdx];
        const anchorB = anchors[anchorIdx + 1];
        const localBeatMs = anchorB.time - anchorA.time;

        points.push({
          time: anchorA.time + fractionalBeat * localBeatMs,
          beatPosition: Math.round(fractionalBeat * 4) % 4, // approximate 16th-note position
          localBeatMs: localBeatMs,
          localBpm: 60000 / localBeatMs,
          anchorIndex: anchorIdx,
          patternPosition: position
        });
      }
    }

    // Sort by time for efficient nearest-neighbor search
    points.sort((a, b) => a.time - b.time);

    return {
      points,
      subdivisions: 4, // maxOffset uses 16th-note unit for consistency
      medianGridUnitMs: parentGrid.medianGridUnitMs,
      pattern,
      parentGrid
    };
  }

  // ── Step 7: Match onsets to pattern grid ──

  /**
   * Binary search for the nearest point in a time-sorted array.
   */
  function findNearest(points, time) {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(points[lo - 1].time - time) < Math.abs(points[lo].time - time)) {
      best = lo - 1;
    }
    return points[best];
  }

  /**
   * Match onsets to a pattern grid. Uses the same maxOffset logic as
   * AdaptiveGrid.matchToAdaptiveGrid (35% of 16th-note unit).
   */
  function matchToPatternGrid(onsets, patternGrid) {
    const matched = [];
    const points = patternGrid.points;
    if (points.length === 0) return matched;

    for (const onset of onsets) {
      const nearest = findNearest(points, onset.time);

      const localGridUnit = nearest.localBeatMs / 4; // 16th note
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
          patternPosition: nearest.patternPosition,
          isDownbeat: nearest.beatPosition === 0,
          isUpbeat: nearest.beatPosition === 2,
          isSubdivision: nearest.beatPosition === 1 || nearest.beatPosition === 3
        });
      }
    }

    return matched;
  }

  return {
    detectPattern,
    buildPatternGrid,
    matchToPatternGrid,
    // Exposed for diagnostics/testing:
    onsetsToBeatPositions,
    buildHistogram,
    smoothHistogram,
    findPeaks,
    scorePattern,
    circularDistance
  };
})();
