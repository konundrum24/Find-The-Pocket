/**
 * Experiment Logging Module — Automated result capture, export, and summary
 * for the phase correction A/B/C experiment.
 *
 * Results are stored in localStorage with keys: experiment_{config}_{device}_run{NN}
 * Export produces JSON + CSV files for analysis.
 */
const ExperimentLog = (function () {
  'use strict';

  const PREFIX = 'experiment_';

  /**
   * Get the next available run number for a config+device combination.
   */
  function getNextRunNumber(config, device) {
    let n = 1;
    while (localStorage.getItem(PREFIX + config + '_' + device + '_run' + String(n).padStart(2, '0'))) {
      n++;
    }
    return n;
  }

  /**
   * Save an experiment result to localStorage.
   * @param {Object} data - all result data from the analysis pipeline
   * @param {Object} experimentConfig - {config, device, runNumber, fileInput}
   * @returns {string} the localStorage key used
   */
  function saveResult(data, experimentConfig) {
    const config = experimentConfig.config;
    const device = experimentConfig.device;
    const runNum = experimentConfig.runNumber || getNextRunNumber(config, device);
    const key = PREFIX + config + '_' + device + '_run' + String(runNum).padStart(2, '0');

    const record = {
      config: config,
      device: device,
      runNumber: runNum,
      timestamp: new Date().toISOString(),
      url: window.location.href,

      // Phase correction info
      phaseConfig: config,
      phaseCorrectionApplied: config !== 'A',
      phaseOffsetMs: data.phaseOffsetMs || null,
      structuralOnsetCount: data.structuralOnsetCount || null,
      totalOnsetCount: data.totalOnsetCount || null,

      // Headline metrics
      overallPosition: data.overallPosition,
      overallConsistency: data.overallConsistency,
      bpm: data.bpm,
      swing: data.swing,

      // Downbeat/ghost breakdown
      downbeatPosition: data.downbeatPosition,
      downbeatConsistency: data.downbeatConsistency,
      downbeatCount: data.downbeatCount,
      ghostNotePosition: data.ghostNotePosition,
      ghostNoteConsistency: data.ghostNoteConsistency,
      ghostNoteCount: data.ghostNoteCount,

      // Per-band metrics
      bands: {
        kick:  { position: null, consistency: null, onsets: null, matchRate: null },
        bass:  { position: null, consistency: null, onsets: null, matchRate: null },
        mid:   { position: null, consistency: null, onsets: null, matchRate: null },
        snare: { position: null, consistency: null, onsets: null, matchRate: null },
        hihat: { position: null, consistency: null, onsets: null, matchRate: null },
      },

      // Drum counts
      drumCounts: data.drumCounts ? {
        kick: data.drumCounts.kick,
        snare: data.drumCounts.snare,
        hihat: data.drumCounts.hihat,
      } : null,

      // Grid diagnostics
      gridPhaseError: data.gridPhaseError,
      clusterStrength: data.clusterStrength,
      drift: data.drift,

      // Timing
      essentiaProcessingMs: data.essentiaProcessingMs,
      totalAnalysisMs: data.totalAnalysisMs,

      // Config C specific
      selectivePhase: config === 'C' ? {
        periodicityTolerance: 0.15,
        amplitudePercentile: 0.60,
        minStructuralOnsets: 8,
        structuralOnsetsFound: data.structuralOnsetCount,
        fellBackToRaw: data.structuralOnsetCount === null,
      } : null,

      // File input info
      fileInput: data.fileInput || null,
    };

    // Fill per-band data
    if (data.bandAnalysis) {
      for (const band of data.bandAnalysis) {
        if (record.bands[band.name]) {
          record.bands[band.name] = {
            position: band.position != null ? Math.round(band.position * 10) / 10 : null,
            consistency: band.consistency != null ? Math.round(band.consistency * 10) / 10 : null,
            onsets: band.count || null,
            matchRate: band.matchRate != null ? Math.round(band.matchRate * 100) : null,
          };
        }
      }
    }

    localStorage.setItem(key, JSON.stringify(record));
    console.log('[Experiment] Saved: ' + key);
    return key;
  }

  /**
   * Get all experiment results from localStorage.
   * @returns {Array} sorted by config, device, run number
   */
  function getAllResults() {
    const results = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) {
        try {
          results.push(JSON.parse(localStorage.getItem(key)));
        } catch (e) { /* skip corrupt entries */ }
      }
    }
    results.sort((a, b) => {
      if (a.config !== b.config) return a.config.localeCompare(b.config);
      if (a.device !== b.device) return a.device.localeCompare(b.device);
      return a.runNumber - b.runNumber;
    });
    return results;
  }

  /**
   * Export all experiment data as JSON + CSV downloads.
   */
  function exportData() {
    const results = getAllResults();
    if (results.length === 0) {
      alert('No experiment data to export.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const json = JSON.stringify(results, null, 2);
    const csv = generateCSV(results);

    downloadFile('experiment-results-' + dateStr + '.json', json, 'application/json');
    downloadFile('experiment-results-' + dateStr + '.csv', csv, 'text/csv');
  }

  function generateCSV(results) {
    const headers = [
      'config', 'device', 'run', 'timestamp',
      'overall_position', 'overall_consistency', 'bpm', 'swing',
      'downbeat_position', 'downbeat_consistency', 'downbeat_count',
      'ghost_position', 'ghost_consistency', 'ghost_count',
      'kick_position', 'kick_consistency', 'kick_onsets',
      'bass_position', 'bass_consistency', 'bass_onsets',
      'mid_position', 'mid_consistency', 'mid_onsets',
      'snare_position', 'snare_consistency', 'snare_onsets',
      'hihat_position', 'hihat_consistency', 'hihat_onsets',
      'drum_kick', 'drum_snare', 'drum_hihat',
      'phase_offset_applied', 'structural_onset_count',
      'grid_phase_error', 'cluster_strength', 'drift',
      'essentia_processing_ms',
    ];

    const rows = results.map(r => [
      r.config, r.device, r.runNumber, r.timestamp,
      r.overallPosition, r.overallConsistency, r.bpm, r.swing,
      r.downbeatPosition, r.downbeatConsistency, r.downbeatCount,
      r.ghostNotePosition, r.ghostNoteConsistency, r.ghostNoteCount,
      r.bands?.kick?.position, r.bands?.kick?.consistency, r.bands?.kick?.onsets,
      r.bands?.bass?.position, r.bands?.bass?.consistency, r.bands?.bass?.onsets,
      r.bands?.mid?.position, r.bands?.mid?.consistency, r.bands?.mid?.onsets,
      r.bands?.snare?.position, r.bands?.snare?.consistency, r.bands?.snare?.onsets,
      r.bands?.hihat?.position, r.bands?.hihat?.consistency, r.bands?.hihat?.onsets,
      r.drumCounts?.kick, r.drumCounts?.snare, r.drumCounts?.hihat,
      r.phaseOffsetMs, r.structuralOnsetCount,
      r.gridPhaseError, r.clusterStrength, r.drift,
      r.essentiaProcessingMs,
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

  /**
   * Clear all experiment data from localStorage (with confirmation).
   */
  function clearData() {
    if (!confirm('Clear all experiment data? This cannot be undone.')) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach(k => localStorage.removeItem(k));
    console.log('[Experiment] Cleared ' + keys.length + ' records');
  }

  /**
   * Compute per-group (config+device) statistics.
   * @returns {Array<{config, device, n, meanPos, sdPos, meanCons, sdCons, runs: Array}>}
   */
  function computeStats() {
    const results = getAllResults();
    const groups = {};
    for (const r of results) {
      const key = r.config + '_' + r.device;
      if (!groups[key]) groups[key] = { config: r.config, device: r.device, runs: [] };
      groups[key].runs.push(r);
    }

    return Object.values(groups).map(g => {
      const positions = g.runs.map(r => r.overallPosition).filter(v => v != null);
      const consistencies = g.runs.map(r => r.overallConsistency).filter(v => v != null);
      const meanPos = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : null;
      const sdPos = positions.length > 1
        ? Math.sqrt(positions.reduce((a, b) => a + (b - meanPos) ** 2, 0) / positions.length)
        : 0;
      const meanCons = consistencies.length ? consistencies.reduce((a, b) => a + b, 0) / consistencies.length : null;
      return {
        config: g.config,
        device: g.device,
        n: g.runs.length,
        meanPos: meanPos,
        sdPos: sdPos,
        meanCons: meanCons,
        runs: g.runs
      };
    });
  }

  /**
   * Render the experiment summary view into a container element.
   * @param {HTMLElement} container
   */
  function renderSummary(container) {
    const results = getAllResults();
    if (results.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary)">No experiment data yet. Run some analyses with ?phase=A/B/C parameters.</p>';
      return;
    }

    // Results table
    let html = '<div class="experiment-summary">';
    html += '<h3>Experiment Results (' + results.length + ' runs)</h3>';
    html += '<div class="experiment-table-wrap"><table class="experiment-table">';
    html += '<thead><tr>' +
      '<th>Config</th><th>Device</th><th>Run</th>' +
      '<th>Position</th><th>&plusmn;</th><th>BPM</th>' +
      '<th>Hi-hat Pos</th><th>Hi-hat &plusmn;</th>' +
      '<th>Phase Offset</th><th>Structural</th>' +
      '</tr></thead><tbody>';

    for (const r of results) {
      const pos = r.overallPosition != null ? (r.overallPosition >= 0 ? '+' : '') + Math.round(r.overallPosition) + 'ms' : '\u2014';
      const cons = r.overallConsistency != null ? '\u00b1' + Math.round(r.overallConsistency) + 'ms' : '\u2014';
      const hhPos = r.bands?.hihat?.position != null ? (r.bands.hihat.position >= 0 ? '+' : '') + Math.round(r.bands.hihat.position) + 'ms' : '\u2014';
      const hhCons = r.bands?.hihat?.consistency != null ? '\u00b1' + Math.round(r.bands.hihat.consistency) + 'ms' : '\u2014';
      const phase = r.phaseOffsetMs != null ? (r.phaseOffsetMs >= 0 ? '+' : '') + r.phaseOffsetMs.toFixed(1) + 'ms' : '\u2014';
      const structural = r.structuralOnsetCount != null ? r.structuralOnsetCount : '\u2014';

      html += '<tr class="config-' + r.config.toLowerCase() + '">' +
        '<td>' + r.config + '</td><td>' + r.device + '</td><td>' + r.runNumber + '</td>' +
        '<td>' + pos + '</td><td>' + cons + '</td><td>' + Math.round(r.bpm || 0) + '</td>' +
        '<td>' + hhPos + '</td><td>' + hhCons + '</td>' +
        '<td>' + phase + '</td><td>' + structural + '</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';

    // Per-group statistics
    const stats = computeStats();
    if (stats.length > 0) {
      html += '<h3>Per-Config Statistics</h3>';
      html += '<div class="experiment-stats">';
      for (const s of stats) {
        const meanStr = s.meanPos != null ? (s.meanPos >= 0 ? '+' : '') + s.meanPos.toFixed(1) + 'ms' : '\u2014';
        const sdStr = s.sdPos != null ? s.sdPos.toFixed(1) + 'ms' : '\u2014';
        const consStr = s.meanCons != null ? '\u00b1' + s.meanCons.toFixed(1) + 'ms' : '\u2014';
        html += '<div class="stat-card config-' + s.config.toLowerCase() + '">' +
          '<strong>Config ' + s.config + ' (' + s.device + ')</strong><br>' +
          'Mean position: ' + meanStr + '<br>' +
          'SD (run-to-run): ' + sdStr + '<br>' +
          'Mean consistency: ' + consStr + '<br>' +
          'N = ' + s.n +
          '</div>';
      }
      html += '</div>';
    }

    // Action buttons
    html += '<div class="experiment-actions">' +
      '<button class="btn secondary" onclick="ExperimentLog.exportData()">Export Data (JSON + CSV)</button>' +
      '<button class="btn secondary" style="margin-left:8px" onclick="ExperimentLog.clearData(); ExperimentLog.renderSummary(document.getElementById(\'experiment-summary-container\'))">Clear Data</button>' +
      '</div>';

    html += '</div>';
    container.innerHTML = html;
  }

  /**
   * Run a batch experiment: all 3 configs x N runs on a loaded file.
   * @param {Float32Array} pcm - decoded mono PCM at 44100 Hz
   * @param {number} sampleRate
   * @param {Object} opts - {runsPerConfig, trimStart, trimEnd, jitterMs, filename, sensitivity, onProgress, analyzeFunc}
   * @returns {Promise<void>}
   */
  async function runBatch(pcm, sampleRate, opts) {
    const configs = ['A', 'B', 'C'];
    const runsPerConfig = opts.runsPerConfig || 10;
    const totalRuns = configs.length * runsPerConfig;
    let completed = 0;

    for (const config of configs) {
      for (let run = 1; run <= runsPerConfig; run++) {
        // Apply trim jitter if requested
        let trimStart = opts.trimStart || 0;
        let trimEnd = opts.trimEnd || (pcm.length / sampleRate);
        if (opts.jitterMs) {
          const jitter = (Math.random() - 0.5) * 2 * (opts.jitterMs / 1000);
          trimStart = Math.max(0, trimStart + jitter);
          trimEnd = trimEnd + jitter;
        }

        const trimmedPCM = FileInput.trimPCM(pcm, sampleRate, trimStart, trimEnd);

        console.log('[Batch] Config ' + config + ', Run ' + run + '/' + runsPerConfig +
          ' (trim ' + trimStart.toFixed(3) + '-' + trimEnd.toFixed(3) + 's)');

        // Run analysis through the main pipeline
        const result = await opts.analyzeFunc(trimmedPCM, sampleRate, config);

        if (result) {
          saveResult(result, {
            config: config,
            device: 'file',
            runNumber: run,
          });
          // Add file input metadata
          const key = PREFIX + config + '_file_run' + String(run).padStart(2, '0');
          const stored = JSON.parse(localStorage.getItem(key));
          if (stored) {
            stored.fileInput = {
              filename: opts.filename || 'unknown',
              trimStart: trimStart,
              trimEnd: trimEnd,
              analyzedDuration: trimEnd - trimStart,
              jitterMs: opts.jitterMs || 0,
            };
            localStorage.setItem(key, JSON.stringify(stored));
          }
        }

        completed++;
        if (opts.onProgress) opts.onProgress(completed, totalRuns, config, run);

        // Brief pause for GC
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  return {
    getNextRunNumber,
    saveResult,
    getAllResults,
    exportData,
    clearData,
    computeStats,
    renderSummary,
    runBatch
  };
})();
