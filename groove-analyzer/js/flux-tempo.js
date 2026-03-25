// ============================================
// flux-tempo.js — Autocorrelation-based tempo from spectral flux envelope
//
// Instead of detecting individual onsets and measuring their intervals,
// this module autocorrelates the raw spectral flux envelope to find
// the dominant periodicity. This decouples tempo detection from onset
// detection — sensitivity settings and speaker quality affect which
// individual onsets are detected, but the continuous flux envelope
// (and therefore the tempo estimate) remains stable.
//
// Based on the approach used by The Echo Nest / Spotify and the
// Dan Ellis (2007) "Beat Tracking by Dynamic Programming" paper.
// ============================================

const FluxTempo = (() => {

  /**
   * Estimate tempo by autocorrelating the spectral flux envelope.
   *
   * The approach:
   * 1. Autocorrelate the flux signal to find all periodicities
   * 2. Apply a strong perceptual tempo prior (Rayleigh distribution)
   * 3. Use harmonic enhancement to reinforce beat-level vs subdivision
   * 4. Explicit octave resolution as final step
   *
   * @param {Array<{time: number, flux: number}>} frames - flux envelope
   * @param {number} frameRate - frames per second
   * @returns {Object} { bpm, confidence, allPeaks, debug }
   */
  function estimateTempo(frames, frameRate) {
    if (!frames || frames.length < 100) {
      return { bpm: null, confidence: 0, allPeaks: [], debug: { reason: 'too few frames' } };
    }

    const flux = frames.map(f => f.flux);

    // Subtract mean to center the signal
    const mean = flux.reduce((s, v) => s + v, 0) / flux.length;
    const centered = flux.map(v => v - mean);

    // Lag range: 30–220 BPM
    const minBpm = 30;
    const maxBpm = 220;
    const minLag = Math.floor(frameRate * 60 / maxBpm);
    const maxLag = Math.ceil(frameRate * 60 / minBpm);
    const effectiveMaxLag = Math.min(maxLag, Math.floor(centered.length / 2));

    if (effectiveMaxLag <= minLag) {
      return { bpm: null, confidence: 0, allPeaks: [], debug: { reason: 'recording too short' } };
    }

    // ── Step 1: Raw autocorrelation ──
    const acf = new Float64Array(effectiveMaxLag + 1);
    const n = centered.length;

    let acfZero = 0;
    for (let i = 0; i < n; i++) acfZero += centered[i] * centered[i];

    for (let lag = minLag; lag <= effectiveMaxLag; lag++) {
      let sum = 0;
      const limit = n - lag;
      for (let i = 0; i < limit; i++) {
        sum += centered[i] * centered[i + lag];
      }
      acf[lag] = acfZero > 0 ? sum / acfZero : 0;
    }

    // ── Step 2: Perceptual tempo prior (Rayleigh distribution) ──
    // Standard MIR approach: strong bias toward ~100–120 BPM.
    // Rayleigh peaks at the mode and decays quickly on both sides.
    // Mode = 110 BPM, sigma = 40 BPM.
    // This is applied as a MULTIPLIER, not a gentle blend — tempos
    // far from the preferred range must be dramatically stronger to win.
    const weighted = new Float64Array(acf.length);
    for (let lag = minLag; lag <= effectiveMaxLag; lag++) {
      const bpm = frameRate * 60 / lag;
      // Rayleigh-like: peaks at 110, decays as distance^2
      const dist = bpm - 110;
      const sigma = 45;
      const prior = Math.exp(-(dist * dist) / (2 * sigma * sigma));
      // Floor at 0.25 so extreme tempos aren't completely zeroed out
      weighted[lag] = acf[lag] * Math.max(0.25, prior);
    }

    // ── Step 3: Harmonic enhancement ──
    // Multiply each lag's score by the score at 2x that lag (if in range).
    // This reinforces beat-level periods (which have matching half-note
    // periodicity at 2x lag) and suppresses subdivision-level periods
    // (whose 2x lag points to the beat level, not their own harmonic).
    //
    // The product of ACF(lag) * ACF(2*lag) is high when BOTH the candidate
    // period and its double are periodic. For the beat level, 2*lag is the
    // half-note — which exists. For eighth notes, 2*lag is the quarter note
    // — which also exists but is a DIFFERENT metric level, meaning the
    // product spreads the eighth-note's energy toward the quarter note.
    const enhanced = new Float64Array(weighted.length);
    for (let lag = minLag; lag <= effectiveMaxLag; lag++) {
      const doubleLag = lag * 2;
      let harmonicBoost = 1.0;
      if (doubleLag <= effectiveMaxLag && acf[doubleLag] > 0) {
        // Geometric mean: sqrt(ACF[lag] * ACF[2*lag])
        // Only boost, never penalize
        harmonicBoost = 1.0 + Math.max(0, acf[doubleLag]);
      }
      enhanced[lag] = weighted[lag] * harmonicBoost;
    }

    // ── Step 4: Find peaks ──
    const peaks = [];
    for (let lag = minLag + 1; lag < effectiveMaxLag; lag++) {
      if (enhanced[lag] > enhanced[lag - 1] && enhanced[lag] > enhanced[lag + 1]) {
        const bpm = frameRate * 60 / lag;
        peaks.push({
          lag,
          bpm: Math.round(bpm * 10) / 10,
          strength: enhanced[lag],
          rawStrength: acf[lag],
          weightedStrength: weighted[lag]
        });
      }
    }

    peaks.sort((a, b) => b.strength - a.strength);

    if (peaks.length === 0) {
      return { bpm: null, confidence: 0, allPeaks: [], debug: { reason: 'no autocorrelation peaks' } };
    }

    // ── Step 5: Explicit octave resolution ──
    // Even after weighting and harmonic enhancement, the subdivision
    // peak can still win. Apply a direct octave check:
    // If the best peak is above 150 BPM, and a peak near half that BPM
    // exists with raw strength >= 40% of the best's raw strength, take it.
    // This is the standard octave resolution used in Ellis (2007).
    let best = peaks[0];
    if (best.bpm > 150) {
      const halfBpm = best.bpm / 2;
      const halfPeak = peaks.find(p =>
        Math.abs(p.bpm - halfBpm) / halfBpm < 0.10
      );
      if (halfPeak && halfPeak.rawStrength >= best.rawStrength * 0.35) {
        console.log('[FluxTempo] Octave resolution: ' + best.bpm + ' BPM → ' +
          halfPeak.bpm + ' BPM (half-peak raw=' + halfPeak.rawStrength.toFixed(4) +
          ' vs best raw=' + best.rawStrength.toFixed(4) + ', ratio=' +
          (halfPeak.rawStrength / best.rawStrength).toFixed(3) + ')');
        best = halfPeak;
      }
    }
    // Also check: if best is above 120 and there's a strong peak at half
    // that is in the 55-100 range (common for funk, hip-hop, R&B, dub)
    if (best.bpm > 120) {
      const halfBpm = best.bpm / 2;
      if (halfBpm >= 50 && halfBpm <= 110) {
        const halfPeak = peaks.find(p =>
          Math.abs(p.bpm - halfBpm) / halfBpm < 0.10
        );
        if (halfPeak && halfPeak.rawStrength >= best.rawStrength * 0.5) {
          console.log('[FluxTempo] Octave resolution (120+ check): ' + best.bpm +
            ' BPM → ' + halfPeak.bpm + ' BPM');
          best = halfPeak;
        }
      }
    }

    // Confidence
    const strengths = peaks.map(p => p.strength).sort((a, b) => a - b);
    const medianStrength = strengths[Math.floor(strengths.length / 2)] || 0.001;
    const confidence = Math.min(1, best.strength / (medianStrength * 3));

    console.log('[FluxTempo] Autocorrelation peaks (top 10):');
    peaks.slice(0, 10).forEach((p, i) => {
      const marker = (p === best) ? ' ← BEST' : '';
      console.log('  #' + (i + 1) + ': ' + p.bpm + ' BPM (lag=' + p.lag +
        ', enhanced=' + p.strength.toFixed(4) +
        ', weighted=' + p.weightedStrength.toFixed(4) +
        ', raw=' + p.rawStrength.toFixed(4) + ')' + marker);
    });
    console.log('[FluxTempo] Result: ' + best.bpm + ' BPM, confidence: ' +
      confidence.toFixed(3));

    return {
      bpm: best.bpm,
      confidence,
      allPeaks: peaks.slice(0, 20),
      debug: {
        frameCount: frames.length,
        frameRate: Math.round(frameRate),
        durationSec: Math.round(frames.length / frameRate * 10) / 10,
        lagRange: [minLag, effectiveMaxLag],
        peakCount: peaks.length,
        bestLag: best.lag,
        bestBpm: best.bpm,
        bestStrength: best.strength,
        bestRaw: best.rawStrength
      }
    };
  }

  /**
   * Resolve metric level from autocorrelation peaks.
   * Called after estimateTempo — provides a second pass that examines
   * harmonic relationships between peaks.
   *
   * @param {Array} peaks - from estimateTempo().allPeaks
   * @returns {Object} { bpm, confidence, label }
   */
  function resolveMetricLevel(peaks) {
    if (!peaks || peaks.length === 0) return null;

    const top = peaks.slice(0, 15);

    const scored = top.map(peak => {
      let score = peak.strength;

      // Does this peak have a subdivision (peak at 2x this BPM)?
      const subPeak = top.find(p =>
        Math.abs(p.bpm / peak.bpm - 2) < 0.10
      );
      // Having a subdivision is STRONG evidence this is the beat level.
      // The beat always has subdivisions; subdivisions don't have sub-subdivisions
      // as reliably.
      if (subPeak) score += subPeak.strength * 0.5;

      // Does this peak have a grouping (peak at 0.5x this BPM)?
      const grpPeak = top.find(p =>
        Math.abs(peak.bpm / p.bpm - 2) < 0.10
      );
      if (grpPeak) score += grpPeak.strength * 0.3;

      // Does this peak have a triple subdivision (compound meter)?
      const triPeak = top.find(p =>
        Math.abs(p.bpm / peak.bpm - 3) < 0.10
      );
      if (triPeak) score += triPeak.strength * 0.2;

      // Strong BPM range prior: 55–160 is normal beat range.
      // Outside this, the score gets cut significantly.
      let rangeFactor;
      if (peak.bpm >= 55 && peak.bpm <= 160) {
        rangeFactor = 1.0;
      } else if (peak.bpm >= 45 && peak.bpm <= 180) {
        rangeFactor = 0.6;
      } else {
        rangeFactor = 0.3;
      }

      return {
        ...peak,
        harmonicScore: score * rangeFactor,
        hasSubdivision: !!subPeak,
        hasGrouping: !!grpPeak,
        rangeFactor
      };
    });

    scored.sort((a, b) => b.harmonicScore - a.harmonicScore);
    const winner = scored[0];

    // Label relative to the raw strongest peak
    let label = 'flux-primary';
    const rawBest = peaks[0];
    const ratio = winner.bpm / rawBest.bpm;
    if (Math.abs(ratio - 0.5) < 0.10) label = 'flux-half-time';
    else if (Math.abs(ratio - 2.0) < 0.10) label = 'flux-double-time';
    else if (Math.abs(ratio - 0.25) < 0.10) label = 'flux-quarter-time';

    console.log('[FluxTempo] Metric level resolution:');
    scored.slice(0, 6).forEach((s, i) => {
      const marker = i === 0 ? ' ← SELECTED' : '';
      console.log('  ' + s.bpm + ' BPM | enhanced=' + s.strength.toFixed(4) +
        ' | harmonic=' + s.harmonicScore.toFixed(4) +
        ' | sub=' + s.hasSubdivision + ' grp=' + s.hasGrouping +
        ' | range=' + s.rangeFactor + marker);
    });

    return {
      bpm: winner.bpm,
      confidence: winner.harmonicScore,
      label,
      debug: scored.slice(0, 8)
    };
  }

  return {
    estimateTempo,
    resolveMetricLevel
  };

})();
