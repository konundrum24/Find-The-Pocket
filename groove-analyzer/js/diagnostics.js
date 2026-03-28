// ============================================
// diagnostics.js — Grid accuracy diagnostic tool
//
// Measures onset detection accuracy and grid phase alignment.
// Answers: "Are my onsets accurate?" and "Is my grid in the right place?"
// ============================================

const Diagnostics = (() => {

  /**
   * Run full diagnostic analysis on a click-mode session.
   *
   * @param {Object[]} onsets - classified onsets with { time, offset, gridTime, amplitude }
   * @param {Object} grid - { points, gridUnitMs, beatMs, subdivisions }
   * @param {number} tempo - BPM
   * @param {number|null} latencyOffset - calibration offset in ms
   * @returns {Object} diagnostic report
   */
  function analyze(onsets, grid, tempo, latencyOffset) {
    const beatMs = grid.beatMs;
    const gridUnitMs = grid.gridUnitMs;
    const quarterNoteGrid = grid.points.filter((_, i) => i % grid.subdivisions === 0);

    // 1. Raw offset statistics (as currently computed)
    const offsets = onsets.map(o => o.offset);
    const currentMean = mean(offsets);
    const currentStd = std(offsets, currentMean);

    // 2. Phase sweep: test every possible phase shift and find the one
    //    that minimizes total squared error. This tells us if the grid
    //    is optimally placed or if a shift would improve alignment.
    const phaseSweep = sweepPhase(onsets, beatMs, gridUnitMs, grid.subdivisions);

    // 3. Circular statistics: compute the "true center" of onsets
    //    modulo the beat period. This is phase-independent.
    const circular = circularPhaseAnalysis(onsets, beatMs);

    // 4. Phase shift needed to optimally align grid
    const phaseErrorMs = phaseSweep.optimalShift;

    // 5. What the offsets WOULD look like with optimal phase
    const correctedOffsets = offsets.map(o => {
      let corrected = o - phaseErrorMs;
      // Wrap to nearest grid unit
      while (corrected > gridUnitMs / 2) corrected -= gridUnitMs;
      while (corrected < -gridUnitMs / 2) corrected += gridUnitMs;
      return corrected;
    });
    const correctedMean = mean(correctedOffsets);
    const correctedStd = std(correctedOffsets, correctedMean);

    // 6. Onset detection precision estimate
    //    If we correct for phase error, remaining std is detection noise + actual performance variance
    const detectionPrecision = correctedStd;

    // 7. Consistency check: split onsets into first half and second half,
    //    compare means. If the grid is drifting, these will diverge.
    const half = Math.floor(onsets.length / 2);
    const firstHalfMean = mean(offsets.slice(0, half));
    const secondHalfMean = mean(offsets.slice(half));
    const driftMs = secondHalfMean - firstHalfMean;

    // 8. Distribution symmetry: count ahead vs behind
    const aheadCount = offsets.filter(o => o < 0).length;
    const behindCount = offsets.filter(o => o > 0).length;
    const onBeatCount = offsets.filter(o => o === 0).length;

    // 9. After phase correction
    const correctedAhead = correctedOffsets.filter(o => o < -0.5).length;
    const correctedBehind = correctedOffsets.filter(o => o > 0.5).length;

    return {
      // Current state (what the app currently reports)
      current: {
        meanOffset: currentMean,
        stdDev: currentStd,
        aheadCount,
        behindCount,
        onBeatCount,
        totalOnsets: onsets.length
      },
      // Phase analysis
      phase: {
        optimalShiftMs: phaseErrorMs,
        currentPhaseError: Math.abs(phaseErrorMs),
        sweepData: phaseSweep.sweepData,
        currentTotalError: phaseSweep.currentError,
        optimalTotalError: phaseSweep.optimalError,
        improvementPercent: phaseSweep.currentError > 0
          ? ((1 - phaseSweep.optimalError / phaseSweep.currentError) * 100)
          : 0
      },
      // Circular stats (phase-independent ground truth)
      circular: {
        meanAngleDeg: circular.meanAngleDeg,
        meanOffsetMs: circular.meanOffsetMs,
        resultantLength: circular.resultantLength,
        concentrationLabel: circular.resultantLength > 0.9 ? 'Tight cluster'
          : circular.resultantLength > 0.7 ? 'Moderate cluster'
          : circular.resultantLength > 0.5 ? 'Loose cluster'
          : 'Dispersed (possible detection issues)'
      },
      // What results WOULD look like with optimal phase
      corrected: {
        meanOffset: correctedMean,
        stdDev: correctedStd,
        aheadCount: correctedAhead,
        behindCount: correctedBehind
      },
      // Drift detection
      drift: {
        firstHalfMean,
        secondHalfMean,
        driftMs,
        isDrifting: Math.abs(driftMs) > 3
      },
      // Verdict
      verdict: buildVerdict(phaseErrorMs, currentStd, correctedStd, circular.resultantLength, driftMs, gridUnitMs)
    };
  }

  /**
   * Sweep phase offsets to find optimal grid alignment.
   * Tests shifting all onset offsets by -halfBeat to +halfBeat
   * and measures total squared error at each shift.
   */
  function sweepPhase(onsets, beatMs, gridUnitMs, subdivisions) {
    const offsets = onsets.map(o => o.offset);
    const steps = 200;
    const halfGrid = gridUnitMs / 2;
    const sweepData = [];
    let bestShift = 0;
    let bestError = Infinity;

    // Current error (shift = 0)
    const currentError = offsets.reduce((sum, o) => sum + o * o, 0) / offsets.length;

    for (let i = 0; i <= steps; i++) {
      const shift = -halfGrid + (i / steps) * gridUnitMs;
      let totalSqError = 0;

      for (const o of offsets) {
        let shifted = o - shift;
        // Wrap to nearest grid point
        while (shifted > halfGrid) shifted -= gridUnitMs;
        while (shifted < -halfGrid) shifted += gridUnitMs;
        totalSqError += shifted * shifted;
      }

      const mse = totalSqError / offsets.length;
      sweepData.push({ shift, mse });

      if (mse < bestError) {
        bestError = mse;
        bestShift = shift;
      }
    }

    return {
      optimalShift: bestShift,
      currentError,
      optimalError: bestError,
      sweepData
    };
  }

  /**
   * Circular statistics for phase analysis.
   * Maps each onset's position within the beat cycle to an angle (0-2π),
   * then computes the circular mean and resultant length.
   *
   * The resultant length (0-1) measures clustering:
   * - 1.0 = all onsets at exactly the same phase
   * - 0.0 = uniformly distributed (no pattern)
   */
  function circularPhaseAnalysis(onsets, beatMs) {
    let sinSum = 0;
    let cosSum = 0;
    const n = onsets.length;

    for (const onset of onsets) {
      // Position within beat cycle (0 to beatMs)
      const phase = ((onset.time % beatMs) + beatMs) % beatMs;
      const angle = (phase / beatMs) * 2 * Math.PI;
      sinSum += Math.sin(angle);
      cosSum += Math.cos(angle);
    }

    sinSum /= n;
    cosSum /= n;

    const resultantLength = Math.sqrt(sinSum * sinSum + cosSum * cosSum);
    const meanAngle = Math.atan2(sinSum, cosSum);
    const meanAngleDeg = ((meanAngle * 180 / Math.PI) + 360) % 360;

    // Convert mean angle back to ms offset from beat
    let meanOffsetMs = (meanAngleDeg / 360) * beatMs;
    if (meanOffsetMs > beatMs / 2) meanOffsetMs -= beatMs;

    return { meanAngleDeg, meanOffsetMs, resultantLength };
  }

  /**
   * Build a human-readable diagnostic verdict.
   */
  function buildVerdict(phaseError, currentStd, correctedStd, resultantLength, drift, gridUnitMs) {
    const lines = [];
    const absPhase = Math.abs(phaseError);

    // Phase alignment assessment
    if (absPhase < 1) {
      lines.push('GRID PHASE: Excellent — grid is aligned within 1ms of optimal.');
    } else if (absPhase < 3) {
      lines.push(`GRID PHASE: Good — ${absPhase.toFixed(1)}ms from optimal. Minor improvement possible.`);
    } else if (absPhase < gridUnitMs * 0.2) {
      lines.push(`GRID PHASE: Moderate offset — ${absPhase.toFixed(1)}ms from optimal. This is shifting your ahead/behind distribution.`);
    } else {
      lines.push(`GRID PHASE: Significant misalignment — ${absPhase.toFixed(1)}ms from optimal. This is the primary source of measurement error.`);
    }

    // Improvement potential
    if (currentStd > correctedStd + 1) {
      const pct = ((1 - correctedStd / currentStd) * 100).toFixed(0);
      lines.push(`PHASE CORRECTION: Would improve consistency from ±${currentStd.toFixed(1)}ms to ±${correctedStd.toFixed(1)}ms (${pct}% tighter).`);
    }

    // Clustering assessment
    if (resultantLength > 0.85) {
      lines.push('ONSET CLUSTERING: Strong — onsets are tightly clustered in the beat cycle. Detection appears accurate.');
    } else if (resultantLength > 0.65) {
      lines.push('ONSET CLUSTERING: Moderate — some spread in onset positions. Could be performance variation or detection noise.');
    } else {
      lines.push('ONSET CLUSTERING: Weak — onsets are spread across the beat cycle. Possible onset detection issues or highly varied performance.');
    }

    // Drift assessment
    if (Math.abs(drift) > 5) {
      lines.push(`DRIFT: ${Math.abs(drift).toFixed(1)}ms drift detected between first and second half. Grid or performance may be shifting over time.`);
    } else {
      lines.push('DRIFT: Minimal — timing is stable across the session.');
    }

    return lines;
  }

  // ── Utility ──

  function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function std(arr, m) {
    if (arr.length < 2) return 0;
    if (m === undefined) m = mean(arr);
    const variance = arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
    return Math.sqrt(variance);
  }

  /**
   * Render the diagnostic panel HTML.
   * @param {Object} report - diagnostic analysis report
   * @param {number} gridUnitMs - grid unit duration
   * @param {number} [appliedCorrection] - phase correction that was applied (ms), if any
   */
  function renderPanel(report, gridUnitMs, appliedCorrection) {
    const r = report;
    const wasApplied = appliedCorrection != null && Math.abs(appliedCorrection) > 0.1;

    let html = '';

    // ── Phase Correction Banner ──
    if (wasApplied) {
      html += '<div class="diag-banner">';
      html += '<strong>Phase correction applied:</strong> grid shifted by ' +
        fmtMs(appliedCorrection) + ' using circular statistics. ';
      html += 'Results below reflect the corrected grid.';
      html += '</div>';
    }

    html += '<div class="diag-grid">';

    // ── Section 1: Post-Correction Alignment ──
    html += '<div class="diag-section">';
    html += '<h4>' + (wasApplied ? 'Corrected Grid Alignment' : 'Grid Alignment') + '</h4>';
    html += '<table class="diag-table">';
    if (wasApplied) {
      html += '<tr><th></th><th>After Correction</th></tr>';
      html += `<tr><td>Mean offset</td><td>${fmtMs(r.current.meanOffset)}</td></tr>`;
      html += `<tr><td>Consistency (±)</td><td>${Math.round(r.current.stdDev)}ms</td></tr>`;
      html += `<tr><td>Ahead / Behind</td><td>${r.current.aheadCount} / ${r.current.behindCount}</td></tr>`;
    } else {
      html += '<tr><th></th><th>Current</th><th>Phase-Corrected</th></tr>';
      html += `<tr><td>Mean offset</td><td>${fmtMs(r.current.meanOffset)}</td><td>${fmtMs(r.corrected.meanOffset)}</td></tr>`;
      html += `<tr><td>Consistency (±)</td><td>${Math.round(r.current.stdDev)}ms</td><td>${Math.round(r.corrected.stdDev)}ms</td></tr>`;
      html += `<tr><td>Ahead / Behind</td><td>${r.current.aheadCount} / ${r.current.behindCount}</td><td>${r.corrected.aheadCount} / ${r.corrected.behindCount}</td></tr>`;
    }
    html += '</table>';
    if (wasApplied) {
      const residual = Math.abs(r.phase.optimalShiftMs);
      if (residual < 2) {
        html += '<div class="diag-ok">Residual phase error: ' + residual.toFixed(1) + 'ms (excellent)</div>';
      } else {
        html += '<div class="diag-note">Residual phase error: ' + residual.toFixed(1) + 'ms</div>';
      }
    } else {
      const phaseDir = r.phase.optimalShiftMs > 0 ? 'late (grid needs to shift later)' : 'early (grid needs to shift earlier)';
      html += `<div class="diag-note">Grid phase error: <strong>${Math.abs(r.phase.optimalShiftMs).toFixed(1)}ms</strong> ${phaseDir}</div>`;
      if (r.phase.improvementPercent > 5) {
        html += `<div class="diag-highlight">Phase correction would reduce error by ${Math.round(r.phase.improvementPercent)}%</div>`;
      }
    }
    html += '</div>';

    // ── Section 2: Circular Stats ──
    html += '<div class="diag-section">';
    html += '<h4>Onset Clustering (Phase-Independent)</h4>';
    html += `<div class="diag-meter">`;
    html += `<div class="diag-meter-bar" style="width:${(r.circular.resultantLength * 100).toFixed(0)}%"></div>`;
    html += `</div>`;
    html += `<div class="diag-meter-label">Cluster strength: <strong>${(r.circular.resultantLength * 100).toFixed(0)}%</strong> — ${r.circular.concentrationLabel}</div>`;
    html += `<div class="diag-note">True center of mass: ${fmtMs(r.circular.meanOffsetMs)} from beat</div>`;
    html += '</div>';

    // ── Section 3: Drift ──
    html += '<div class="diag-section">';
    html += '<h4>Timing Stability</h4>';
    html += `<div class="diag-drift">`;
    html += `<span>1st half avg: ${fmtMs(r.drift.firstHalfMean)}</span>`;
    html += `<span class="diag-arrow">\u2192</span>`;
    html += `<span>2nd half avg: ${fmtMs(r.drift.secondHalfMean)}</span>`;
    html += `</div>`;
    if (r.drift.isDrifting) {
      html += `<div class="diag-warn">Drift detected: ${Math.abs(r.drift.driftMs).toFixed(1)}ms shift over session</div>`;
    } else {
      html += `<div class="diag-ok">Stable — minimal drift (${Math.abs(r.drift.driftMs).toFixed(1)}ms)</div>`;
    }
    html += '</div>';

    html += '</div>'; // end diag-grid

    // ── Section 4: Phase Sweep Chart ──
    html += '<div class="diag-section diag-section--wide">';
    html += '<h4>Phase Sweep — Residual Error vs. Grid Shift</h4>';
    html += '<canvas id="diag-phase-canvas" class="diag-canvas"></canvas>';
    if (wasApplied) {
      html += '<div class="diag-note">Shows residual error after phase correction. The dip near center confirms the correction was effective.</div>';
    } else {
      html += '<div class="diag-note">The dip shows the optimal grid position. Distance from center (0ms) = current phase error.</div>';
    }
    html += '</div>';

    // ── Section 5: Verdict ──
    html += '<div class="diag-section diag-section--wide diag-verdict">';
    html += '<h4>Diagnostic Verdict</h4>';
    html += r.verdict.map(line => {
      const isGood = line.includes('Excellent') || line.includes('Strong') || line.includes('Minimal') || line.includes('Good');
      const isBad = line.includes('Significant') || line.includes('Weak') || line.includes('Drift:') && line.includes('detected');
      const cls = isGood ? 'diag-good' : isBad ? 'diag-bad' : 'diag-neutral';
      return `<div class="${cls}">${line}</div>`;
    }).join('');
    html += '</div>';

    return html;
  }

  /**
   * Draw the phase sweep chart on a canvas.
   */
  function drawPhaseSweepChart(canvasId, sweepData, optimalShift) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 10, right: 20, bottom: 30, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Find data bounds
    const maxMSE = Math.max(...sweepData.map(d => d.mse));
    const minMSE = Math.min(...sweepData.map(d => d.mse));
    const minShift = sweepData[0].shift;
    const maxShift = sweepData[sweepData.length - 1].shift;

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    // Zero line (current grid position)
    const zeroX = pad.left + ((0 - minShift) / (maxShift - minShift)) * plotW;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(zeroX, pad.top);
    ctx.lineTo(zeroX, pad.top + plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw error curve
    ctx.beginPath();
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    for (let i = 0; i < sweepData.length; i++) {
      const d = sweepData[i];
      const x = pad.left + ((d.shift - minShift) / (maxShift - minShift)) * plotW;
      const y = pad.top + plotH - ((d.mse - minMSE) / (maxMSE - minMSE || 1)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Mark optimal point
    const optX = pad.left + ((optimalShift - minShift) / (maxShift - minShift)) * plotW;
    const optY = pad.top + plotH - ((minMSE - minMSE) / (maxMSE - minMSE || 1)) * plotH;
    ctx.beginPath();
    ctx.arc(optX, optY, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#4ecdc4';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Labels
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('0ms (current)', zeroX, pad.top + plotH + 15);
    ctx.fillStyle = '#4ecdc4';
    ctx.fillText(`${optimalShift.toFixed(1)}ms (optimal)`, optX, optY - 12);

    // Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'left';
    ctx.fillText('← shift earlier', pad.left, pad.top + plotH + 25);
    ctx.textAlign = 'right';
    ctx.fillText('shift later →', w - pad.right, pad.top + plotH + 25);

    // Y axis
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('Mean Squared Error', 0, 0);
    ctx.restore();
  }

  function fmtMs(ms) {
    return (ms >= 0 ? '+' : '') + ms.toFixed(1) + 'ms';
  }

  return { analyze, renderPanel, drawPhaseSweepChart };
})();
