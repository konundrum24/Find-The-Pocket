// ============================================
// visualizations.js — Canvas drawing
//   Pocket Landing, Session Timeline, Tempo Curve, Progress Chart
// ============================================

const Visualizations = (() => {
  const COLORS = {
    surface: '#161920',
    gridLine: 'rgba(232, 230, 222, 0.2)',
    gridMinor: 'rgba(232, 230, 222, 0.05)',
    label: '#6B6960',
    dot: 'rgba(139, 127, 212, ',
    dotSolid: '#8B7FD4',
    avgStroke: '#fff',
    spreadStroke: 'rgba(139, 127, 212, 0.3)',
    trendLine: 'rgba(29, 158, 117, 0.75)',
    teal: '#1D9E75',
    purple: '#8B7FD4',
    amber: '#BA7517',
    coral: '#D85A30',
    targetZone: 'rgba(139, 127, 212, 0.1)',
    targetBorder: 'rgba(139, 127, 212, 0.3)'
  };

  // Approximate Gaussian random using Box-Muller (mean=0, sd=1)
  function gaussRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function setupCanvas(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const W = rect.width;
    const H = height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, W, H };
  }

  /**
   * Draw the Pocket Landing visualization.
   * @param {object} [target] - optional pocket target { positionMin, positionMax }
   * @param {boolean} [hasClassification] - if true, onsets have beatPosition info
   */
  function drawPocketLanding(canvas, offsets, avg, sd, target, onsets) {
    const hasClassification = onsets && onsets.length > 0 && onsets[0].isDownbeat !== undefined;
    const H = hasClassification ? 120 : 80; // extra height for legend + more Y spread
    const { ctx: x, W } = setupCanvas(canvas, H);

    const offsetValues = hasClassification ? onsets.map(o => o.offset) : offsets;
    const maxAbs = Math.max(
      Math.abs(Math.min(...offsetValues)),
      Math.abs(Math.max(...offsetValues)),
      target ? Math.max(Math.abs(target.positionMin), Math.abs(target.positionMax)) + 5 : 20,
      20
    );
    const range = Math.min(50, Math.ceil(maxAbs / 5) * 5 + 5);
    const cx = W / 2;
    const pxPerMs = (W * 0.43) / range;
    const legendH = hasClassification ? 15 : 0;

    // Background
    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    // Target zone (if provided)
    if (target) {
      const zoneLeft = cx + target.positionMin * pxPerMs;
      const zoneRight = cx + target.positionMax * pxPerMs;
      x.fillStyle = COLORS.targetZone;
      x.fillRect(zoneLeft, 4, zoneRight - zoneLeft, H - 20 - legendH);
      x.strokeStyle = COLORS.targetBorder;
      x.lineWidth = 1;
      x.setLineDash([4, 4]);
      x.strokeRect(zoneLeft, 4, zoneRight - zoneLeft, H - 20 - legendH);
      x.setLineDash([]);
    }

    // Center grid line
    x.strokeStyle = COLORS.gridLine;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(cx, 8);
    x.lineTo(cx, H - 16 - legendH);
    x.stroke();

    // Minor grid lines every 10ms
    for (let ms = -50; ms <= 50; ms += 10) {
      if (ms === 0) continue;
      const xx = cx + ms * pxPerMs;
      if (xx < 8 || xx > W - 8) continue;
      x.strokeStyle = COLORS.gridMinor;
      x.beginPath();
      x.moveTo(xx, 14);
      x.lineTo(xx, H - 18 - legendH);
      x.stroke();
    }

    // Axis labels
    x.fillStyle = COLORS.label;
    x.font = '9px DM Sans';
    x.textAlign = 'center';
    x.fillText('Ahead', W * 0.08, H - 3 - legendH);
    x.fillText('Grid', cx, H - 3 - legendH);
    x.fillText('Behind', W * 0.92, H - 3 - legendH);

    // Onset dots — with beat position distinction if classified
    const dy = (H - legendH) / 2 - 2;
    if (hasClassification) {
      onsets.forEach(o => {
        // Small X jitter (±1ms equivalent) to break up quantized columns
        const xJitter = gaussRandom() * pxPerMs * 0.8;
        const xx = cx + o.offset * pxPerMs + xJitter;
        if (xx < 3 || xx > W - 3) return;

        let radius, color;
        if (o.isDownbeat) {
          radius = 3; color = 'rgba(29, 158, 117, 0.6)';
        } else if (o.isUpbeat) {
          radius = 2.5; color = 'rgba(139, 127, 212, 0.4)';
        } else {
          radius = 2; color = 'rgba(186, 117, 23, 0.4)';
        }

        // Gaussian Y spread for natural cloud shape
        const yJitter = gaussRandom() * 14;
        x.beginPath();
        x.arc(xx, dy + yJitter, radius, 0, Math.PI * 2);
        x.fillStyle = color;
        x.fill();
      });

      // Legend
      const legendY = H - 5;
      x.font = '8px DM Sans';
      x.textAlign = 'left';
      // Downbeats
      x.beginPath(); x.arc(W * 0.15, legendY - 3, 3, 0, Math.PI * 2);
      x.fillStyle = COLORS.teal; x.fill();
      x.fillStyle = COLORS.label; x.fillText('Downbeats', W * 0.15 + 6, legendY);
      // Upbeats
      x.beginPath(); x.arc(W * 0.42, legendY - 3, 2.5, 0, Math.PI * 2);
      x.fillStyle = COLORS.purple; x.fill();
      x.fillStyle = COLORS.label; x.fillText('Upbeats', W * 0.42 + 6, legendY);
      // Ghost notes
      x.beginPath(); x.arc(W * 0.66, legendY - 3, 2, 0, Math.PI * 2);
      x.fillStyle = COLORS.amber; x.fill();
      x.fillStyle = COLORS.label; x.fillText('Ghost notes', W * 0.66 + 5, legendY);
    } else {
      offsetValues.forEach((o, i) => {
        const xJitter = gaussRandom() * pxPerMs * 0.8;
        const xx = cx + o * pxPerMs + xJitter;
        if (xx < 3 || xx > W - 3) return;
        const alpha = 0.3 + (i / offsetValues.length) * 0.4;
        const yJitter = gaussRandom() * 10;
        x.beginPath();
        x.arc(xx, dy + yJitter, 2.5, 0, Math.PI * 2);
        x.fillStyle = COLORS.dot + alpha + ')';
        x.fill();
      });
    }

    // Average marker and spread ellipse
    const ax = cx + avg * pxPerMs;
    if (ax > 4 && ax < W - 4) {
      x.beginPath();
      x.arc(ax, dy, 7, 0, Math.PI * 2);

      if (target) {
        const inZone = avg >= target.positionMin && avg <= target.positionMax;
        const dist = inZone ? 0 :
          avg < target.positionMin ? target.positionMin - avg : avg - target.positionMax;
        x.fillStyle = inZone ? COLORS.teal : dist < 10 ? COLORS.amber : COLORS.coral;
      } else {
        x.fillStyle = COLORS.dotSolid;
      }
      x.fill();
      x.strokeStyle = COLORS.avgStroke;
      x.lineWidth = 2;
      x.stroke();

      x.setLineDash([3, 3]);
      x.strokeStyle = COLORS.spreadStroke;
      x.lineWidth = 1;
      x.beginPath();
      x.ellipse(ax, dy, Math.min(sd * pxPerMs, W / 2 - 10), 11, 0, 0, Math.PI * 2);
      x.stroke();
      x.setLineDash([]);
    }
  }

  /**
   * Draw a compact per-band Pocket Landing scatter.
   * Shows onset distribution, average marker, and spread ellipse in band color.
   */
  function drawBandPocketLanding(canvas, onsets, bandName, avg, sd) {
    const H = window.innerWidth < 900 ? 44 : 50;
    const { ctx: x, W } = setupCanvas(canvas, H);
    if (!onsets || !onsets.length) return;

    const colors = BAND_COLORS[bandName] || { dot: COLORS.dot + '0.55)', label: COLORS.label };
    const offsets = onsets.map(o => o.offset);
    const maxAbs = Math.max(Math.abs(Math.min(...offsets)), Math.abs(Math.max(...offsets)), 20);
    const range = Math.ceil(maxAbs / 5) * 5 + 5;
    const cx = W / 2;
    const pxPerMs = (W * 0.43) / range;
    const dy = H / 2;

    // Background
    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    // Center grid line
    x.strokeStyle = COLORS.gridLine;
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(cx, 6); x.lineTo(cx, H - 6); x.stroke();

    // Minor grid lines every 10ms
    for (let ms = -50; ms <= 50; ms += 10) {
      if (ms === 0) continue;
      const xx = cx + ms * pxPerMs;
      if (xx < 4 || xx > W - 4) continue;
      x.strokeStyle = COLORS.gridMinor;
      x.beginPath(); x.moveTo(xx, 10); x.lineTo(xx, H - 10); x.stroke();
    }

    // Axis labels
    x.fillStyle = COLORS.label;
    x.font = '7px DM Sans';
    x.textAlign = 'center';
    x.fillText('Ahead', W * 0.08, H - 1);
    x.fillText('Behind', W * 0.92, H - 1);

    // Onset dots with band color — Gaussian jitter for natural scatter
    onsets.forEach(o => {
      const xJitter = gaussRandom() * pxPerMs * 0.8;
      const xx = cx + o.offset * pxPerMs + xJitter;
      if (xx < 2 || xx > W - 2) return;
      const yJitter = gaussRandom() * 8;
      x.beginPath();
      x.arc(xx, dy + yJitter, 1.5, 0, Math.PI * 2);
      x.fillStyle = colors.dot;
      x.fill();
    });

    // Average marker
    const ax = cx + avg * pxPerMs;
    if (ax > 4 && ax < W - 4) {
      // Spread ellipse
      x.setLineDash([3, 3]);
      x.strokeStyle = colors.dot.replace(/[\d.]+\)$/, '0.3)');
      x.lineWidth = 1;
      x.beginPath();
      x.ellipse(ax, dy, Math.min(sd * pxPerMs, W / 2 - 10), 10, 0, 0, Math.PI * 2);
      x.stroke();
      x.setLineDash([]);

      // Avg dot
      x.beginPath();
      x.arc(ax, dy, 5, 0, Math.PI * 2);
      x.fillStyle = colors.label;
      x.fill();
      x.strokeStyle = COLORS.avgStroke;
      x.lineWidth = 1.5;
      x.stroke();
    }
  }

  /**
   * Draw the Session Timeline scatter plot.
   * Supports beat position visual distinction when onsets have classification.
   */
  function drawTimeline(canvas, onsets) {
    const mobileH = window.innerWidth < 900 ? 120 : 150;
    const { ctx: x, W, H } = setupCanvas(canvas, mobileH);
    if (!onsets.length) return;

    const hasClassification = onsets[0].isDownbeat !== undefined;
    const offsets = onsets.map(o => o.offset);
    const maxAbs = Math.max(Math.abs(Math.min(...offsets)), Math.abs(Math.max(...offsets)), 15);
    const offsetRange = Math.ceil(maxAbs / 5) * 5 + 5;
    const maxTime = onsets[onsets.length - 1].time;

    const pL = 35, pR = 10, pT = 10, pB = 20;
    const pW = W - pL - pR, pH = H - pT - pB, cY = pT + pH / 2;

    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    x.strokeStyle = 'rgba(232, 230, 222, 0.15)';
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(pL, cY); x.lineTo(W - pR, cY); x.stroke();

    x.fillStyle = COLORS.label;
    x.font = '8px DM Sans';
    x.textAlign = 'right';
    x.fillText('Ahead', pL - 4, pT + 10);
    x.fillText('0ms', pL - 4, cY + 3);
    x.fillText('Behind', pL - 4, H - pB - 2);

    // Onset dots — with beat position distinction if classified
    onsets.forEach(o => {
      const xx = pL + (o.time / maxTime) * pW;
      const yy = cY + (o.offset / offsetRange) * (pH / 2);

      let radius, color;
      if (hasClassification) {
        if (o.isDownbeat) { radius = 3; color = 'rgba(29, 158, 117, 0.6)'; }
        else if (o.isUpbeat) { radius = 2.5; color = 'rgba(139, 127, 212, 0.4)'; }
        else { radius = 2; color = 'rgba(186, 117, 23, 0.4)'; }
      } else {
        radius = 2.5; color = COLORS.dot + '0.55)';
      }

      x.beginPath();
      x.arc(xx, yy, radius, 0, Math.PI * 2);
      x.fillStyle = color;
      x.fill();
    });

    // Rolling average trend line — use downbeats only if classified
    const trendSource = hasClassification
      ? onsets.filter(o => o.isDownbeat)
      : onsets;

    if (trendSource.length > 4) {
      const ws = Math.min(6, Math.floor(trendSource.length / 3));
      x.beginPath();
      x.strokeStyle = COLORS.trendLine;
      x.lineWidth = 1.5;
      for (let i = ws; i < trendSource.length; i++) {
        const w = trendSource.slice(i - ws, i);
        const avgOff = w.reduce((s, o) => s + o.offset, 0) / w.length;
        const xx = pL + (trendSource[i].time / maxTime) * pW;
        const yy = cY + (avgOff / offsetRange) * (pH / 2);
        if (i === ws) x.moveTo(xx, yy); else x.lineTo(xx, yy);
      }
      x.stroke();
    }
  }

  // Band-specific colors for per-band timelines
  const BAND_COLORS = {
    subLow: { dot: 'rgba(29, 158, 117, 0.6)',  trend: 'rgba(29, 158, 117, 0.75)',  label: '#1D9E75' },  // teal
    low:    { dot: 'rgba(64, 180, 150, 0.6)',   trend: 'rgba(64, 180, 150, 0.75)',  label: '#40B496' },  // light teal
    lowMid: { dot: 'rgba(139, 127, 212, 0.6)', trend: 'rgba(139, 127, 212, 0.75)', label: '#8B7FD4' },  // purple
    mid:    { dot: 'rgba(186, 117, 23, 0.6)',   trend: 'rgba(186, 117, 23, 0.75)',  label: '#BA7517' },  // amber
    high:   { dot: 'rgba(216, 90, 48, 0.6)',    trend: 'rgba(216, 90, 48, 0.75)',   label: '#D85A30' }   // coral
  };

  /**
   * Draw a compact per-band Session Timeline.
   * Same scatter plot concept but shorter, with band color and label.
   */
  function drawBandTimeline(canvas, onsets, bandName, bandLabel, maxTime) {
    const { ctx: x, W, H } = setupCanvas(canvas, 100);
    if (!onsets || !onsets.length) return;

    const colors = BAND_COLORS[bandName] || { dot: COLORS.dot + '0.55)', trend: COLORS.trendLine, label: COLORS.label };

    // Compute offset range from this band's actual data so nothing clips
    const offsets = onsets.map(o => o.offset);
    const maxAbs = Math.max(Math.abs(Math.min(...offsets)), Math.abs(Math.max(...offsets)), 15);
    const offsetRange = Math.ceil(maxAbs / 5) * 5 + 5;

    const pL = 35, pR = 10, pT = 16, pB = 8;
    const pW = W - pL - pR, pH = H - pT - pB, cY = pT + pH / 2;

    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    // Band label (top-left)
    x.fillStyle = colors.label;
    x.font = 'bold 9px DM Sans';
    x.textAlign = 'left';
    x.fillText(bandLabel, pL, 11);

    // Zero line
    x.strokeStyle = 'rgba(232, 230, 222, 0.15)';
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(pL, cY); x.lineTo(W - pR, cY); x.stroke();

    // Y-axis labels
    x.fillStyle = COLORS.label;
    x.font = '7px DM Sans';
    x.textAlign = 'right';
    x.fillText('Ahead', pL - 4, pT + 6);
    x.fillText('Behind', pL - 4, H - pB - 1);

    // Onset dots
    onsets.forEach(o => {
      const xx = pL + (o.time / maxTime) * pW;
      const yy = cY + (o.offset / offsetRange) * (pH / 2);
      x.beginPath();
      x.arc(xx, yy, 2, 0, Math.PI * 2);
      x.fillStyle = colors.dot;
      x.fill();
    });

    // Rolling average trend line
    if (onsets.length > 4) {
      const ws = Math.min(6, Math.floor(onsets.length / 3));
      x.beginPath();
      x.strokeStyle = colors.trend;
      x.lineWidth = 1.5;
      for (let i = ws; i < onsets.length; i++) {
        const w = onsets.slice(i - ws, i);
        const avgOff = w.reduce((s, o) => s + o.offset, 0) / w.length;
        const xx = pL + (onsets[i].time / maxTime) * pW;
        const yy = cY + (avgOff / offsetRange) * (pH / 2);
        if (i === ws) x.moveTo(xx, yy); else x.lineTo(xx, yy);
      }
      x.stroke();
    }
  }

  /**
   * Draw the Tempo Curve chart (Free Play).
   */
  function drawTempoCurve(canvas, curve, avgBpm) {
    const mobileH = window.innerWidth < 900 ? 100 : 120;
    const { ctx: x, W, H } = setupCanvas(canvas, mobileH);
    if (!curve || curve.length < 2) return;

    const pL = 40, pR = 10, pT = 10, pB = 24;
    const pW = W - pL - pR, pH = H - pT - pB;

    const bpms = curve.map(p => p.bpm);
    const minBpm = Math.floor(Math.min(...bpms)) - 2;
    const maxBpm = Math.ceil(Math.max(...bpms)) + 2;
    const bpmRange = maxBpm - minBpm || 4;
    const minTime = curve[0].time;
    const maxTime = curve[curve.length - 1].time;
    const timeRange = maxTime - minTime || 1;

    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    // Average BPM dashed line
    const avgY = pT + (1 - (avgBpm - minBpm) / bpmRange) * pH;
    x.setLineDash([4, 4]);
    x.strokeStyle = 'rgba(232, 230, 222, 0.15)';
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(pL, avgY); x.lineTo(W - pR, avgY); x.stroke();
    x.setLineDash([]);

    // Y-axis labels
    x.fillStyle = COLORS.label;
    x.font = '8px DM Sans';
    x.textAlign = 'right';
    x.fillText(maxBpm + '', pL - 4, pT + 8);
    x.fillText(Math.round(avgBpm) + '', pL - 4, avgY + 3);
    x.fillText(minBpm + '', pL - 4, H - pB);

    // Bottom label
    x.textAlign = 'center';
    x.fillText('BPM over time', W / 2, H - 4);

    // Teal line connecting points
    x.beginPath();
    x.strokeStyle = COLORS.teal;
    x.lineWidth = 1.5;
    curve.forEach((p, i) => {
      const xx = pL + ((p.time - minTime) / timeRange) * pW;
      const yy = pT + (1 - (p.bpm - minBpm) / bpmRange) * pH;
      if (i === 0) x.moveTo(xx, yy); else x.lineTo(xx, yy);
    });
    x.stroke();

    // Data point dots
    curve.forEach(p => {
      const xx = pL + ((p.time - minTime) / timeRange) * pW;
      const yy = pT + (1 - (p.bpm - minBpm) / bpmRange) * pH;
      x.beginPath();
      x.arc(xx, yy, 3, 0, Math.PI * 2);
      x.fillStyle = COLORS.teal;
      x.fill();
    });
  }

  /**
   * Draw the Progress Chart (History).
   * Shows pocket position over sessions with consistency bars.
   */
  function drawProgressChart(canvas, sessions) {
    const { ctx: x, W, H } = setupCanvas(canvas, 160);
    if (!sessions.length) return;

    const pL = 40, pR = 10, pT = 15, pB = 24;
    const pW = W - pL - pR, pH = H - pT - pB;

    // Compute range from data
    let minOff = Infinity, maxOff = -Infinity;
    sessions.forEach(s => {
      const lo = s.pocketPosition - s.pocketConsistency;
      const hi = s.pocketPosition + s.pocketConsistency;
      if (lo < minOff) minOff = lo;
      if (hi > maxOff) maxOff = hi;
    });
    minOff = Math.floor(minOff / 5) * 5 - 5;
    maxOff = Math.ceil(maxOff / 5) * 5 + 5;
    const offRange = maxOff - minOff || 10;

    x.fillStyle = COLORS.surface;
    x.fillRect(0, 0, W, H);

    // Zero line
    const zeroY = pT + (1 - (0 - minOff) / offRange) * pH;
    if (zeroY > pT && zeroY < H - pB) {
      x.strokeStyle = 'rgba(232, 230, 222, 0.15)';
      x.lineWidth = 1;
      x.beginPath(); x.moveTo(pL, zeroY); x.lineTo(W - pR, zeroY); x.stroke();
      x.fillStyle = COLORS.label;
      x.font = '8px DM Sans';
      x.textAlign = 'right';
      x.fillText('0ms', pL - 4, zeroY + 3);
    }

    // Y-axis labels
    x.fillStyle = COLORS.label;
    x.font = '8px DM Sans';
    x.textAlign = 'right';
    x.fillText('Ahead', pL - 4, pT + 8);
    x.fillText('Behind', pL - 4, H - pB);

    // Plot sessions (most recent on right)
    const reversed = [...sessions].reverse();
    const gap = reversed.length > 1 ? pW / (reversed.length - 1) : pW / 2;

    // Trend line
    x.beginPath();
    x.strokeStyle = COLORS.trendLine;
    x.lineWidth = 1.5;
    reversed.forEach((s, i) => {
      const xx = reversed.length > 1 ? pL + i * gap : pL + pW / 2;
      const yy = pT + (1 - (s.pocketPosition - minOff) / offRange) * pH;
      if (i === 0) x.moveTo(xx, yy); else x.lineTo(xx, yy);
    });
    x.stroke();

    // Dots with consistency bars
    reversed.forEach((s, i) => {
      const xx = reversed.length > 1 ? pL + i * gap : pL + pW / 2;
      const yCenter = pT + (1 - (s.pocketPosition - minOff) / offRange) * pH;
      const barHalf = (s.pocketConsistency / offRange) * pH;

      // Consistency bar
      x.strokeStyle = s.mode === 'click' || s.mode === 'playground'
        ? 'rgba(29, 158, 117, 0.3)' : 'rgba(139, 127, 212, 0.3)';
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(xx, Math.max(pT, yCenter - barHalf));
      x.lineTo(xx, Math.min(H - pB, yCenter + barHalf));
      x.stroke();

      // Dot
      x.beginPath();
      x.arc(xx, yCenter, 4, 0, Math.PI * 2);
      x.fillStyle = s.mode === 'click' || s.mode === 'playground' ? COLORS.teal : COLORS.purple;
      x.fill();
    });

    // Bottom label
    x.fillStyle = COLORS.label;
    x.font = '8px DM Sans';
    x.textAlign = 'center';
    x.fillText('Sessions over time', W / 2, H - 4);
  }

  return {
    drawPocketLanding,
    drawBandPocketLanding,
    drawTimeline,
    drawBandTimeline,
    drawTempoCurve,
    drawProgressChart
  };
})();
