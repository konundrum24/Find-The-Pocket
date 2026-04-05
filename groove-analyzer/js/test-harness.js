/**
 * Test Harness — Automated experiment runner for the groove analyzer.
 *
 * Runs the full analysis pipeline (onset detection + Essentia + grid + metrics)
 * on audio files across multiple configurations (phase correction modes, engine
 * parameters, song segments) without human interaction.
 *
 * This module replicates the analysis pipeline from app.js but without any DOM
 * dependencies, allowing it to run independently in test-harness.html.
 */
const TestHarness = (function () {
  'use strict';

  // ============================================================
  // EXPERIMENT CONFIGURATION
  // ============================================================

  const DEFAULT_EXPERIMENT = {
    songs: [
      {
        name: 'Chicken Grease',
        file: 'test-audio/chicken-grease.m4a',
        expectedPocket: 'behind',
        segments: [
          { start: 92, end: 157, label: '1:32-2:37' },
        ]
      },
    ],

    phaseConfigs: ['A', 'B', 'C'],

    engineParams: [
      {
        label: 'default',
        fftHF: 1024, fftLF: 4096,
        bufferHF: 512, bufferLF: 2048,
        sensitivity: 8
      },
    ],

    runsPerCombination: 1,
    trimJitterMs: 0,
  };

  // ============================================================
  // ESSENTIA INTEGRATION
  // ============================================================

  let essentia = null;
  let essentiaReady = false;

  async function initEssentia() {
    try {
      if (typeof EssentiaWASM !== 'undefined') {
        const wasmModule = await EssentiaWASM();
        essentia = new Essentia(wasmModule);
        essentiaReady = true;
        console.log('[Harness] Essentia.js ready');
      } else {
        console.warn('[Harness] EssentiaWASM not found');
      }
    } catch (err) {
      console.warn('[Harness] Essentia.js init failed:', err.message);
    }
  }

  /**
   * Extract beat anchors from PCM using Essentia RhythmExtractor2013.
   * Mirrors extractEssentiaBeats() in app.js but standalone.
   */
  function extractEssentiaBeats(signal, sampleRate) {
    if (!essentiaReady || !essentia) return null;

    const vectorSignal = essentia.arrayToVector(signal);
    let rhythmResult;
    try {
      rhythmResult = essentia.RhythmExtractor2013(vectorSignal, 220, 'multifeature', 40);
    } catch (err) {
      console.warn('[Harness] RhythmExtractor2013 failed:', err.message);
      try { vectorSignal.delete(); } catch (e) {}
      return null;
    }

    const bpm = rhythmResult.bpm;
    if (!bpm || isNaN(bpm)) {
      try { vectorSignal.delete(); } catch (e) {}
      return null;
    }

    let ticksRaw;
    try {
      ticksRaw = essentia.vectorToArray(rhythmResult.ticks);
    } catch (err) {
      try { vectorSignal.delete(); } catch (e) {}
      return null;
    }
    const ticks = Array.from(ticksRaw).map(Number);

    // Clean up ALL WASM vectors
    try { rhythmResult.ticks.delete(); } catch (e) {}
    try { rhythmResult.estimates.delete(); } catch (e) {}
    try { rhythmResult.bpmIntervals.delete(); } catch (e) {}
    try { vectorSignal.delete(); } catch (e) {}

    const validTicks = ticks.filter(t => !isNaN(t) && t >= 0);
    if (validTicks.length < 4) return null;

    // File input: timeOffset = 0 (both onset times and Essentia ticks are PCM-relative)
    const anchors = [];
    for (let i = 0; i < validTicks.length; i++) {
      const timeMs = validTicks[i] * 1000;
      if (i === 0 || timeMs - anchors[anchors.length - 1].time >= 200) {
        anchors.push({ time: timeMs, amplitude: 1, interpolated: false });
      }
    }

    return { anchors, bpm };
  }

  // ============================================================
  // DRUM ATTRIBUTION (replicated from app.js)
  // ============================================================

  function runDrumAttribution(bandOnsets) {
    const COINCIDENCE_WINDOW_MS = 15;
    const SINGLE_BAND_MERGE_MS = 50;
    const MERGE_WINDOW_MS = 30;
    const bandNames = ['kick', 'bass', 'mid', 'snare', 'hihat'];

    var allOnsets = [];
    for (var bi = 0; bi < bandNames.length; bi++) {
      var bName = bandNames[bi];
      var onsets = bandOnsets[bName] || [];
      for (var oi = 0; oi < onsets.length; oi++) {
        allOnsets.push({ time: onsets[oi].time, amplitude: onsets[oi].amplitude, band: bName });
      }
    }
    allOnsets.sort(function (a, b) { return a.time - b.time; });
    if (allOnsets.length === 0) return null;

    var events = [];
    var currentEvent = { onsets: [allOnsets[0]], startTime: allOnsets[0].time };
    for (var i = 1; i < allOnsets.length; i++) {
      var o = allOnsets[i];
      if (o.time - currentEvent.startTime <= COINCIDENCE_WINDOW_MS) {
        var existing = currentEvent.onsets.find(function (e) { return e.band === o.band; });
        if (!existing) { currentEvent.onsets.push(o); }
        else if (o.amplitude > existing.amplitude) { existing.amplitude = o.amplitude; existing.time = o.time; }
      } else {
        events.push(currentEvent);
        currentEvent = { onsets: [o], startTime: o.time };
      }
    }
    events.push(currentEvent);

    // Post-grouping merge
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
            var ex = evA.onsets.find(function (e) { return e.band === onset.band; });
            if (!ex) { evA.onsets.push(onset); }
            else if (onset.amplitude > ex.amplitude) { ex.amplitude = onset.amplitude; ex.time = onset.time; }
          }
          events.splice(m + 1, 1);
          merged = true;
          break;
        }
      }
    }

    // Classify
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
        var maxBand = bandNames[0];
        for (var di = 1; di < bandNames.length; di++) {
          if (profile[bandNames[di]] > profile[maxBand]) maxBand = bandNames[di];
        }
        if (maxBand === 'kick') kickCount++;
        else if (maxBand === 'hihat') hihatAttrCount++;
        else snareCount++;
      }
    }

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

  // ============================================================
  // ANALYSIS PIPELINE (mirrors analyzeFreePlayAdaptive in app.js)
  // ============================================================

  /**
   * Run the complete analysis pipeline on pre-detected onsets + PCM.
   *
   * @param {Array} sessionOnsets - broadband onsets [{time, amplitude}]
   * @param {Object} bandOnsets - per-band onset arrays
   * @param {Float32Array} pcm - trimmed PCM for Essentia
   * @param {number} sampleRate
   * @param {string} phaseConfig - 'A', 'B', or 'C'
   * @param {Object} cachedEssentia - optional {anchors, bpm} to reuse
   * @returns {Object|null} structured results
   */
  function runAnalysisPipeline(sessionOnsets, bandOnsets, pcm, sampleRate, phaseConfig, cachedEssentia) {
    const t0 = performance.now();

    // ── Coarse BPM from flux (already have sessionOnsets, need fluxEnvelope) ──
    // When called from the harness, we pass cachedEssentia, so coarse BPM is just for fallback.
    // We always prefer Essentia beats.

    let anchors = null;
    let onsetPhaseShiftMs = null;
    let onsetStructuralCount = null;
    let essentiaBpm = null;

    // Step 1: Get Essentia beat anchors
    if (cachedEssentia && cachedEssentia.anchors) {
      // Deep copy anchors so phase correction doesn't mutate the cached version
      anchors = cachedEssentia.anchors.map(a => ({ ...a }));
      essentiaBpm = cachedEssentia.bpm;
    } else {
      const essentiaResult = extractEssentiaBeats(pcm, sampleRate);
      if (essentiaResult) {
        anchors = essentiaResult.anchors;
        essentiaBpm = essentiaResult.bpm;
      }
    }

    if (!anchors || anchors.length < 4) {
      console.warn('[Harness] Not enough Essentia anchors');
      return null;
    }

    // Step 2: Phase correction
    if (phaseConfig === 'B') {
      const phaseResult = PhaseAlignment.correctPhase(anchors, sessionOnsets);
      if (phaseResult.improved) {
        anchors = phaseResult.anchors;
        onsetPhaseShiftMs = phaseResult.phaseShiftMs;
      }
    } else if (phaseConfig === 'C') {
      const avgIntervalMs = (anchors[anchors.length - 1].time - anchors[0].time) / (anchors.length - 1);
      const structuralOnsets = PhaseAlignment.selectStructuralOnsets(sessionOnsets, avgIntervalMs);
      if (structuralOnsets) {
        const phaseResult = PhaseAlignment.correctPhase(anchors, structuralOnsets);
        if (phaseResult.improved) {
          anchors = phaseResult.anchors;
          onsetPhaseShiftMs = phaseResult.phaseShiftMs;
          onsetStructuralCount = structuralOnsets.length;
        }
      }
    }

    // Step 3: Build adaptive grid
    const grid = AdaptiveGrid.buildAdaptiveGrid(anchors);
    if (!grid) {
      console.warn('[Harness] Could not build grid');
      return null;
    }

    const globalBpm = AdaptiveGrid.getGlobalBpm(grid);

    // Step 4: Match onsets to grid
    const classifiedOnsets = AdaptiveGrid.matchToAdaptiveGrid(sessionOnsets, grid);
    if (classifiedOnsets.length < 6) {
      console.warn('[Harness] Only ' + classifiedOnsets.length + ' onsets matched');
      return null;
    }

    // Step 5: Compute metrics
    const weightedMetrics = Analysis.computeWeightedMetrics(classifiedOnsets, grid.medianGridUnitMs);
    const swingResult = Analysis.computeSwingFactor(classifiedOnsets);

    // Step 6: Per-band analysis
    const bands = [
      { name: 'kick', label: 'Kick (40\u2013150 Hz)' },
      { name: 'bass', label: 'Bass (150\u2013400 Hz)' },
      { name: 'mid', label: 'Mid (400 Hz\u20132 kHz)' },
      { name: 'snare', label: 'Snare Crack (2\u20135 kHz)' },
      { name: 'hihat', label: 'Hi-hat (6\u201316 kHz)' }
    ];
    const bandAnalysis = [];

    for (const band of bands) {
      const rawOnsets = bandOnsets[band.name];
      if (!rawOnsets || rawOnsets.length < 4) {
        bandAnalysis.push({ name: band.name, label: band.label, count: rawOnsets ? rawOnsets.length : 0 });
        continue;
      }

      // Band onset times are already PCM-relative (session-relative for file input)
      const normalizedOnsets = rawOnsets.map(o => ({ time: o.time, amplitude: o.amplitude }));

      let matched = null;
      let gridLabel = '';
      let matchRate = 0;
      let patternInfo = null;

      const pattern = PatternGrid.detectPattern(normalizedOnsets, anchors);
      if (pattern) {
        const pGrid = PatternGrid.buildPatternGrid(pattern, anchors, grid);
        matched = PatternGrid.matchToPatternGrid(normalizedOnsets, pGrid);
        matchRate = matched.length / normalizedOnsets.length;
        gridLabel = pattern.cycleLength + '-beat pattern (' + pattern.positions.length + ' positions)';
        patternInfo = {
          cycleLength: pattern.cycleLength,
          positionCount: pattern.positions.length,
          positions: pattern.positions,
          coverageRatio: pattern.coverageRatio
        };
      }

      if (!matched || matched.length < 4) {
        const best = AdaptiveGrid.selectBestResolution(normalizedOnsets, anchors);
        matched = best.matched;
        matchRate = best.matchRate;
        gridLabel = best.label + '-note grid';
        patternInfo = null;
      }

      if (matched.length < 4) {
        bandAnalysis.push({ name: band.name, label: band.label, count: matched.length });
        continue;
      }

      const offsets = matched.map(o => o.offset);
      const avg = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - avg) ** 2, 0) / offsets.length);

      bandAnalysis.push({
        name: band.name,
        label: band.label,
        position: avg,
        consistency: sd,
        count: matched.length,
        gridResolution: gridLabel,
        matchRate: matchRate,
        pattern: patternInfo
      });
    }

    // Step 7: Drum attribution
    const drumCounts = runDrumAttribution(bandOnsets);

    // Step 8: Diagnostics
    const diagGrid = {
      points: grid.points.map(p => p.time),
      gridUnitMs: grid.medianGridUnitMs,
      beatMs: grid.medianBeatMs,
      subdivisions: 4
    };
    const diagReport = Diagnostics.analyze(classifiedOnsets, diagGrid, globalBpm, null);

    const totalMs = performance.now() - t0;

    // Build results object
    return {
      overallPosition: weightedMetrics.position,
      overallConsistency: weightedMetrics.consistency,
      bpm: globalBpm,
      swing: swingResult ? swingResult.swingPercent : null,
      swingLabel: swingResult ? swingResult.swingLabel : null,
      downbeatPosition: weightedMetrics.downbeats ? weightedMetrics.downbeats.position : null,
      downbeatConsistency: weightedMetrics.downbeats ? weightedMetrics.downbeats.consistency : null,
      downbeatCount: weightedMetrics.downbeats ? weightedMetrics.downbeats.count : null,
      ghostNotePosition: weightedMetrics.subdivisions ? weightedMetrics.subdivisions.position : null,
      ghostNoteConsistency: weightedMetrics.subdivisions ? weightedMetrics.subdivisions.consistency : null,
      ghostNoteCount: weightedMetrics.subdivisions ? weightedMetrics.subdivisions.count : null,
      bands: {},
      bandAnalysis: bandAnalysis,
      drumCounts: drumCounts,
      gridDiagnostics: diagReport ? {
        phaseError: diagReport.phaseError,
        clusterStrength: diagReport.clusterStrength,
        drift: diagReport.drift
      } : null,
      phaseCorrection: {
        applied: onsetPhaseShiftMs !== null,
        shiftMs: onsetPhaseShiftMs,
        structuralOnsetCount: onsetStructuralCount
      },
      totalAnalysisMs: totalMs,
      onsetCount: classifiedOnsets.length,
      density: weightedMetrics.density,
      densityLabel: weightedMetrics.densityLabel,
    };
  }

  // ============================================================
  // MAIN EXPERIMENT RUNNER
  // ============================================================

  let lastOutput = null;

  async function runExperimentSuite(config, uploadedFiles) {
    config = config || DEFAULT_EXPERIMENT;
    const results = [];
    const errors = [];
    const startTime = Date.now();

    // Calculate total runs
    let totalRuns = 0;
    for (const song of config.songs) {
      totalRuns += song.segments.length
        * config.phaseConfigs.length
        * config.engineParams.length
        * config.runsPerCombination;
    }

    let completedRuns = 0;
    updateProgress(0, totalRuns, 'Starting experiment...');

    // Load and cache audio files
    const audioCache = {};
    for (const song of config.songs) {
      updateProgress(completedRuns, totalRuns, 'Loading ' + song.name + '...');

      try {
        let pcm, sampleRate, duration;

        if (uploadedFiles && uploadedFiles[song.name]) {
          // Use uploaded file
          const fileData = await FileInput.loadAudioFile(uploadedFiles[song.name]);
          pcm = fileData.pcm;
          sampleRate = fileData.sampleRate;
          duration = fileData.duration;
        } else {
          // Fetch from test-audio/
          const response = await fetch(song.file);
          if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + song.file);
          const arrayBuffer = await response.arrayBuffer();
          const audioContext = new AudioContext({ sampleRate: 44100 });
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          await audioContext.close();

          if (audioBuffer.numberOfChannels === 1) {
            pcm = new Float32Array(audioBuffer.getChannelData(0));
          } else {
            const left = audioBuffer.getChannelData(0);
            const right = audioBuffer.getChannelData(1);
            pcm = new Float32Array(left.length);
            for (let i = 0; i < left.length; i++) {
              pcm[i] = (left[i] + right[i]) * 0.5;
            }
          }
          sampleRate = 44100;
          duration = audioBuffer.duration;
        }

        audioCache[song.name] = { pcm, sampleRate, duration };
        console.log('[Harness] Loaded ' + song.name + ': ' + duration.toFixed(1) + 's, ' + pcm.length + ' samples');
      } catch (err) {
        const msg = 'Failed to load ' + song.name + ': ' + err.message;
        console.error('[Harness] ' + msg);
        errors.push({ song: song.name, error: msg });
        continue;
      }
    }

    // Run all combinations
    for (const song of config.songs) {
      const cached = audioCache[song.name];
      if (!cached) continue;

      for (const segment of song.segments) {
        const startSample = Math.floor(segment.start * cached.sampleRate);
        const endSample = Math.min(Math.floor(segment.end * cached.sampleRate), cached.pcm.length);
        const trimmedPCM = cached.pcm.slice(startSample, endSample);
        const segmentDuration = (endSample - startSample) / cached.sampleRate;

        for (const engineParam of config.engineParams) {
          // Run onset detection once per engine config
          const onsetStartTime = Date.now();
          const onsetResult = FileInput.detectOnsetsOffline(trimmedPCM, cached.sampleRate, {
            fftSizeHF: engineParam.fftHF,
            fftSizeLF: engineParam.fftLF,
            bufferSizeHF: engineParam.bufferHF,
            bufferSizeLF: engineParam.bufferLF,
            sensitivity: engineParam.sensitivity,
          });
          const onsetMs = Date.now() - onsetStartTime;

          if (onsetResult.sessionOnsets.length < 8) {
            console.warn('[Harness] Only ' + onsetResult.sessionOnsets.length +
              ' onsets for ' + song.name + ' ' + segment.label + ' — skipping');
            // Record failures for all phase configs
            for (const phaseConfig of config.phaseConfigs) {
              completedRuns++;
              updateProgress(completedRuns, totalRuns,
                song.name + ' | ' + segment.label + ' | ' + engineParam.label + ' | Phase ' + phaseConfig + ' (skipped)');
              results.push({
                song: song.name, segment: segment.label,
                segmentStart: segment.start, segmentEnd: segment.end, segmentDuration: segmentDuration,
                phaseConfig: phaseConfig, engineParams: engineParam.label,
                error: 'Insufficient onsets (' + onsetResult.sessionOnsets.length + ')',
              });
            }
            continue;
          }

          // Run Essentia once per segment+engine combo (reuse for all phase configs)
          const essentiaStartTime = Date.now();
          const essentiaResult = extractEssentiaBeats(trimmedPCM, cached.sampleRate);
          const essentiaMs = Date.now() - essentiaStartTime;

          if (!essentiaResult) {
            console.warn('[Harness] Essentia failed for ' + song.name + ' ' + segment.label);
            for (const phaseConfig of config.phaseConfigs) {
              completedRuns++;
              results.push({
                song: song.name, segment: segment.label,
                segmentStart: segment.start, segmentEnd: segment.end, segmentDuration: segmentDuration,
                phaseConfig: phaseConfig, engineParams: engineParam.label,
                error: 'Essentia beat extraction failed',
              });
            }
            continue;
          }

          for (const phaseConfig of config.phaseConfigs) {
            for (let run = 1; run <= config.runsPerCombination; run++) {
              let actualPCM = trimmedPCM;
              let actualStart = segment.start;
              let actualEnd = segment.end;

              // Apply trim jitter for runs > 1
              if (config.trimJitterMs > 0 && run > 1) {
                const jitterSec = (Math.random() - 0.5) * 2 * (config.trimJitterMs / 1000);
                const jStart = Math.max(0, startSample + Math.floor(jitterSec * cached.sampleRate));
                const jEnd = Math.min(cached.pcm.length, endSample + Math.floor(jitterSec * cached.sampleRate));
                actualPCM = cached.pcm.slice(jStart, jEnd);
                actualStart = segment.start + jitterSec;
                actualEnd = segment.end + jitterSec;
                // With jitter, need fresh onset detection + Essentia
                // For simplicity, re-run both (only needed for runsPerCombination > 1 with jitter)
              }

              completedRuns++;
              updateProgress(completedRuns, totalRuns,
                song.name + ' | ' + segment.label + ' | ' + engineParam.label + ' | Phase ' + phaseConfig + ' | Run ' + run);

              try {
                // Use cached Essentia result for run 1 / no jitter
                const useCache = (run === 1 || config.trimJitterMs === 0);
                const analysisResult = runAnalysisPipeline(
                  onsetResult.sessionOnsets,
                  onsetResult.bandOnsets,
                  actualPCM,
                  cached.sampleRate,
                  phaseConfig,
                  useCache ? essentiaResult : null
                );

                if (!analysisResult) {
                  results.push({
                    song: song.name, segment: segment.label,
                    segmentStart: actualStart, segmentEnd: actualEnd, segmentDuration: segmentDuration,
                    phaseConfig: phaseConfig, engineParams: engineParam.label, run: run,
                    error: 'Analysis pipeline returned null',
                  });
                  continue;
                }

                // Build per-band lookup
                const bandsObj = {};
                for (const ba of analysisResult.bandAnalysis) {
                  bandsObj[ba.name] = {
                    position: ba.position != null ? Math.round(ba.position * 10) / 10 : null,
                    consistency: ba.consistency != null ? Math.round(ba.consistency * 10) / 10 : null,
                    onsets: ba.count || 0,
                    matchRate: ba.matchRate != null ? Math.round(ba.matchRate * 100) : null,
                    gridResolution: ba.gridResolution || null,
                  };
                }

                const record = {
                  song: song.name,
                  segment: segment.label,
                  segmentStart: actualStart,
                  segmentEnd: actualEnd,
                  segmentDuration: segmentDuration,
                  phaseConfig: phaseConfig,
                  engineParams: engineParam.label,
                  engineParamsDetail: { ...engineParam },
                  run: run,
                  expectedPocket: song.expectedPocket || null,

                  overallPosition: analysisResult.overallPosition,
                  overallConsistency: analysisResult.overallConsistency,
                  bpm: analysisResult.bpm,
                  swing: analysisResult.swing,

                  downbeatPosition: analysisResult.downbeatPosition,
                  downbeatConsistency: analysisResult.downbeatConsistency,
                  downbeatCount: analysisResult.downbeatCount,
                  ghostNotePosition: analysisResult.ghostNotePosition,
                  ghostNoteConsistency: analysisResult.ghostNoteConsistency,
                  ghostNoteCount: analysisResult.ghostNoteCount,

                  bands: bandsObj,
                  drumCounts: analysisResult.drumCounts,

                  gridPhaseError: analysisResult.gridDiagnostics?.phaseError,
                  clusterStrength: analysisResult.gridDiagnostics?.clusterStrength,
                  drift: analysisResult.gridDiagnostics?.drift,

                  phaseShiftApplied: analysisResult.phaseCorrection?.shiftMs || null,
                  structuralOnsetCount: analysisResult.phaseCorrection?.structuralOnsetCount || null,

                  onsetDetectionMs: onsetMs,
                  essentiaProcessingMs: essentiaMs,
                  analysisMs: analysisResult.totalAnalysisMs,

                  directionCorrect: song.expectedPocket
                    ? (song.expectedPocket === 'behind' && analysisResult.overallPosition > 0) ||
                      (song.expectedPocket === 'ahead' && analysisResult.overallPosition < 0) ||
                      (song.expectedPocket === 'center' && Math.abs(analysisResult.overallPosition) < 5)
                    : null,
                };

                results.push(record);
                console.log('[Harness] Run ' + completedRuns + '/' + totalRuns + ': ' +
                  song.name + ' | ' + segment.label + ' | Phase ' + phaseConfig + ' | ' +
                  engineParam.label + ' \u2192 position: ' +
                  (record.overallPosition >= 0 ? '+' : '') + record.overallPosition.toFixed(1) + 'ms');

              } catch (err) {
                console.error('[Harness] Run failed:', err);
                results.push({
                  song: song.name, segment: segment.label,
                  segmentStart: actualStart, segmentEnd: actualEnd, segmentDuration: segmentDuration,
                  phaseConfig: phaseConfig, engineParams: engineParam.label, run: run,
                  error: err.message,
                });
              }

              // Brief pause for GC
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
        }
      }
    }

    const totalTime = Date.now() - startTime;
    console.log('[Harness] Experiment complete: ' + results.length + ' runs in ' + (totalTime / 1000).toFixed(1) + 's');

    const summary = generateSummary(results);

    const output = {
      experimentId: 'experiment-' + new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-'),
      timestamp: new Date().toISOString(),
      totalRuns: totalRuns,
      completedRuns: results.filter(r => !r.error).length,
      failedRuns: results.filter(r => r.error).length,
      durationMs: totalTime,
      durationFormatted: formatDuration(totalTime),
      config: {
        songs: config.songs.map(s => ({ name: s.name, segments: s.segments })),
        phaseConfigs: config.phaseConfigs,
        engineParams: config.engineParams,
        runsPerCombination: config.runsPerCombination,
        trimJitterMs: config.trimJitterMs,
      },
      results: results,
      errors: errors,
      summary: summary,
    };

    lastOutput = output;
    displayResults(output);
    return output;
  }

  // ============================================================
  // SUMMARY GENERATION
  // ============================================================

  function generateSummary(results) {
    const validResults = results.filter(r => !r.error);
    const summary = {};

    for (const r of validResults) {
      const songKey = r.song;
      const segKey = r.segment;
      const configKey = r.phaseConfig + '-' + r.engineParams;

      if (!summary[songKey]) summary[songKey] = {};
      if (!summary[songKey][segKey]) summary[songKey][segKey] = {};
      if (!summary[songKey][segKey][configKey]) {
        summary[songKey][segKey][configKey] = {
          phaseConfig: r.phaseConfig,
          engineParams: r.engineParams,
          runs: [],
        };
      }

      summary[songKey][segKey][configKey].runs.push(r);
    }

    for (const song of Object.keys(summary)) {
      for (const seg of Object.keys(summary[song])) {
        for (const config of Object.keys(summary[song][seg])) {
          const group = summary[song][seg][config];
          const positions = group.runs.map(r => r.overallPosition);
          const consistencies = group.runs.map(r => r.overallConsistency);
          const hihatPositions = group.runs
            .map(r => r.bands?.hihat?.position)
            .filter(v => v !== null && v !== undefined);
          const hihatConsistencies = group.runs
            .map(r => r.bands?.hihat?.consistency)
            .filter(v => v !== null && v !== undefined);

          group.stats = {
            n: positions.length,
            meanPosition: mean(positions),
            sdPosition: stddev(positions),
            meanConsistency: mean(consistencies),
            meanHihat: hihatPositions.length > 0 ? mean(hihatPositions) : null,
            sdHihat: hihatPositions.length > 1 ? stddev(hihatPositions) : null,
            meanHihatConsistency: hihatConsistencies.length > 0 ? mean(hihatConsistencies) : null,
            bpm: group.runs[0]?.bpm,
            phaseShift: group.runs[0]?.phaseShiftApplied,
            directionCorrect: group.runs.every(r => r.directionCorrect),
          };
        }
      }
    }

    return summary;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
  }
  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  // ============================================================
  // PROGRESS UI
  // ============================================================

  let progressStartTime = null;

  function updateProgress(completed, total, detail) {
    if (completed === 0) progressStartTime = Date.now();

    const panel = document.getElementById('progress-panel');
    const bar = document.getElementById('progress-bar');
    const text = document.getElementById('progress-text');
    const detailEl = document.getElementById('progress-detail');
    const etaEl = document.getElementById('progress-eta');

    if (panel) panel.style.display = '';
    if (bar) bar.style.width = (total > 0 ? Math.round((completed / total) * 100) : 0) + '%';
    if (text) text.textContent = completed + ' / ' + total;
    if (detailEl) detailEl.textContent = detail || '';

    if (etaEl && completed > 0 && completed < total) {
      const elapsed = Date.now() - progressStartTime;
      const perRun = elapsed / completed;
      const remaining = perRun * (total - completed);
      etaEl.textContent = 'ETA: ' + formatDuration(remaining);
    } else if (etaEl && completed >= total) {
      etaEl.textContent = '';
    }
  }

  // ============================================================
  // RESULTS DISPLAY
  // ============================================================

  function displayResults(output) {
    const progressPanel = document.getElementById('progress-panel');
    const resultsPanel = document.getElementById('results-panel');
    if (progressPanel) progressPanel.style.display = 'none';
    if (resultsPanel) resultsPanel.style.display = '';

    const container = document.getElementById('summary-table-container');
    if (!container) return;

    const validResults = output.results.filter(r => !r.error);
    const failedResults = output.results.filter(r => r.error);

    let html = '<h3>Experiment: ' + output.experimentId + '</h3>';
    html += '<p>' + output.completedRuns + ' successful runs, ' +
      output.failedRuns + ' failed, ' + output.durationFormatted + ' total</p>';

    if (failedResults.length > 0) {
      html += '<details><summary style="color:#f87171;cursor:pointer">' +
        failedResults.length + ' failed runs</summary><ul>';
      for (const r of failedResults) {
        html += '<li>' + r.song + ' | ' + r.segment + ' | Phase ' +
          r.phaseConfig + ' | ' + (r.engineParams || '') + ': ' + r.error + '</li>';
      }
      html += '</ul></details>';
    }

    // Summary table
    html += '<table class="results-table"><thead><tr>' +
      '<th>Song</th><th>Segment</th><th>Config</th>' +
      '<th>Position</th><th>\u00b1</th>' +
      '<th>Hi-hat</th><th>Hi-hat \u00b1</th>' +
      '<th>BPM</th><th>Phase Shift</th><th>Dir</th>' +
      '</tr></thead><tbody>';

    for (const r of validResults) {
      const pos = r.overallPosition != null
        ? (r.overallPosition >= 0 ? '+' : '') + r.overallPosition.toFixed(1) + 'ms' : '\u2014';
      const cons = r.overallConsistency != null
        ? '\u00b1' + r.overallConsistency.toFixed(1) + 'ms' : '\u2014';
      const hhPos = r.bands?.hihat?.position != null
        ? (r.bands.hihat.position >= 0 ? '+' : '') + r.bands.hihat.position.toFixed(1) + 'ms' : '\u2014';
      const hhCons = r.bands?.hihat?.consistency != null
        ? '\u00b1' + r.bands.hihat.consistency.toFixed(1) + 'ms' : '\u2014';
      const phase = r.phaseShiftApplied != null
        ? (r.phaseShiftApplied >= 0 ? '+' : '') + r.phaseShiftApplied.toFixed(1) + 'ms' : '\u2014';
      const dirIcon = r.directionCorrect === true ? '\u2705' :
        r.directionCorrect === false ? '\u274c' : '\u2014';

      const rowClass = r.directionCorrect === true ? 'row-correct' :
        r.directionCorrect === false ? 'row-wrong' : '';

      html += '<tr class="' + rowClass + '">' +
        '<td>' + r.song + '</td>' +
        '<td>' + r.segment + '</td>' +
        '<td>' + r.phaseConfig + '-' + r.engineParams + '</td>' +
        '<td>' + pos + '</td><td>' + cons + '</td>' +
        '<td>' + hhPos + '</td><td>' + hhCons + '</td>' +
        '<td>' + Math.round(r.bpm || 0) + '</td>' +
        '<td>' + phase + '</td>' +
        '<td>' + dirIcon + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';

    // Per-band detail (collapsible)
    html += '<details style="margin-top:16px"><summary style="cursor:pointer">Per-band details</summary>';
    html += '<table class="results-table"><thead><tr>' +
      '<th>Song</th><th>Segment</th><th>Config</th>' +
      '<th>Kick</th><th>Bass</th><th>Mid</th><th>Snare</th><th>Hi-hat</th>' +
      '<th>Drums (K/S/H)</th>' +
      '</tr></thead><tbody>';

    for (const r of validResults) {
      const fmt = (b) => {
        if (!b || b.position == null) return '\u2014';
        return (b.position >= 0 ? '+' : '') + b.position.toFixed(1) + '\u00b1' + (b.consistency || 0).toFixed(1);
      };
      const drums = r.drumCounts
        ? r.drumCounts.kick + '/' + r.drumCounts.snare + '/' + r.drumCounts.hihat
        : '\u2014';

      html += '<tr>' +
        '<td>' + r.song + '</td><td>' + r.segment + '</td>' +
        '<td>' + r.phaseConfig + '-' + r.engineParams + '</td>' +
        '<td>' + fmt(r.bands?.kick) + '</td>' +
        '<td>' + fmt(r.bands?.bass) + '</td>' +
        '<td>' + fmt(r.bands?.mid) + '</td>' +
        '<td>' + fmt(r.bands?.snare) + '</td>' +
        '<td>' + fmt(r.bands?.hihat) + '</td>' +
        '<td>' + drums + '</td>' +
        '</tr>';
    }
    html += '</tbody></table></details>';

    container.innerHTML = html;
  }

  // ============================================================
  // EXPORT
  // ============================================================

  function exportResults(output) {
    output = output || lastOutput;
    if (!output) { alert('No results to export.'); return; }

    const filename = output.experimentId;
    const json = JSON.stringify(output, null, 2);
    downloadFile(filename + '.json', json, 'application/json');

    const csv = generateCSV(output.results.filter(r => !r.error));
    downloadFile(filename + '.csv', csv, 'text/csv');
  }

  function generateCSV(results) {
    const headers = [
      'song', 'segment', 'segment_start', 'segment_end',
      'phase_config', 'engine_params', 'run',
      'overall_position', 'overall_consistency', 'bpm', 'swing',
      'downbeat_position', 'downbeat_consistency', 'downbeat_count',
      'ghost_position', 'ghost_consistency', 'ghost_count',
      'kick_position', 'kick_consistency', 'kick_onsets',
      'bass_position', 'bass_consistency', 'bass_onsets',
      'mid_position', 'mid_consistency', 'mid_onsets',
      'snare_position', 'snare_consistency', 'snare_onsets',
      'hihat_position', 'hihat_consistency', 'hihat_onsets',
      'drum_kick', 'drum_snare', 'drum_hihat',
      'phase_shift', 'structural_onset_count',
      'grid_phase_error', 'cluster_strength', 'drift',
      'direction_correct',
      'onset_detection_ms', 'essentia_ms', 'analysis_ms',
    ];

    const rows = results.map(r => [
      r.song, r.segment, r.segmentStart, r.segmentEnd,
      r.phaseConfig, r.engineParams, r.run,
      r.overallPosition, r.overallConsistency, r.bpm, r.swing,
      r.downbeatPosition, r.downbeatConsistency, r.downbeatCount,
      r.ghostNotePosition, r.ghostNoteConsistency, r.ghostNoteCount,
      r.bands?.kick?.position, r.bands?.kick?.consistency, r.bands?.kick?.onsets,
      r.bands?.bass?.position, r.bands?.bass?.consistency, r.bands?.bass?.onsets,
      r.bands?.mid?.position, r.bands?.mid?.consistency, r.bands?.mid?.onsets,
      r.bands?.snare?.position, r.bands?.snare?.consistency, r.bands?.snare?.onsets,
      r.bands?.hihat?.position, r.bands?.hihat?.consistency, r.bands?.hihat?.onsets,
      r.drumCounts?.kick, r.drumCounts?.snare, r.drumCounts?.hihat,
      r.phaseShiftApplied, r.structuralOnsetCount,
      r.gridPhaseError, r.clusterStrength, r.drift,
      r.directionCorrect,
      r.onsetDetectionMs, r.essentiaProcessingMs, r.analysisMs,
    ]);

    return [headers.join(','), ...rows.map(r => r.map(v => v ?? '').join(','))].join('\n');
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // CONFIG EDITOR
  // ============================================================

  function getConfigFromUI() {
    const configText = document.getElementById('config-editor');
    if (!configText) return DEFAULT_EXPERIMENT;
    try {
      // Parse as relaxed JSON (eval-safe since it's user's own input in their browser)
      return (new Function('return (' + configText.value + ')'))();
    } catch (e) {
      alert('Invalid config JSON: ' + e.message);
      return null;
    }
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    DEFAULT_EXPERIMENT,
    initEssentia,
    runExperimentSuite,
    exportResults,
    getConfigFromUI,
    get essentiaReady() { return essentiaReady; },
    get lastOutput() { return lastOutput; },
  };
})();
