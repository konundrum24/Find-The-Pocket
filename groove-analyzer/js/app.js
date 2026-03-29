// ============================================
// app.js — Main app state and screen management
//
// Orchestrates all modes:
//   Click Mode:  Home → Setup → Sound Check → Calibration → Playing → Results
//   Free Play:   Home → FP Setup → Sound Check → Recording → Results
//   Playground:  Home → Target Select → PG Setup → Sound Check → Calibration → Playing → Results
//   History:     Home → History → Session Detail
// ============================================

const App = (() => {
  // ── State ──
  let tempo = 90;
  let sensitivity = 8;
  let latencyOffset = 0;
  let mode = 'idle'; // idle | soundcheck | calibrating | playing | recording
  let appMode = 'click'; // click | freeplay | playground
  let calibrationOffsets = [];
  let sessionOnsets = [];
  let sessionStartTime = 0;
  let soundCheckHits = 0;
  let selectedTarget = null;
  let freePlayOnsetTimes = []; // raw onset times for tempo estimation
  let liveBpmEstimate = null;
  let lastCoarseBpm = null; // coarse estimate before refinement

  // Essentia.js state
  let essentia = null;
  let essentiaReady = false;

  // Live BPM estimation state (Free Play recording)
  let bpmEstimateInterval = null;
  let stableBpm = null;
  let stableBpmCount = 0;        // consecutive estimates at the stable tempo
  let pendingNewBpm = null;       // candidate tempo that doesn't match stable
  let pendingNewBpmCount = 0;     // consecutive estimates near pendingNewBpm
  let firstBpmReceived = false;

  // Intervals
  let timerInterval = null;
  let pulseInterval = null;
  let animFrameId = null;

  // ── Essentia.js Initialization ──
  async function initEssentia() {
    try {
      if (typeof EssentiaWASM !== 'undefined') {
        const wasmModule = await EssentiaWASM();
        essentia = new Essentia(wasmModule);
        essentiaReady = true;
        console.log('[Groove] Essentia.js ready');
      } else {
        console.warn('[Groove] EssentiaWASM not found — will use custom pipeline');
      }
    } catch (err) {
      console.warn('[Groove] Essentia.js init failed:', err.message);
    }
  }
  initEssentia();

  // ── Live BPM Estimation (main thread, using already-loaded Essentia) ──
  function startBpmEstimation() {
    stableBpm = null;
    stableBpmCount = 0;
    pendingNewBpm = null;
    pendingNewBpmCount = 0;
    firstBpmReceived = false;
  }

  function stopBpmEstimation() {
    if (bpmEstimateInterval) {
      clearInterval(bpmEstimateInterval);
      bpmEstimateInterval = null;
    }
  }

  function requestBpmEstimate() {
    if (!essentiaReady || !essentia) {
      console.warn('[Groove] Live BPM: Essentia not ready (essentiaReady=' + essentiaReady + ')');
      return;
    }
    if (mode !== 'recording') return;

    const pcmData = OnsetDetector.getPcmSignal();
    if (!pcmData || pcmData.signal.length === 0) {
      console.warn('[Groove] Live BPM: no PCM data available');
      return;
    }

    const durationSec = pcmData.signal.length / pcmData.sampleRate;
    console.log('[Groove] Live BPM: analyzing ' + pcmData.signal.length +
      ' samples (' + durationSec.toFixed(1) + 's at ' + pcmData.sampleRate + 'Hz)');

    let signal = pcmData.signal;
    if (pcmData.sampleRate !== 44100) {
      signal = resampleTo44100(signal, pcmData.sampleRate);
    }

    let vectorSignal;
    try {
      vectorSignal = essentia.arrayToVector(signal);
    } catch (err) {
      console.warn('[Groove] Live BPM: arrayToVector failed:', err.message);
      return;
    }

    let result;
    try {
      result = essentia.PercivalBpmEstimator(vectorSignal);
    } catch (err) {
      console.warn('[Groove] Live BPM: PercivalBpmEstimator failed:', err.message);
      try { vectorSignal.delete(); } catch (_) {}
      return;
    }

    const bpm = Number(result.bpm);
    try { vectorSignal.delete(); } catch (_) {}

    console.log('[Groove] Live BPM: raw result = ' + bpm);
    if (bpm && !isNaN(bpm) && bpm > 0) {
      handleBpmEstimate(bpm);
    }
  }

  /**
   * Octave-collapse guard: prevents 2x/0.5x jumps in displayed BPM.
   * Accepts the raw estimate from PercivalBpmEstimator and returns
   * the value to display (or null to ignore).
   */
  function handleBpmEstimate(rawBpm) {
    if (!stableBpm) {
      // First estimate — accept directly
      stableBpm = rawBpm;
      stableBpmCount = 1;
      showLiveBpm(Math.round(rawBpm));
      return;
    }

    let adjusted = rawBpm;

    // Check for octave doubles/halves
    const ratio = rawBpm / stableBpm;
    if (ratio >= 1.8 && ratio <= 2.2) {
      // ~2x — halve it
      adjusted = rawBpm / 2;
      console.log('[BPM] Octave collapse: ' + rawBpm.toFixed(1) + ' → ' + adjusted.toFixed(1) + ' (halved)');
    } else if (ratio >= 0.45 && ratio <= 0.55) {
      // ~0.5x — double it
      adjusted = rawBpm * 2;
      console.log('[BPM] Octave collapse: ' + rawBpm.toFixed(1) + ' → ' + adjusted.toFixed(1) + ' (doubled)');
    }

    // Within ~15% of stable — accept and update weighted average
    const adjustedRatio = adjusted / stableBpm;
    if (adjustedRatio >= 0.85 && adjustedRatio <= 1.15) {
      // Weighted average: bias toward new estimates as they accumulate
      const weight = Math.min(0.4, 0.2 + stableBpmCount * 0.05);
      stableBpm = stableBpm * (1 - weight) + adjusted * weight;
      stableBpmCount++;
      pendingNewBpm = null;
      pendingNewBpmCount = 0;
      showLiveBpm(Math.round(stableBpm));
      return;
    }

    // Doesn't match stable — track as candidate
    if (pendingNewBpm && Math.abs(adjusted - pendingNewBpm) / pendingNewBpm < 0.15) {
      pendingNewBpmCount++;
      if (pendingNewBpmCount >= 2) {
        // Two consecutive agreeing estimates at new tempo — accept it
        console.log('[BPM] Tempo shift accepted: ' + stableBpm.toFixed(1) + ' → ' + adjusted.toFixed(1));
        stableBpm = adjusted;
        stableBpmCount = 1;
        pendingNewBpm = null;
        pendingNewBpmCount = 0;
        showLiveBpm(Math.round(stableBpm));
      }
    } else {
      pendingNewBpm = adjusted;
      pendingNewBpmCount = 1;
    }
  }

  function showLiveBpm(bpm) {
    const bpmEl = document.getElementById('fp-live-bpm');
    const listeningEl = document.getElementById('fp-listening');
    const resultEl = document.getElementById('fp-bpm-result');

    if (!firstBpmReceived) {
      // Crossfade from "Listening..." to BPM display
      firstBpmReceived = true;
      if (listeningEl) listeningEl.style.display = 'none';
      if (resultEl) {
        resultEl.style.display = '';
        resultEl.classList.add('fade-in');
      }
    }

    if (bpmEl) {
      // Brief dim during update for smooth transition
      bpmEl.classList.add('updating');
      bpmEl.textContent = bpm;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => bpmEl.classList.remove('updating'));
      });
    }

    liveBpmEstimate = bpm;
  }

  /** Resample audio signal to 44100Hz for Essentia. */
  function resampleTo44100(signal, fromRate) {
    const ratio = 44100 / fromRate;
    const newLength = Math.round(signal.length * ratio);
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i / ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, signal.length - 1);
      const frac = srcIdx - idx0;
      resampled[i] = signal[idx0] * (1 - frac) + signal[idx1] * frac;
    }
    return resampled;
  }

  /**
   * Extract beat positions from PCM using Essentia.js RhythmExtractor2013.
   * @param {Float32Array} signal - raw PCM audio
   * @param {number} sampleRate - sample rate of the signal
   * @param {number} timeOffsetMs - offset to add to Essentia's ticks to align
   *   with session-relative onset timestamps. This accounts for the gap between
   *   sessionStartTime and when PCM capture actually began.
   */
  function extractEssentiaBeats(signal, sampleRate, timeOffsetMs) {
    if (!essentiaReady || !essentia) return null;

    let analysisSignal = signal;
    if (sampleRate !== 44100) {
      analysisSignal = resampleTo44100(signal, sampleRate);
    }

    const vectorSignal = essentia.arrayToVector(analysisSignal);

    let rhythmResult;
    try {
      rhythmResult = essentia.RhythmExtractor2013(vectorSignal, 220, 'multifeature', 40);
    } catch (err) {
      console.warn('[Groove] RhythmExtractor2013 failed:', err.message);
      try { vectorSignal.delete(); } catch(e) {}
      return null;
    }

    const bpm = rhythmResult.bpm;
    if (!bpm || isNaN(bpm)) {
      try { vectorSignal.delete(); } catch(e) {}
      return null;
    }

    // Deep-copy ticks from WASM memory immediately
    // (WASM heap views can be invalidated by subsequent operations)
    let ticksRaw;
    try {
      ticksRaw = essentia.vectorToArray(rhythmResult.ticks);
    } catch (err) {
      try { vectorSignal.delete(); } catch(e) {}
      return null;
    }
    const ticks = Array.from(ticksRaw).map(Number);

    // Clean up ALL WASM vectors before any further processing
    try { rhythmResult.ticks.delete(); } catch(e) {}
    try { rhythmResult.estimates.delete(); } catch(e) {}
    try { rhythmResult.bpmIntervals.delete(); } catch(e) {}
    try { vectorSignal.delete(); } catch(e) {}

    // Filter invalid ticks, convert to session-relative ms anchors
    const validTicks = ticks.filter(t => !isNaN(t) && t >= 0);
    if (validTicks.length < 4) return null;

    const anchors = [];
    for (let i = 0; i < validTicks.length; i++) {
      // Essentia tick (seconds from PCM start) → session-relative ms
      const timeMs = validTicks[i] * 1000 + timeOffsetMs;
      if (i === 0 || timeMs - anchors[anchors.length - 1].time >= 200) {
        anchors.push({ time: timeMs, amplitude: 1, interpolated: false });
      }
    }

    console.log('[Groove] Essentia beats:', anchors.length, 'anchors, BPM:', bpm.toFixed(1),
      '| time offset:', timeOffsetMs.toFixed(1) + 'ms');
    return anchors;
  }

  // ── Drum Attribution (v3) ──
  // Groups co-incident per-band onsets into single drum events, classifies each
  // by frequency profile. Returns hybrid counts: attribution for kick/snare,
  // raw band count for hi-hat (since hi-hat is masked by simultaneous kick/snare).
  function runDrumAttribution(bandOnsets, sessionStartTime) {
    const COINCIDENCE_WINDOW_MS = 15;
    const SINGLE_BAND_MERGE_MS = 50;
    const MERGE_WINDOW_MS = 30;
    const bandNames = ['kick', 'bass', 'mid', 'snare', 'hihat'];

    // Collect all band onsets into sorted list
    var allOnsets = [];
    for (var bi = 0; bi < bandNames.length; bi++) {
      var bName = bandNames[bi];
      var onsets = bandOnsets[bName] || [];
      for (var oi = 0; oi < onsets.length; oi++) {
        allOnsets.push({ time: onsets[oi].time - sessionStartTime, amplitude: onsets[oi].amplitude, band: bName });
      }
    }
    allOnsets.sort(function(a, b) { return a.time - b.time; });
    if (allOnsets.length === 0) return null;

    // Group into coincident events
    var events = [];
    var currentEvent = { onsets: [allOnsets[0]], startTime: allOnsets[0].time };
    for (var i = 1; i < allOnsets.length; i++) {
      var o = allOnsets[i];
      if (o.time - currentEvent.startTime <= COINCIDENCE_WINDOW_MS) {
        var existing = currentEvent.onsets.find(function(e) { return e.band === o.band; });
        if (!existing) { currentEvent.onsets.push(o); }
        else if (o.amplitude > existing.amplitude) { existing.amplitude = o.amplitude; existing.time = o.time; }
      } else {
        events.push(currentEvent);
        currentEvent = { onsets: [o], startTime: o.time };
      }
    }
    events.push(currentEvent);

    // Post-grouping merge: single-band events (speaker artifacts) + complementary profiles
    var merged = true;
    while (merged) {
      merged = false;
      for (var m = 0; m < events.length - 1; m++) {
        var evA = events[m], evB = events[m + 1];
        var gap = evB.startTime - evA.startTime;
        if (gap > SINGLE_BAND_MERGE_MS) continue;

        var singleBandMerge = (evA.onsets.length === 1 || evB.onsets.length === 1);
        var subsetMerge = gap <= MERGE_WINDOW_MS && (evA.onsets.length <= 2 || evB.onsets.length <= 2);

        if (singleBandMerge || subsetMerge) {
          for (var bj = 0; bj < evB.onsets.length; bj++) {
            var onset = evB.onsets[bj];
            var ex = evA.onsets.find(function(e) { return e.band === onset.band; });
            if (!ex) { evA.onsets.push(onset); }
            else if (onset.amplitude > ex.amplitude) { ex.amplitude = onset.amplitude; ex.time = onset.time; }
          }
          events.splice(m + 1, 1);
          merged = true;
          break;
        }
      }
    }

    // Classify each event
    var kickCount = 0, snareCount = 0, hihatAttrCount = 0;
    for (var ei = 0; ei < events.length; ei++) {
      var event = events[ei];
      var profile = {};
      var totalAmp = 0;
      for (var bn = 0; bn < bandNames.length; bn++) profile[bandNames[bn]] = 0;
      for (var pi = 0; pi < event.onsets.length; pi++) {
        profile[event.onsets[pi].band] = event.onsets[pi].amplitude;
        totalAmp += event.onsets[pi].amplitude;
      }
      if (totalAmp === 0) continue;

      var kickRatio = profile.kick / totalAmp;
      var snareRatio = profile.snare / totalAmp;
      var hihatRatio = profile.hihat / totalAmp;
      var upperRatio = (profile.snare + profile.hihat) / totalAmp;

      if (kickRatio > 0.25 && kickRatio >= snareRatio && kickRatio >= hihatRatio) {
        kickCount++;
      } else if (upperRatio > kickRatio && hihatRatio >= snareRatio) {
        hihatAttrCount++;
      } else if (snareRatio > hihatRatio || (snareRatio + profile.mid / totalAmp) > (kickRatio + hihatRatio)) {
        snareCount++;
      } else {
        // Fallback by dominant band
        var maxBand = bandNames[0];
        for (var di = 1; di < bandNames.length; di++) {
          if (profile[bandNames[di]] > profile[maxBand]) maxBand = bandNames[di];
        }
        if (maxBand === 'kick') kickCount++;
        else if (maxBand === 'hihat') hihatAttrCount++;
        else snareCount++;
      }
    }

    // Hybrid: use raw hi-hat band count (attribution undercounts due to simultaneous events)
    var rawHihatCount = (bandOnsets.hihat || []).length;

    return {
      kick: kickCount,
      snare: snareCount,
      hihat: rawHihatCount,
      hihatAttribution: hihatAttrCount,
      totalEvents: events.length,
      totalBandOnsets: allOnsets.length
    };
  }

  // ── Helpers ──
  function msPerBeat() { return 60000 / tempo; }

  // ── Phase Bar ──
  function updatePhaseBar(screenId) {
    const flows = {
      click: ['screen-setup', 'screen-cal', 'screen-play', 'screen-res'],
      freeplay: ['screen-fp-setup', 'screen-fp-rec', 'screen-res'],
      playground: ['screen-pg-setup', 'screen-cal', 'screen-play', 'screen-res']
    };
    const steps = document.querySelectorAll('.phase-bar .step');
    const flow = flows[appMode] || flows.click;

    // Show/hide steps based on flow length
    steps.forEach((s, i) => {
      s.style.display = i < flow.length ? '' : 'none';
    });

    const idx = flow.indexOf(screenId);
    steps.forEach((s, i) => {
      if (i >= flow.length) return;
      s.className = 'step' + (i < idx ? ' done' : i === idx ? ' active' : '');
    });
  }

  // ── Screen Management ──
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    // Update header tag
    const tagEl = document.getElementById('header-tag');
    const phaseBar = document.querySelector('.phase-bar');

    if (id === 'screen-home' || id === 'screen-history' || id === 'screen-pg-select') {
      phaseBar.style.display = 'none';
      if (id === 'screen-home') tagEl.textContent = 'Find the Pocket';
      else if (id === 'screen-history') tagEl.textContent = 'History';
      else tagEl.textContent = 'Pocket Playground';
    } else {
      phaseBar.style.display = 'flex';
      if (appMode === 'click') tagEl.textContent = 'Click Mode';
      else if (appMode === 'freeplay') tagEl.textContent = 'Free Play';
      else tagEl.textContent = 'Pocket Playground';
      updatePhaseBar(id);
    }
  }

  // ── Home Screen ──
  function goHome() {
    stopEverything();
    showScreen('screen-home');
  }

  function startClickMode() {
    appMode = 'click';
    selectedTarget = null;
    resetSetupScreen();
    showScreen('screen-setup');
  }

  function startFreePlayMode() {
    appMode = 'freeplay';
    selectedTarget = null;
    showScreen('screen-fp-setup');
    resetFreePlaySetup();
  }

  function startPlaygroundMode() {
    appMode = 'playground';
    renderTargetSelection();
    showScreen('screen-pg-select');
  }

  // ── Setup Screen Reset ──
  function resetSetupScreen() {
    document.getElementById('sc-panel').style.display = 'none';
    document.getElementById('sc-btn').style.display = '';
    document.getElementById('go-btn').disabled = true;
    document.getElementById('go-btn').textContent = 'Complete sound check first';
    document.getElementById('sc-hits').textContent = '';
  }

  function resetFreePlaySetup() {
    document.getElementById('fp-sc-panel').style.display = 'none';
    document.getElementById('fp-sc-btn').style.display = '';
    document.getElementById('fp-go-btn').disabled = true;
    document.getElementById('fp-go-btn').textContent = 'Complete sound check first';
    document.getElementById('fp-sc-hits').textContent = '';
  }

  function resetPlaygroundSetup() {
    document.getElementById('pg-sc-panel').style.display = 'none';
    document.getElementById('pg-sc-btn').style.display = '';
    document.getElementById('pg-go-btn').disabled = true;
    document.getElementById('pg-go-btn').textContent = 'Complete sound check first';
    document.getElementById('pg-sc-hits').textContent = '';
  }

  // ── Tempo Control ──
  function changeTempo(delta) {
    tempo = Math.max(40, Math.min(200, tempo + delta));
    document.getElementById('tempo-value').textContent = tempo;
  }

  function changePlaygroundTempo(delta) {
    tempo = Math.max(40, Math.min(200, tempo + delta));
    document.getElementById('pg-tempo-value').textContent = tempo;
  }

  function editTempo(elementId) {
    const el = document.getElementById(elementId);
    const current = tempo;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'tempo-input';
    input.min = 40;
    input.max = 200;
    input.value = current;

    function commit() {
      const val = Math.max(40, Math.min(200, Math.round(Number(input.value) || current)));
      tempo = val;
      el.textContent = val;
      el.style.display = '';
      input.remove();
      // Sync the other display if both exist
      const otherId = elementId === 'tempo-value' ? 'pg-tempo-value' : 'tempo-value';
      const other = document.getElementById(otherId);
      if (other) other.textContent = val;
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });

    el.style.display = 'none';
    el.parentElement.insertBefore(input, el);
    input.focus();
    input.select();
  }

  // ── Sensitivity ──
  function updateSensitivity() {
    const slider = document.getElementById('sens-sl');
    if (!slider) return;
    sensitivity = parseInt(slider.value);
    document.getElementById('sens-v').textContent = sensitivity;
    document.getElementById('th-mark').style.left = sensitivity + '%';
    const pth = document.getElementById('pth');
    if (pth) pth.style.left = sensitivity + '%';
    OnsetDetector.setSensitivity(sensitivity);
  }

  function updateFpSensitivity() {
    const slider = document.getElementById('fp-sens-sl');
    if (!slider) return;
    sensitivity = parseInt(slider.value);
    document.getElementById('fp-sens-v').textContent = sensitivity;
    document.getElementById('fp-th-mark').style.left = sensitivity + '%';
    const pth = document.getElementById('fp-pth');
    if (pth) pth.style.left = sensitivity + '%';
    OnsetDetector.setSensitivity(sensitivity);
  }

  function updatePgSensitivity() {
    const slider = document.getElementById('pg-sens-sl');
    if (!slider) return;
    sensitivity = parseInt(slider.value);
    document.getElementById('pg-sens-v').textContent = sensitivity;
    document.getElementById('pg-th-mark').style.left = sensitivity + '%';
    const pth = document.getElementById('pth');
    if (pth) pth.style.left = sensitivity + '%';
    OnsetDetector.setSensitivity(sensitivity);
  }

  // ── Main Loop ──
  function mainLoop() {
    const onsets = OnsetDetector.drainOnsets();
    for (const onset of onsets) {
      if (mode !== 'idle') handleOnset(onset.time, onset.amplitude);
    }
    if (mode !== 'idle') updateLevelDisplay();
    animFrameId = requestAnimationFrame(mainLoop);
  }

  function startMainLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = requestAnimationFrame(mainLoop);
  }

  function updateLevelDisplay() {
    const { rms, peak } = OnsetDetector.getLevel();
    const pct = Math.min(100, (rms / peak) * 100);

    let barId;
    if (mode === 'playing') barId = 'plv';
    else if (mode === 'recording') barId = 'fp-plv';
    else if (appMode === 'freeplay') barId = 'fp-lv-bar';
    else if (appMode === 'playground') barId = 'pg-lv-bar';
    else barId = 'lv-bar';

    const bar = document.getElementById(barId);
    if (bar) {
      bar.style.width = pct + '%';
      bar.className = 'level-bar' + (pct > sensitivity ? ' hot' : '');
    }

    if (mode === 'soundcheck') {
      const valId = appMode === 'freeplay' ? 'fp-lv-val' :
                    appMode === 'playground' ? 'pg-lv-val' : 'lv-val';
      const valEl = document.getElementById(valId);
      if (valEl) valEl.textContent = Math.round(pct);
    }
  }

  // ── Onset Handler ──
  function handleOnset(timeMs, amp) {
    if (mode === 'soundcheck') {
      soundCheckHits++;
      const hitsId = appMode === 'freeplay' ? 'fp-sc-hits' :
                    appMode === 'playground' ? 'pg-sc-hits' : 'sc-hits';
      const hitsEl = document.getElementById(hitsId);
      if (hitsEl) hitsEl.textContent = `\u2713 Hit #${soundCheckHits} detected!`;

      if (soundCheckHits >= 3) {
        if (appMode === 'freeplay') {
          document.getElementById('fp-go-btn').disabled = false;
          document.getElementById('fp-go-btn').textContent = 'Start Recording';
        } else if (appMode === 'playground') {
          document.getElementById('pg-go-btn').disabled = false;
          document.getElementById('pg-go-btn').textContent = 'Start Calibration';
        } else {
          document.getElementById('go-btn').disabled = false;
          document.getElementById('go-btn').textContent = 'Start Calibration';
        }
      }
      return;
    }

    if (mode === 'recording') {
      // Free Play: collect raw onset times
      freePlayOnsetTimes.push(timeMs);
      sessionOnsets.push({ time: timeMs - sessionStartTime, amplitude: amp });
      document.getElementById('fp-ps').textContent = freePlayOnsetTimes.length + ' onsets detected';

      // Pulse the listening indicator on each onset (Phase 1 visual feedback)
      if (!firstBpmReceived) {
        const pulseEl = document.getElementById('fp-listening-pulse');
        if (pulseEl) {
          pulseEl.classList.add('onset');
          setTimeout(() => pulseEl.classList.remove('onset'), 120);
        }
      }
      return;
    }

    // Click Mode / Playground: find nearest grid point
    if (mode === 'calibrating') {
      // Auto-calibration: match detected onset to nearest click grid point
      const gridTimes = Grid.getGridTimes();
      const result = Analysis.computeOffset(timeMs, gridTimes);
      if (!result) return;
      if (result.distance > Analysis.maxOffsetMs(msPerBeat())) return;
      calibrationOffsets.push(result.offset);
      document.getElementById('cc').textContent = calibrationOffsets.length + ' clicks detected';
      return;
    }

    if (mode === 'playing') {
      // Playing uses 16th-note grid for subdivision-aware analysis
      const grid = Grid.getSubdivisionGrid();
      const result = Analysis.computeOffset(timeMs, grid.points);
      if (!result) return;
      if (result.distance > Analysis.maxSubdivisionOffsetMs(grid.gridUnitMs)) return;

      const corrected = result.offset - latencyOffset;
      sessionOnsets.push({
        time: timeMs - sessionStartTime,
        offset: corrected,
        raw: result.offset,
        gridTime: result.gridTime,
        amplitude: amp
      });
      document.getElementById('ps').textContent = sessionOnsets.length + ' hits';
      document.getElementById('plh').textContent =
        `Last: ${corrected >= 0 ? '+' : ''}${Math.round(corrected)}ms`;
    }
  }

  // ── Sound Check (shared) ──
  async function startSoundCheck() {
    const ok = await Audio.init();
    if (!ok) return;

    mode = 'soundcheck';
    soundCheckHits = 0;

    OnsetDetector.reset();
    OnsetDetector.setSensitivity(sensitivity);
    OnsetDetector.setCooldown(
      appMode === 'freeplay'
        ? Math.floor((80 / 1000) * Audio.getSampleRate()) // 80ms min cooldown for free play
        : Analysis.cooldownSamples(msPerBeat(), Audio.getSampleRate())
    );
    OnsetDetector.start(Audio.getMicSource(), Audio.getContext());
    OnsetDetector.setActive(true);

    if (appMode === 'freeplay') {
      document.getElementById('fp-sc-panel').style.display = 'block';
      document.getElementById('fp-sc-btn').style.display = 'none';
      updateFpSensitivity();
    } else if (appMode === 'playground') {
      document.getElementById('pg-sc-panel').style.display = 'block';
      document.getElementById('pg-sc-btn').style.display = 'none';
      updatePgSensitivity();
    } else {
      document.getElementById('sc-panel').style.display = 'block';
      document.getElementById('sc-btn').style.display = 'none';
      updateSensitivity();
    }

    startMainLoop();
  }

  // ── Auto-Calibration (Click Mode + Playground) ──
  // Plays clicks through speakers, listens for them through the mic,
  // and measures the round-trip latency. No user interaction required.
  function startAutoCalibration() {
    mode = 'calibrating';
    calibrationOffsets = [];

    showScreen('screen-cal');
    document.getElementById('cc').textContent = '';
    document.getElementById('ci').textContent = 'Measuring system latency...';
    document.getElementById('cb').disabled = true;
    document.getElementById('cb').style.display = 'none';

    // Use quarter-note cooldown for clear click separation
    OnsetDetector.setCooldown(Analysis.cooldownSamples(msPerBeat(), Audio.getSampleRate()));
    OnsetDetector.setActive(true);
    Grid.startClick(tempo, Audio.getContext());

    // Auto-calibration collects onsets through handleOnset() in calibrating mode.
    // The existing calibrating handler in handleOnset() matches onsets to the grid.
    startMainLoop();

    // Monitor progress and auto-finish when enough clicks are detected
    const calStartTime = Audio.getContext().currentTime * 1000;
    const calCheckInterval = setInterval(() => {
      const elapsed = Audio.getContext().currentTime * 1000 - calStartTime;
      const clickCount = calibrationOffsets.length;

      // Need at least 4 clicks and 2+ seconds elapsed
      if (clickCount >= 4 && elapsed > 2000) {
        clearInterval(calCheckInterval);
        finishAutoCalibration();
      } else if (elapsed > 6000) {
        // Timeout — proceed with whatever we have or 0
        clearInterval(calCheckInterval);
        if (clickCount >= 2) {
          finishAutoCalibration();
        } else {
          console.warn('[Groove] Auto-calibration: not enough clicks detected, using 0ms latency');
          latencyOffset = 0;
          Grid.stopClick();
          OnsetDetector.setActive(false);
          startSession();
        }
      }
    }, 100);
  }

  function finishAutoCalibration() {
    Grid.stopClick();
    OnsetDetector.setActive(false);
    OnsetDetector.reset(); // Clear calibration data before session
    mode = 'idle';

    // Use trimmed median for robustness (same as old manual calibration)
    latencyOffset = Analysis.computeLatencyOffset(calibrationOffsets);
    console.log('[Groove] Auto-calibration: latency = ' + latencyOffset.toFixed(1) +
      'ms (' + calibrationOffsets.length + ' clicks)');
    document.getElementById('ci').textContent =
      'Latency: ' + Math.round(latencyOffset) + 'ms';

    // Brief pause to show result, then start session
    setTimeout(() => startSession(), 400);
  }

  // Keep manual calibration as fallback (exposed but not in default flow)
  function startCalibration() {
    startAutoCalibration();
  }

  function finishCalibration() {
    // No-op — auto-calibration handles its own finish
  }

  // ── Click / Playground Session ──
  function startSession() {
    mode = 'playing';
    sessionOnsets = [];
    // Use 16th-note grid unit for cooldown so fast subdivisions aren't rejected
    const gridUnitMs = msPerBeat() / 4;
    OnsetDetector.setCooldown(Analysis.cooldownSamples(gridUnitMs, Audio.getSampleRate()));
    sessionStartTime = Audio.getContext().currentTime * 1000;

    showScreen('screen-play');
    document.getElementById('pth').style.left = sensitivity + '%';
    document.getElementById('ps').textContent = '0 hits';
    document.getElementById('plh').textContent = '';

    Grid.startClick(tempo, Audio.getContext());
    OnsetDetector.setActive(true, { keepGain: true });
    startMainLoop();

    // Beat pulse
    const pp = document.getElementById('pp');
    if (pulseInterval) clearInterval(pulseInterval);
    pulseInterval = setInterval(() => {
      if (mode !== 'playing') return;
      pp.classList.add('beat');
      setTimeout(() => pp.classList.remove('beat'), 80);
    }, msPerBeat());

    // Timer
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (mode !== 'playing') return;
      const elapsed = (Audio.getContext().currentTime * 1000 - sessionStartTime) / 1000;
      const mins = Math.floor(elapsed / 60);
      const secs = Math.floor(elapsed % 60).toString().padStart(2, '0');
      document.getElementById('pt').textContent = `${mins}:${secs}`;
    }, 250);
  }

  function stopSession() {
    mode = 'idle';
    Grid.stopClick();
    OnsetDetector.setActive(false);
    clearTimers();

    if (sessionOnsets.length < 6) {
      alert(`Only ${sessionOnsets.length} hits detected. Try playing louder or adjusting sensitivity.`);
      return;
    }

    const grid = Grid.getSubdivisionGrid();
    const durationMs = sessionOnsets.length > 0
      ? sessionOnsets[sessionOnsets.length - 1].time : 0;

    // Click Mode: the click grid IS the beat reference.
    // Latency offset from auto-calibration is already subtracted in handleOnset().
    // The remaining offset is the musician's genuine feel — do NOT phase-correct it away.
    const classifiedOnsets = Analysis.classifyOnsets(sessionOnsets, grid);
    const weightedMetrics = Analysis.computeWeightedMetrics(classifiedOnsets, grid.gridUnitMs);

    // Determine if subdivisions are present (<80% downbeats)
    const downbeatRatio = classifiedOnsets.filter(o => o.isDownbeat).length / classifiedOnsets.length;
    const hasSubdivisions = downbeatRatio < 0.8;

    let feelLine, avgOffset, stdDev, downbeatMetrics, subdivisionMetrics, density, densityLabel;

    if (hasSubdivisions && weightedMetrics) {
      avgOffset = weightedMetrics.position;
      stdDev = weightedMetrics.consistency;
      downbeatMetrics = weightedMetrics.downbeats;
      subdivisionMetrics = weightedMetrics.subdivisions;
      density = weightedMetrics.density;
      densityLabel = weightedMetrics.densityLabel;

      if (appMode === 'playground' && selectedTarget) {
        feelLine = Feedback.generatePlaygroundFeelLine(avgOffset, stdDev, selectedTarget);
      } else {
        feelLine = Feedback.generateSubdivisionFeelLine(weightedMetrics, tempo, 0);
      }
    } else {
      const metrics = Analysis.computeSessionMetrics(sessionOnsets, msPerBeat(), tempo);
      avgOffset = metrics.avgOffset;
      stdDev = metrics.stdDev;
      downbeatMetrics = null;
      subdivisionMetrics = null;
      density = null;
      densityLabel = null;

      if (appMode === 'playground' && selectedTarget) {
        feelLine = Feedback.generatePlaygroundFeelLine(avgOffset, stdDev, selectedTarget);
      } else {
        feelLine = Feedback.generateFeelLine(avgOffset, stdDev, tempo, 0);
      }
    }

    // Run diagnostics (no phase correction in Click Mode)
    const diagReport = Diagnostics.analyze(classifiedOnsets, grid, tempo, latencyOffset);

    const session = Storage.buildSessionObject({
      mode: appMode === 'playground' ? 'playground' : 'click',
      tempo,
      sensitivity,
      latencyOffset,
      avgOffset,
      stdDev,
      bpmStdDev: 0,
      avgBpm: tempo,
      hitCount: hasSubdivisions ? weightedMetrics.onsetCount : sessionOnsets.length,
      durationMs,
      offsets: classifiedOnsets.map(o => o.offset),
      onsets: classifiedOnsets,
      targetName: selectedTarget ? selectedTarget.name : null,
      targetMin: selectedTarget ? selectedTarget.positionMin : null,
      targetMax: selectedTarget ? selectedTarget.positionMax : null,
      feelLine,
      downbeatMetrics,
      subdivisionMetrics,
      density,
      densityLabel
    });

    // Attach diagnostics (not persisted to storage, just for display)
    session._diagnostics = diagReport;
    session._gridUnitMs = grid.gridUnitMs;

    Storage.saveSession(session);
    renderResults(session);
  }

  // ── Free Play Recording ──
  function startFreePlayGo() {
    startFreePlayRecording();
  }

  async function startFreePlayRecording() {
    mode = 'recording';
    sessionOnsets = [];
    freePlayOnsetTimes = [];
    liveBpmEstimate = null;

    OnsetDetector.setCooldown(Math.floor((80 / 1000) * Audio.getSampleRate()));
    sessionStartTime = Audio.getContext().currentTime * 1000;

    showScreen('screen-fp-rec');
    document.getElementById('fp-pth').style.left = sensitivity + '%';
    document.getElementById('fp-ps').textContent = '0 onsets detected';
    document.getElementById('fp-live-bpm').textContent = '\u2014';

    // Reset UI to listening state (Phase 1)
    const listeningEl = document.getElementById('fp-listening');
    const resultEl = document.getElementById('fp-bpm-result');
    if (listeningEl) listeningEl.style.display = '';
    if (resultEl) { resultEl.style.display = 'none'; resultEl.classList.remove('fade-in'); }

    // Reset live BPM estimation state
    startBpmEstimation();

    // keepGain: preserve auto-gain from sound check — it already calibrated
    // the boost level for this mic/speaker setup. Resetting would drop gain
    // to 1.0x for the first 0.5s, missing quiet hi-hats.
    OnsetDetector.setActive(true, { keepGain: true });
    startMainLoop();

    // Timer
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (mode !== 'recording') return;
      const elapsed = (Audio.getContext().currentTime * 1000 - sessionStartTime) / 1000;
      const mins = Math.floor(elapsed / 60);
      const secs = Math.floor(elapsed % 60).toString().padStart(2, '0');
      document.getElementById('fp-pt').textContent = `${mins}:${secs}`;
    }, 250);

    // Schedule periodic BPM estimation:
    // First estimate after ~10 seconds, then every ~12 seconds
    if (bpmEstimateInterval) clearInterval(bpmEstimateInterval);
    setTimeout(() => {
      if (mode !== 'recording') return;
      requestBpmEstimate(); // first estimate at ~10s
      bpmEstimateInterval = setInterval(() => {
        if (mode !== 'recording') return;
        requestBpmEstimate();
      }, 12000);
    }, 10000);
  }

  function stopFreePlayRecording() {
    mode = 'idle';
    OnsetDetector.setActive(false);
    stopBpmEstimation();
    clearTimers();

    if (freePlayOnsetTimes.length < 8) {
      alert(`Only ${freePlayOnsetTimes.length} onsets detected. Play more notes or adjust sensitivity.`);
      return;
    }

    // Primary tempo: autocorrelation of the continuous flux envelope.
    // This is independent of onset detection sensitivity — it uses the
    // raw spectral flux signal, not the detected onset timestamps.
    const fluxData = OnsetDetector.getFluxEnvelope();
    const fluxResult = FluxTempo.estimateTempo(fluxData.frames, fluxData.frameRate);

    let coarseBpm;
    if (fluxResult.bpm && fluxResult.confidence > 0.05) {
      // Resolve metric level using harmonic peak analysis
      const resolved = FluxTempo.resolveMetricLevel(fluxResult.allPeaks);
      if (resolved && resolved.bpm) {
        coarseBpm = resolved.bpm;
        console.log('[Groove] Flux tempo:', fluxResult.bpm, 'BPM → resolved to',
          resolved.bpm, 'BPM (' + resolved.label + ')');
      } else {
        coarseBpm = fluxResult.bpm;
        console.log('[Groove] Flux tempo:', fluxResult.bpm, 'BPM (no metric resolution needed)');
      }
    } else {
      // Fallback: onset-based estimation if flux autocorrelation failed
      console.log('[Groove] Flux tempo failed, falling back to onset-based estimation');
      coarseBpm = TempoEstimator.estimateTempo(freePlayOnsetTimes);
    }

    if (!coarseBpm) {
      alert('Could not detect tempo. Try playing a more rhythmic pattern.');
      return;
    }

    lastCoarseBpm = coarseBpm;

    // Get raw PCM for Essentia beat tracking
    const pcmData = OnsetDetector.getPcmSignal();

    // Try adaptive grid first (with Essentia beats, falling back to custom)
    const session = analyzeFreePlayAdaptive(coarseBpm, pcmData);
    if (!session) return;

    Storage.saveSession(session);
    renderResults(session);
  }

  /**
   * Adaptive Free Play analysis: builds grid from anchor onsets so it
   * follows the music's actual tempo. No global BPM precision needed.
   */
  function analyzeFreePlayAdaptive(coarseBpm, pcmData) {
    console.log('[Groove] coarse BPM from autocorrelation:', Math.round(coarseBpm));

    let anchors = null;

    // Try Essentia.js beat tracking first (adaptive grid, correct octave resolution)
    if (pcmData && pcmData.signal.length > 0) {
      // Essentia's ticks are relative to PCM start (sample 0).
      // sessionOnsets[].time is relative to sessionStartTime.
      // The offset = pcmStartTime - sessionStartTime aligns the two time bases.
      const timeOffsetMs = pcmData.pcmStartTime - sessionStartTime;
      console.log('[Groove] Time alignment: sessionStart=' + sessionStartTime.toFixed(1) +
        'ms, pcmStart=' + pcmData.pcmStartTime.toFixed(1) + 'ms, offset=' + timeOffsetMs.toFixed(1) + 'ms');

      anchors = extractEssentiaBeats(pcmData.signal, pcmData.sampleRate, timeOffsetMs);
      if (anchors) {
        console.log('[Groove] Using Essentia.js beat positions (' + anchors.length + ' anchors)');
      }
    }

    // Fallback: custom periodicity pipeline if Essentia unavailable or failed
    if (!anchors) {
      console.log('[Groove] Essentia unavailable, using custom periodicity pipeline');

      const periodicPulse = AdaptiveGrid.findPeriodicPulse(sessionOnsets, coarseBpm);
      if (!periodicPulse.anchors || periodicPulse.anchors.length < 3) {
        alert('Not enough regular beats detected. Try a more rhythmic pattern.');
        return null;
      }
      console.log('[Groove] periodic pulse:', Math.round(periodicPulse.bpm), 'BPM (' +
        Math.round(periodicPulse.period) + 'ms period)');

      const metricLevel = MetricSelector.selectMetricLevel(sessionOnsets, periodicPulse);
      console.log('[Groove] Metric level selected:', metricLevel.label,
        '→', Math.round(metricLevel.bpm * 10) / 10, 'BPM');

      let beatPulse;
      if (metricLevel.label === 'as-found') {
        beatPulse = periodicPulse;
      } else {
        beatPulse = AdaptiveGrid.findPeriodicPulse(sessionOnsets, metricLevel.bpm);
      }

      anchors = AdaptiveGrid.pulseToAnchors(beatPulse, sessionOnsets);
    }

    if (anchors.length < 4) {
      alert('Not enough regular beats detected. Try a more rhythmic pattern.');
      return null;
    }

    let grid = AdaptiveGrid.buildAdaptiveGrid(anchors);
    if (!grid) {
      alert('Could not build grid. Try playing a steadier rhythm.');
      return null;
    }

    let globalBpm = AdaptiveGrid.getGlobalBpm(grid);
    console.log('[Groove] final displayed BPM:', Math.round(globalBpm));
    tempo = globalBpm;

    // ── Match onsets to grid (no phase correction) ──
    // Essentia places beats where they actually are in the audio.
    // Phase correction would shift the grid away from ground truth.
    const classifiedOnsets = AdaptiveGrid.matchToAdaptiveGrid(sessionOnsets, grid);

    if (classifiedOnsets.length < 6) {
      alert('Not enough onsets matched to grid. Try a more rhythmic pattern.');
      return null;
    }

    const weightedMetrics = Analysis.computeWeightedMetrics(classifiedOnsets, grid.medianGridUnitMs);

    // Swing factor
    const swingResult = Analysis.computeSwingFactor(classifiedOnsets);
    if (swingResult) {
      console.log('[Groove] Swing: ' + swingResult.swingPercent + '% (' + swingResult.swingLabel + ', ' + swingResult.sampleCount + ' samples)');
    }

    // ── Per-band analysis ──
    // Match each frequency band's onsets against the adaptive grid
    const bandOnsets = OnsetDetector.getBandOnsets();
    const bands = OnsetDetector.getBands();
    const bandAnalysis = [];

    for (const band of bands) {
      const rawOnsets = bandOnsets[band.name];
      if (!rawOnsets || rawOnsets.length < 4) {
        bandAnalysis.push({ name: band.name, label: band.label, count: rawOnsets ? rawOnsets.length : 0 });
        continue;
      }

      // Normalize band onset times to session-relative (same as sessionOnsets)
      const normalizedOnsets = rawOnsets.map(o => ({
        time: o.time - sessionStartTime,
        amplitude: o.amplitude
      }));

      // Match to the adaptive grid
      const matched = AdaptiveGrid.matchToAdaptiveGrid(normalizedOnsets, grid);
      if (matched.length < 4) {
        bandAnalysis.push({ name: band.name, label: band.label, count: matched.length });
        continue;
      }

      // Compute position and consistency for this band
      const offsets = matched.map(o => o.offset);
      const avg = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - avg) ** 2, 0) / offsets.length);

      bandAnalysis.push({
        name: band.name,
        label: band.label,
        position: avg,
        consistency: sd,
        count: matched.length,
        onsets: matched
      });
      console.log('[Groove] Band "' + band.label + '": position=' +
        (avg >= 0 ? '+' : '') + avg.toFixed(1) + 'ms, consistency=±' +
        sd.toFixed(1) + 'ms (' + matched.length + ' onsets)');
    }

    // ── Drum attribution (v3 — hybrid approach) ──
    // Groups simultaneous per-band onsets into single drum events, classifies by
    // frequency profile. Uses attribution for kick/snare, raw band count for hi-hat.
    const drumCounts = runDrumAttribution(bandOnsets, sessionStartTime);
    if (drumCounts) {
      console.log('[Groove] Drum attribution: kick=' + drumCounts.kick +
        ', snare=' + drumCounts.snare + ', hihat=' + drumCounts.hihat +
        ' (from ' + drumCounts.totalBandOnsets + ' band onsets → ' +
        drumCounts.totalEvents + ' events)');
    }

    // Tempo curve from anchor intervals (smoothed)
    let tempoCurve = AdaptiveGrid.getTempoFromAnchors(grid);

    const durationMs = sessionOnsets.length > 0
      ? sessionOnsets[sessionOnsets.length - 1].time : 0;

    // Tempo stability from anchor-derived curve
    let tempoBpmStdDev = 0;
    if (tempoCurve.length >= 2) {
      const curveBpms = tempoCurve.map(p => p.bpm);
      const curveAvg = curveBpms.reduce((a, b) => a + b, 0) / curveBpms.length;
      tempoBpmStdDev = Math.sqrt(curveBpms.reduce((a, b) => a + (b - curveAvg) ** 2, 0) / curveBpms.length);
    }

    const feelLine = Feedback.generateSubdivisionFeelLine(
      weightedMetrics, globalBpm, tempoBpmStdDev
    );

    // Run diagnostics
    const diagGrid = {
      points: grid.points.map(p => p.time),
      gridUnitMs: grid.medianGridUnitMs,
      beatMs: grid.medianBeatMs,
      subdivisions: 4
    };
    const diagReport = Diagnostics.analyze(classifiedOnsets, diagGrid, globalBpm, null);

    const session = Storage.buildSessionObject({
      mode: 'freeplay',
      tempo: globalBpm,
      sensitivity,
      latencyOffset: null,
      avgOffset: weightedMetrics.position,
      stdDev: weightedMetrics.consistency,
      bpmStdDev: tempoBpmStdDev,
      avgBpm: globalBpm,
      hitCount: weightedMetrics.onsetCount,
      durationMs,
      offsets: classifiedOnsets.map(o => o.offset),
      onsets: classifiedOnsets,
      feelLine,
      tempoCurve,
      downbeatMetrics: weightedMetrics.downbeats,
      subdivisionMetrics: weightedMetrics.subdivisions,
      density: weightedMetrics.density,
      densityLabel: weightedMetrics.densityLabel,
      bandAnalysis,
      drumCounts,
      swingPercent: swingResult ? swingResult.swingPercent : null,
      swingLabel: swingResult ? swingResult.swingLabel : null
    });

    session._diagnostics = diagReport;
    session._gridUnitMs = grid.medianGridUnitMs;

    return session;
  }

  /**
   * Fixed-grid Free Play analysis at an exact BPM.
   * Used by the tempo override as a safety valve.
   */
  function analyzeFreePlayFixed(bpm) {
    tempo = bpm;
    const beatMs = 60000 / bpm;

    const grid = GridEstimator.buildGrid(freePlayOnsetTimes, bpm, 4);

    // Match onsets to grid (no phase correction)
    const matchedOnsets = [];
    for (const onset of sessionOnsets) {
      const onsetTimeMs = onset.time + sessionStartTime;
      const result = Analysis.computeOffset(onsetTimeMs, grid.points);
      if (!result) continue;
      if (result.distance > Analysis.maxSubdivisionOffsetMs(grid.gridUnitMs)) continue;
      matchedOnsets.push({
        time: onset.time,
        offset: result.offset,
        gridTime: result.gridTime,
        amplitude: onset.amplitude
      });
    }

    if (matchedOnsets.length < 6) {
      alert('Not enough onsets matched to grid at ' + Math.round(bpm) + ' BPM.');
      return null;
    }

    const classifiedOnsets = Analysis.classifyOnsets(matchedOnsets, grid);
    const weightedMetrics = Analysis.computeWeightedMetrics(classifiedOnsets, grid.gridUnitMs);

    const tempoCurve = TempoEstimator.computeTempoCurve(classifiedOnsets, bpm);

    const durationMs = sessionOnsets.length > 0
      ? sessionOnsets[sessionOnsets.length - 1].time : 0;

    let tempoBpmStdDev = 0;
    if (tempoCurve.length >= 2) {
      const curveBpms = tempoCurve.map(p => p.bpm);
      const curveAvg = curveBpms.reduce((a, b) => a + b, 0) / curveBpms.length;
      tempoBpmStdDev = Math.sqrt(curveBpms.reduce((a, b) => a + (b - curveAvg) ** 2, 0) / curveBpms.length);
    }

    const feelLine = Feedback.generateSubdivisionFeelLine(
      weightedMetrics, bpm, tempoBpmStdDev
    );

    return Storage.buildSessionObject({
      mode: 'freeplay',
      tempo: bpm,
      sensitivity,
      latencyOffset: null,
      avgOffset: weightedMetrics.position,
      stdDev: weightedMetrics.consistency,
      bpmStdDev: tempoBpmStdDev,
      avgBpm: bpm,
      hitCount: weightedMetrics.onsetCount,
      durationMs,
      offsets: classifiedOnsets.map(o => o.offset),
      onsets: classifiedOnsets,
      feelLine,
      tempoCurve,
      downbeatMetrics: weightedMetrics.downbeats,
      subdivisionMetrics: weightedMetrics.subdivisions,
      density: weightedMetrics.density,
      densityLabel: weightedMetrics.densityLabel
    });
  }

  /**
   * Show an inline input on the tempo metric card to override BPM.
   * Reruns the full analysis pipeline at the new BPM and re-renders.
   */
  function editFreePlayTempo() {
    const overrideEl = document.getElementById('tempo-override');
    const mbEl = document.getElementById('mb');
    const currentBpm = parseInt(mbEl.textContent);

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'tempo-override-input';
    input.min = 30;
    input.max = 300;
    input.value = currentBpm;

    function commit() {
      const val = Math.max(30, Math.min(300, Math.round(Number(input.value) || currentBpm)));
      // Restore the override row
      overrideEl.innerHTML =
        '<span class="tempo-override-label">Detected BPM wrong?</span>' +
        '<button class="btn secondary tempo-override-btn" onclick="App.editFreePlayTempo()">Override</button>';

      if (val === currentBpm) return;

      // Override uses fixed grid refined around user's value
      const refined = TempoEstimator.refineTempo(freePlayOnsetTimes, val, 2, 0.1);
      lastCoarseBpm = null; // user override, no coarse/refined comparison

      const session = analyzeFreePlayFixed(refined);
      if (!session) return;

      // Delete the previous auto-saved session and save the corrected one
      const allSessions = Storage.getAllSessions();
      if (allSessions.length > 0) {
        Storage.deleteSession(allSessions[0].id);
      }
      Storage.saveSession(session);
      renderResults(session);
    }

    // Replace the override row content with the input
    overrideEl.innerHTML = '<span class="tempo-override-label">BPM:</span>';
    overrideEl.appendChild(input);

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn primary tempo-override-btn';
    applyBtn.textContent = 'Apply';
    applyBtn.onclick = () => input.blur();
    overrideEl.appendChild(applyBtn);

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = currentBpm; input.blur(); }
    });

    input.focus();
    input.select();
  }

  // ── Shared Results Renderer ──
  function renderResults(session) {
    showScreen('screen-res');

    document.getElementById('fl').textContent = session.feelLine;

    // Metric cards
    document.getElementById('mp').textContent =
      (session.pocketPosition >= 0 ? '+' : '') + Math.round(session.pocketPosition) + 'ms';
    document.getElementById('mpc').textContent = Feedback.positionLabel(session.pocketPosition);

    document.getElementById('mc').textContent = '\u00b1' + Math.round(session.pocketConsistency) + 'ms';
    document.getElementById('mcc').textContent = Feedback.consistencyLabel(session.pocketConsistency);

    document.getElementById('mb').textContent = Math.round(session.detectedBpm);
    document.getElementById('mbc').textContent = Feedback.tempoLabel(session.tempoStability);

    // Swing factor
    const swingCard = document.getElementById('swing-card');
    if (session.swingPercent != null) {
      swingCard.style.display = '';
      document.getElementById('ms').textContent = session.swingPercent + '%';
      document.getElementById('msc').textContent = session.swingLabel || '';
    } else {
      swingCard.style.display = 'none';
    }

    // Tempo override (Free Play only)
    const tempoOverride = document.getElementById('tempo-override');
    if (session.mode === 'freeplay') {
      tempoOverride.style.display = 'flex';
      let overrideLabel = 'Wrong tempo?';
      if (lastCoarseBpm && Math.abs(lastCoarseBpm - session.detectedBpm) > 2) {
        overrideLabel = 'Coarse ' + Math.round(lastCoarseBpm) +
          ' \u2192 Adaptive ' + Math.round(session.detectedBpm) + ' BPM';
      }
      tempoOverride.innerHTML =
        '<span class="tempo-override-label">' + overrideLabel + '</span>' +
        '<button class="btn secondary tempo-override-btn" onclick="App.editFreePlayTempo()">Override</button>';
    } else {
      tempoOverride.style.display = 'none';
    }

    // Target comparison label
    const targetLabel = document.getElementById('target-label');
    if (session.targetName && session.targetMin != null) {
      const inZone = session.pocketPosition >= session.targetMin && session.pocketPosition <= session.targetMax;
      const dist = inZone ? 0 :
        session.pocketPosition < session.targetMin ? session.targetMin - session.pocketPosition :
        session.pocketPosition - session.targetMax;
      if (inZone) {
        targetLabel.textContent = 'In the zone';
        targetLabel.style.color = 'var(--teal)';
      } else if (dist < 10) {
        targetLabel.textContent = `Close \u2014 ${Math.round(dist)}ms to go`;
        targetLabel.style.color = 'var(--amber)';
      } else {
        targetLabel.textContent = `${Math.round(dist)}ms from the zone`;
        targetLabel.style.color = 'var(--coral)';
      }
      targetLabel.style.display = 'block';
    } else {
      targetLabel.style.display = 'none';
    }

    // Breakdown row (subdivision metrics for Free Play)
    const breakdownRow = document.getElementById('breakdown-row');
    if (session.downbeatMetrics || session.subdivisionMetrics) {
      breakdownRow.style.display = 'grid';
      if (session.downbeatMetrics) {
        const dm = session.downbeatMetrics;
        document.getElementById('bd-val').textContent =
          (dm.position >= 0 ? '+' : '') + Math.round(dm.position) + 'ms \u00b1' + Math.round(dm.consistency) + 'ms';
        document.getElementById('bd-count').textContent = dm.count + ' hits';
      } else {
        document.getElementById('bd-val').textContent = '\u2014';
        document.getElementById('bd-count').textContent = '';
      }
      if (session.subdivisionMetrics) {
        const sm = session.subdivisionMetrics;
        document.getElementById('gn-val').textContent =
          (sm.position >= 0 ? '+' : '') + Math.round(sm.position) + 'ms \u00b1' + Math.round(sm.consistency) + 'ms';
        document.getElementById('gn-count').textContent = sm.count + ' hits';
      } else {
        document.getElementById('gn-val').textContent = '\u2014';
        document.getElementById('gn-count').textContent = '';
      }
    } else {
      breakdownRow.style.display = 'none';
    }

    // Tempo curve section
    const tempoCurveSection = document.getElementById('tempo-curve-section');
    if (session.tempoCurve && session.tempoCurve.length >= 2) {
      tempoCurveSection.style.display = 'block';
      Visualizations.drawTempoCurve(
        document.getElementById('tc-canvas'), session.tempoCurve, session.detectedBpm
      );
    } else {
      tempoCurveSection.style.display = 'none';
    }

    // Raw data
    const rawLatency = session.latencyOffset != null ? session.latencyOffset.toFixed(1) : 'N/A';
    const beatMs = 60000 / session.detectedBpm;
    document.getElementById('rp').textContent =
      `Mode: ${session.mode} | Latency: ${rawLatency}ms | Hits: ${session.onsetCount} | SR: ${Audio.getSampleRate ? Audio.getSampleRate() : '?'}Hz\n` +
      `Beat: ${beatMs.toFixed(0)}ms | Sens: ${session.sensitivity}%` +
      (session.targetName ? ` | Target: ${session.targetName}` : '') + '\n\n' +
      session.offsets.map((o, i) =>
        `#${i + 1}: ${o >= 0 ? '+' : ''}${o.toFixed(1)}ms` +
        (session.onsets && session.onsets[i] ? ` @ ${(session.onsets[i].time / 1000).toFixed(1)}s` : '')
      ).join('\n');

    // Pocket landing with optional target
    const target = session.targetMin != null ? {
      positionMin: session.targetMin,
      positionMax: session.targetMax
    } : null;
    Visualizations.drawPocketLanding(
      document.getElementById('pc'), session.offsets, session.pocketPosition, session.pocketConsistency, target, session.onsets
    );

    // Session timeline
    const onsetsForTimeline = session.onsets || session.offsets.map((o, i) => ({
      time: i * (beatMs || 667),
      offset: o
    }));
    Visualizations.drawTimeline(document.getElementById('sc2'), onsetsForTimeline);

    // Drum counts display
    const drumSection = document.getElementById('drum-counts-section');
    const drumRow = document.getElementById('drum-counts-row');
    if (session.drumCounts && drumSection && drumRow) {
      drumSection.style.display = 'block';
      const dc = session.drumCounts;
      const drums = [
        { label: 'Kick', count: dc.kick, color: 'var(--coral, #fb7185)' },
        { label: 'Snare', count: dc.snare, color: 'var(--amber, #fbbf24)' },
        { label: 'Hi-hat', count: dc.hihat, color: 'var(--teal, #2dd4bf)' }
      ];
      drumRow.innerHTML = drums.map(function(d) {
        return '<div class="drum-count-card">' +
          '<div class="drum-count-label">' + d.label + '</div>' +
          '<div class="drum-count-value" style="color:' + d.color + '">' + d.count + '</div>' +
          '<div class="drum-count-sub">onsets</div></div>';
      }).join('');
    } else if (drumSection) {
      drumSection.style.display = 'none';
    }

    // Combined band analysis + timelines (paired rows)
    const bandSection = document.getElementById('band-analysis-section');
    const bandContainer = document.getElementById('band-rows-container');
    if (session.bandAnalysis && session.bandAnalysis.length > 0) {
      const hasBandData = session.bandAnalysis.some(b => b.position !== undefined);
      if (hasBandData) {
        bandSection.style.display = 'block';
        bandContainer.innerHTML = '';

        const maxTime = onsetsForTimeline.length > 0
          ? onsetsForTimeline[onsetsForTimeline.length - 1].time : 1;

        for (const band of session.bandAnalysis) {
          const row = document.createElement('div');
          row.className = 'band-row';

          // Card (left side)
          const card = document.createElement('div');
          card.className = 'band-card' + (band.position === undefined ? ' band-card--insufficient' : '');

          if (band.position !== undefined) {
            const posStr = (band.position >= 0 ? '+' : '') + Math.round(band.position) + 'ms';
            const conStr = '\u00b1' + Math.round(band.consistency) + 'ms';
            card.innerHTML =
              '<div class="band-card-label">' + band.label + '</div>' +
              '<canvas class="band-pocket-canvas"></canvas>' +
              '<div class="band-card-position">' + posStr + '</div>' +
              '<div class="band-card-consistency">' + conStr + '</div>' +
              '<div class="band-card-count">' + band.count + ' onsets</div>';
          } else {
            card.innerHTML =
              '<div class="band-card-label">' + band.label + '</div>' +
              '<div class="band-card-position">\u2014</div>' +
              '<div class="band-card-count">too few onsets (' + band.count + ')</div>';
          }
          row.appendChild(card);

          // Timeline (right side)
          if (band.onsets && band.onsets.length > 4) {
            const timelineWrap = document.createElement('div');
            timelineWrap.className = 'band-timeline-wrap';
            const canvas = document.createElement('canvas');
            canvas.className = 'band-timeline-canvas';
            timelineWrap.appendChild(canvas);
            row.appendChild(timelineWrap);
          }

          bandContainer.appendChild(row);

          // Draw canvases after they're in the DOM
          if (band.position !== undefined && band.onsets && band.onsets.length > 4) {
            const pocketCanvas = card.querySelector('.band-pocket-canvas');
            if (pocketCanvas) {
              Visualizations.drawBandPocketLanding(
                pocketCanvas, band.onsets, band.name, band.position, band.consistency
              );
            }
            const timelineCanvas = row.querySelector('.band-timeline-canvas');
            if (timelineCanvas) {
              Visualizations.drawBandTimeline(timelineCanvas, band.onsets, band.name, band.label, maxTime);
            }
          }
        }
      } else {
        bandSection.style.display = 'none';
      }
    } else {
      bandSection.style.display = 'none';
    }

    // Diagnostics panel
    const diagSection = document.getElementById('diagnostics-section');
    const diagContent = document.getElementById('diagnostics-content');
    if (session._diagnostics && diagSection && diagContent) {
      diagSection.style.display = '';
      diagContent.innerHTML = Diagnostics.renderPanel(
        session._diagnostics, session._gridUnitMs, null
      );
      // Draw phase sweep chart after DOM is ready
      requestAnimationFrame(() => {
        Diagnostics.drawPhaseSweepChart(
          'diag-phase-canvas',
          session._diagnostics.phase.sweepData,
          session._diagnostics.phase.optimalShiftMs
        );
      });
    } else if (diagSection) {
      diagSection.style.display = 'none';
    }

    // Session saved confirmation
    const savedEl = document.getElementById('session-saved');
    savedEl.style.opacity = '1';
    setTimeout(() => { savedEl.style.opacity = '0'; }, 2000);
  }

  // ── Pocket Playground ──
  function renderTargetSelection() {
    const container = document.getElementById('pg-targets');
    const targets = PocketTargets.getAll();
    const allSessions = Storage.getAllSessions();

    container.innerHTML = targets.map(t => {
      const dots = PocketTargets.getDifficultyDots(t.difficulty);
      const dotStr = '\u25CF'.repeat(dots) + '\u25CB'.repeat(3 - dots);

      // Best consistency from history
      const targetSessions = allSessions.filter(s => s.targetName === t.name);
      const bestConsistency = targetSessions.length > 0
        ? Math.min(...targetSessions.filter(s => {
            return s.pocketPosition >= t.positionMin && s.pocketPosition <= t.positionMax;
          }).map(s => s.pocketConsistency))
        : null;
      const bestStr = bestConsistency != null && isFinite(bestConsistency)
        ? `<span class="pg-best">Best: \u00b1${Math.round(bestConsistency)}ms</span>` : '';

      return `
        <div class="pg-target-card card" onclick="App.selectTarget('${t.id}')">
          <div class="pg-target-header">
            <div class="pg-target-name">${t.name}</div>
            <div class="pg-target-dots">${dotStr}</div>
          </div>
          <div class="pg-target-desc">${t.description}</div>
          <div class="pg-target-meta">
            <span class="pg-genre">${t.genre}</span>
            <span class="pg-range">${t.positionMin >= 0 ? '+' : ''}${t.positionMin} to ${t.positionMax >= 0 ? '+' : ''}${t.positionMax}ms</span>
            ${bestStr}
          </div>
        </div>
      `;
    }).join('');
  }

  function selectTarget(targetId) {
    selectedTarget = PocketTargets.getById(targetId);
    if (!selectedTarget) return;

    tempo = selectedTarget.defaultTempo;
    document.getElementById('pg-tempo-value').textContent = tempo;
    document.getElementById('pg-target-title').textContent = selectedTarget.name;
    document.getElementById('pg-target-desc-text').textContent = selectedTarget.description;
    document.getElementById('pg-target-reference').textContent = selectedTarget.reference;
    document.getElementById('pg-target-range').textContent =
      `Land your notes in the ${selectedTarget.positionMin >= 0 ? '+' : ''}${selectedTarget.positionMin} to ${selectedTarget.positionMax >= 0 ? '+' : ''}${selectedTarget.positionMax}ms zone`;

    resetPlaygroundSetup();
    showScreen('screen-pg-setup');
  }

  function startPlaygroundCalibration() {
    startCalibration();
  }

  // ── History ──
  function showHistory() {
    showScreen('screen-history');
    renderHistory();
  }

  function renderHistory() {
    const sessions = Storage.getAllSessions();
    const summary = Storage.getProgressSummary();

    // Progress summary
    const summaryEl = document.getElementById('history-summary');
    if (!summary || !sessions.length) {
      summaryEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">No sessions yet. Go play!</p>';
      document.getElementById('history-list').innerHTML = '';
      return;
    }

    let summaryHtml = `<div class="history-stats">
      <span>${summary.totalSessions} session${summary.totalSessions !== 1 ? 's' : ''}</span>`;
    if (summary.streak > 0) {
      summaryHtml += `<span>${summary.streak} day streak</span>`;
    }
    summaryHtml += `</div>`;

    if (summary.olderAvgConsistency != null) {
      const consDiff = summary.olderAvgConsistency - summary.recentAvgConsistency;
      if (consDiff > 1) {
        summaryHtml += `<p class="history-trend">Consistency improving: \u00b1${Math.round(summary.recentAvgConsistency)}ms (was \u00b1${Math.round(summary.olderAvgConsistency)}ms)</p>`;
      }
    }
    summaryEl.innerHTML = summaryHtml;

    // Progress chart
    if (sessions.length >= 2) {
      document.getElementById('progress-chart-section').style.display = 'block';
      const chartSessions = sessions.slice(0, 30);
      Visualizations.drawProgressChart(document.getElementById('progress-canvas'), chartSessions);
    } else {
      document.getElementById('progress-chart-section').style.display = 'none';
    }

    // Session list
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = sessions.map(s => {
      const date = formatDate(s.timestamp);
      const modeIcon = s.mode === 'freeplay' ? '\u223F' : s.mode === 'playground' ? '\u25CE' : '\u2A09';
      const posStr = (s.pocketPosition >= 0 ? '+' : '') + Math.round(s.pocketPosition) + 'ms';
      const consStr = '\u00b1' + Math.round(s.pocketConsistency) + 'ms';
      const targetStr = s.targetName ? ` \u2022 ${s.targetName}` : '';
      const feelTrunc = s.feelLine && s.feelLine.length > 80
        ? s.feelLine.substring(0, 77) + '...' : (s.feelLine || '');

      return `
        <div class="history-card card" onclick="App.viewSession('${s.id}')">
          <div class="history-card-header">
            <span class="history-mode">${modeIcon}</span>
            <span class="history-date">${date}</span>
            <span class="history-metrics">${posStr} ${consStr}</span>
          </div>
          <div class="history-card-detail">
            ${Math.round(s.detectedBpm)} BPM${targetStr}
          </div>
          <div class="history-card-feel">${feelTrunc}</div>
        </div>
      `;
    }).join('');
  }

  function formatDate(timestamp) {
    const d = new Date(timestamp);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const sessionDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sessionDay.getTime() === today.getTime()) return `Today ${timeStr}`;
    if (sessionDay.getTime() === yesterday.getTime()) return `Yesterday ${timeStr}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${timeStr}`;
  }

  function viewSession(sessionId) {
    const session = Storage.getSession(sessionId);
    if (!session) return;
    appMode = session.mode === 'freeplay' ? 'freeplay' :
              session.mode === 'playground' ? 'playground' : 'click';
    renderResults(session);
  }

  // ── Play Again / Reset ──
  function playAgain() {
    if (appMode === 'freeplay') {
      startFreePlayRecording();
    } else {
      startSession();
    }
  }

  function resetAll() {
    stopEverything();
    goHome();
  }

  function stopEverything() {
    mode = 'idle';
    Grid.stopClick();
    OnsetDetector.setActive(false);
    stopBpmEstimation();
    clearTimers();
  }

  function clearTimers() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = null; }
  }

  // ── Public API ──
  return {
    changeTempo,
    changePlaygroundTempo,
    editTempo,
    updateSensitivity,
    updateFpSensitivity,
    updatePgSensitivity,
    startSoundCheck,
    startCalibration,
    finishCalibration,
    stopSession,
    startFreePlayGo,
    stopFreePlayRecording,
    editFreePlayTempo,
    playAgain,
    resetAll,
    goHome,
    startClickMode,
    startFreePlayMode,
    startPlaygroundMode,
    startPlaygroundCalibration,
    selectTarget,
    showHistory,
    viewSession
  };
})();
