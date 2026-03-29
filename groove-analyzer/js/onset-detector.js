// ============================================
// onset-detector.js — ScriptProcessorNode onset detection
//
// Uses spectral flux for onset detection: compares FFT
// magnitude spectra frame-by-frame, triggers on positive
// flux spikes. Timestamps via e.playbackTime for
// sample-accurate timing.
// ============================================

const OnsetDetector = (() => {
  let processor = null;
  let analyser = null;
  let gainNode = null;
  let prevFlux = 0;
  let prevPrevFlux = 0;
  let prevFrameTimeMs = 0;
  let peakEnv = 0.001;
  let lastOnsetSample = 0;
  let totalSamples = 0;
  let currentFlux = 0;  // exposed for level display

  // Auto-gain: boost quiet signals so spectral flux rises above analyser noise floor
  let autoGainFrames = 0;
  let autoGainPeak = 0;
  const AUTO_GAIN_WINDOW = 40;  // ~0.5s at 512-sample buffers / 44.1kHz
  const TARGET_PEAK = 0.25;     // target peak amplitude (linear, ~-12 dBFS)
  const MAX_GAIN = 32;          // max boost (30 dB) — avoids runaway on silence
  const MIN_GAIN = 1;           // never attenuate

  // Spectrum buffers (allocated once in start())
  let currentSpectrum = null;
  let prevSpectrum = null;

  // Pending onsets detected in audio thread, consumed by main thread
  let pendingOnsets = [];

  // Continuous flux envelope — every frame's flux value + timestamp
  // Used by FluxTempo for autocorrelation-based tempo detection
  let fluxEnvelope = [];
  let fluxFrameRate = 0; // frames per second, computed from sample rate + buffer size

  // Raw PCM capture for post-recording Essentia.js analysis
  let pcmChunks = [];
  let capturedSampleRate = 44100;
  let pcmStartTime = 0; // playbackTime (ms) of the first captured PCM chunk

  // ── Frequency band definitions (v2 — attack transient focused) ──
  // Tuned for drum onset detection. Bin boundaries for 44.1kHz, FFT_SIZE=1024 (~43Hz/bin).
  // v2 bands separate kick body, bass resonance, mid, snare crack, and hi-hat shimmer.
  const BANDS = [
    { name: 'kick',   label: 'Kick (40–150 Hz)',        binStart: 1,   binEnd: 4   },  // ~43–172 Hz
    { name: 'bass',   label: 'Bass (150–400 Hz)',       binStart: 4,   binEnd: 9   },  // ~172–387 Hz
    { name: 'mid',    label: 'Mid (400 Hz–2 kHz)',      binStart: 9,   binEnd: 47  },  // ~387–2025 Hz
    { name: 'snare',  label: 'Snare Crack (2–5 kHz)',   binStart: 47,  binEnd: 116 },  // ~2025–4996 Hz
    { name: 'hihat',  label: 'Hi-hat (6–16 kHz)',       binStart: 140, binEnd: 372 }   // ~6029–16kHz
  ];

  // Minimum flux floor: eliminates room noise false positives.
  // Per-band flux below this value is treated as zero.
  const MIN_FLUX_FLOOR = 1e-4;

  // Per-band state (initialized in start())
  let bandState = {};

  const SPIKE_RATIO = 2.0;
  const BUFFER_SIZE = 512;
  const FFT_SIZE = 1024;
  const BIN_START = 2;    // ~80Hz at 44.1kHz
  const BIN_END = 200;    // ~8kHz at 44.1kHz

  // These are set externally
  let sensitivity = 8;
  let cooldownSampleCount = 0;
  let active = false;

  function initBandState() {
    bandState = {};
    for (const band of BANDS) {
      bandState[band.name] = {
        prevFlux: 0,
        prevPrevFlux: 0,
        prevFrameTimeMs: 0,
        peakEnv: 0.001,
        lastOnsetSample: 0,
        allOnsets: [],      // all onsets accumulated during session (for end-of-session analysis)
        fluxEnvelope: []
      };
    }
  }

  /** Create and connect the ScriptProcessorNode + AnalyserNode. */
  function start(micSource, audioCtx) {
    if (processor) return;

    capturedSampleRate = audioCtx.sampleRate;

    // AnalyserNode for FFT — no smoothing, raw frame data
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;

    const numBins = analyser.frequencyBinCount; // FFT_SIZE / 2 = 512
    currentSpectrum = new Float32Array(numBins);
    prevSpectrum = new Float32Array(numBins);

    initBandState();

    // GainNode for input amplification — zero latency, just a per-sample multiply.
    // Auto-gain measures the first ~0.5s and boosts quiet signals (phone speakers,
    // distant mics) so spectral flux rises above the AnalyserNode's noise floor.
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1; // start at unity, auto-gain adjusts after measuring

    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

    processor.onaudioprocess = function (e) {
      const input = e.inputBuffer.getChannelData(0);
      const sr = audioCtx.sampleRate;
      const frameTimeMs = (e.playbackTime + (input.length / 2) / sr) * 1000;
      const frameDurationMs = (input.length / sr) * 1000;

      // Auto-gain: measure peak level over first ~0.5s, then set gain
      if (active && autoGainFrames < AUTO_GAIN_WINDOW) {
        for (let i = 0; i < input.length; i++) {
          const abs = Math.abs(input[i]);
          if (abs > autoGainPeak) autoGainPeak = abs;
        }
        autoGainFrames++;
        if (autoGainFrames === AUTO_GAIN_WINDOW && autoGainPeak > 0.0001) {
          const desiredGain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_PEAK / autoGainPeak));
          gainNode.gain.setValueAtTime(desiredGain, audioCtx.currentTime);
          console.log('[Groove] Auto-gain: peak=' + autoGainPeak.toFixed(5) +
            ', boost=' + desiredGain.toFixed(1) + 'x (' + (20 * Math.log10(desiredGain)).toFixed(1) + ' dB)');
        }
      }

      // Capture raw PCM for Essentia post-recording analysis
      if (active) {
        if (pcmChunks.length === 0) {
          // Align PCM start with onset timestamps: both use buffer midpoint
          // (e.playbackTime + halfBuffer) so Essentia ticks and onsets share
          // the same time base
          pcmStartTime = (e.playbackTime + (input.length / 2) / sr) * 1000;
        }
        pcmChunks.push(new Float32Array(input));
      }

      // Pull current spectrum from analyser (dB values)
      analyser.getFloatFrequencyData(currentSpectrum);

      // Compute spectral flux: sum of positive differences across bins
      // Also compute per-band flux BEFORE the spectrum swap
      let flux = 0;
      const end = Math.min(BIN_END, currentSpectrum.length);
      for (let i = BIN_START; i < end; i++) {
        // Convert from dB to linear magnitude for meaningful differences
        const curr = Math.pow(10, currentSpectrum[i] / 20);
        const prev = Math.pow(10, prevSpectrum[i] / 20);
        const diff = curr - prev;
        if (diff > 0) flux += diff;
      }
      flux /= (end - BIN_START);

      // Per-band flux (computed before spectrum swap so buffers are correct)
      const bandFluxValues = {};
      if (active) {
        for (const band of BANDS) {
          let bandFlux = 0;
          const bEnd = Math.min(band.binEnd, currentSpectrum.length);
          for (let i = band.binStart; i < bEnd; i++) {
            const curr = Math.pow(10, currentSpectrum[i] / 20);
            const prev = Math.pow(10, prevSpectrum[i] / 20);
            const diff = curr - prev;
            if (diff > 0) bandFlux += diff;
          }
          bandFlux = bandFlux / Math.max(1, bEnd - band.binStart);
          // Apply minimum flux floor to eliminate room noise false positives
          bandFluxValues[band.name] = bandFlux < MIN_FLUX_FLOOR ? 0 : bandFlux;
        }
      }

      // Swap spectrum buffers
      const tmp = prevSpectrum;
      prevSpectrum = currentSpectrum;
      currentSpectrum = tmp;

      totalSamples += input.length;

      // Track peak for normalization
      if (flux > peakEnv) peakEnv = flux;
      peakEnv *= 0.9999; // Slow decay to adapt
      if (peakEnv < 0.001) peakEnv = 0.001;

      // Store for level display
      currentFlux = flux;

      // Record continuous flux envelope for autocorrelation-based tempo
      if (active) {
        fluxEnvelope.push({ time: frameTimeMs, flux: flux });
        if (fluxFrameRate === 0) fluxFrameRate = sr / input.length;

        // ── Per-band onset detection (peak + parabolic interpolation) ──
        for (const band of BANDS) {
          const bs = bandState[band.name];
          const bandFlux = bandFluxValues[band.name];

          // Track per-band peak envelope
          if (bandFlux > bs.peakEnv) bs.peakEnv = bandFlux;
          bs.peakEnv *= 0.9999;
          if (bs.peakEnv < 0.001) bs.peakEnv = 0.001;

          // Record per-band flux envelope
          bs.fluxEnvelope.push({ time: frameTimeMs, flux: bandFlux });

          // Peak detection: previous frame was a local max?
          const bandThresh = (sensitivity / 100) * bs.peakEnv;
          const isBandPrevPeak = bs.prevFlux > bandThresh
            && bs.prevFlux > bs.prevPrevFlux * SPIKE_RATIO
            && bs.prevFlux >= bandFlux;
          const bandCooldownOk = (totalSamples - bs.lastOnsetSample) > cooldownSampleCount;

          if (isBandPrevPeak && bandCooldownOk && bs.prevFrameTimeMs > 0) {
            // Parabolic interpolation for sub-frame timing
            const denom = bs.prevPrevFlux - 2 * bs.prevFlux + bandFlux;
            let delta = 0;
            if (Math.abs(denom) > 1e-10) {
              delta = 0.5 * (bs.prevPrevFlux - bandFlux) / denom;
              delta = Math.max(-0.5, Math.min(0.5, delta));
            }
            const refinedTime = bs.prevFrameTimeMs + delta * frameDurationMs;
            bs.lastOnsetSample = totalSamples - input.length;
            bs.allOnsets.push({ time: refinedTime, amplitude: bs.prevFlux });
          }

          bs.prevPrevFlux = bs.prevFlux;
          bs.prevFrameTimeMs = frameTimeMs;
          bs.prevFlux = bandFlux;
        }
      }

      if (!active) {
        prevPrevFlux = prevFlux;
        prevFrameTimeMs = frameTimeMs;
        prevFlux = flux;
        return;
      }

      // Peak detection with sub-frame parabolic interpolation
      const thresh = (sensitivity / 100) * peakEnv;
      const isPrevPeak = prevFlux > thresh
        && prevFlux > prevPrevFlux * SPIKE_RATIO
        && prevFlux >= flux;
      const cooldownOk = (totalSamples - lastOnsetSample) > cooldownSampleCount;

      if (isPrevPeak && cooldownOk && prevFrameTimeMs > 0) {
        // Parabolic interpolation: refine peak position between frames
        const denom = prevPrevFlux - 2 * prevFlux + flux;
        let delta = 0;
        if (Math.abs(denom) > 1e-10) {
          delta = 0.5 * (prevPrevFlux - flux) / denom;
          delta = Math.max(-0.5, Math.min(0.5, delta));
        }
        const refinedTime = prevFrameTimeMs + delta * frameDurationMs;
        lastOnsetSample = totalSamples - input.length;
        pendingOnsets.push({ time: refinedTime, amplitude: prevFlux });
      }

      prevPrevFlux = prevFlux;
      prevFrameTimeMs = frameTimeMs;
      prevFlux = flux;
    };

    // Signal chain: mic → gain → analyser → processor → destination
    micSource.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(processor);
    processor.connect(audioCtx.destination); // Required for ScriptProcessor to fire
  }

  /** Set sensitivity (0–100). */
  function setSensitivity(val) {
    sensitivity = val;
  }

  /** Set cooldown in samples based on interval. */
  function setCooldown(samples) {
    cooldownSampleCount = samples;
  }

  /**
   * Enable/disable onset detection.
   * @param {boolean} val - true to enable, false to disable
   * @param {Object} [opts] - options
   * @param {boolean} [opts.keepGain] - if true, preserve gain AND signal calibration
   *   (prevSpectrum, peakEnv, prevFlux) from sound check. Only clears accumulated
   *   data (onsets, PCM, envelopes). This avoids the -Infinity spectrum spike that
   *   occurs with a full reset(), which inflates peakEnv and suppresses detection.
   */
  function setActive(val, opts) {
    active = val;
    if (val) {
      if (opts && opts.keepGain) {
        // Soft reset: clear accumulated data but preserve signal calibration.
        // Keep: gainNode.gain, prevSpectrum, peakEnv, prevFlux, prevPrevFlux
        // Clear: onsets, PCM, envelopes, band onset arrays
        pendingOnsets = [];
        pcmChunks = [];
        pcmStartTime = 0;
        fluxEnvelope = [];
        fluxFrameRate = 0;
        autoGainFrames = AUTO_GAIN_WINDOW; // skip re-measurement
        // Clear accumulated band onsets but keep per-band calibration
        // (prevFlux, peakEnv, prevPrevFlux)
        for (const band of BANDS) {
          const bs = bandState[band.name];
          bs.allOnsets = [];
          bs.fluxEnvelope = [];
        }
      } else {
        pendingOnsets = [];
        pcmChunks = [];
        pcmStartTime = 0;
        autoGainFrames = 0;
        autoGainPeak = 0;
        if (gainNode) gainNode.gain.value = 1;
      }
    }
  }

  /** Reset all detection state (call before new session). */
  function reset() {
    prevFlux = 0;
    prevPrevFlux = 0;
    prevFrameTimeMs = 0;
    peakEnv = 0.001;
    lastOnsetSample = 0;
    totalSamples = 0;
    currentFlux = 0;
    pendingOnsets = [];
    fluxEnvelope = [];
    fluxFrameRate = 0;
    pcmChunks = [];
    pcmStartTime = 0;
    autoGainFrames = 0;
    autoGainPeak = 0;
    if (gainNode) gainNode.gain.value = 1;
    initBandState();
    if (prevSpectrum) prevSpectrum.fill(-Infinity);
  }

  /** Drain and return all pending onsets. */
  function drainOnsets() {
    const onsets = pendingOnsets;
    pendingOnsets = [];
    return onsets;
  }

  /** Get current flux level (for display). */
  function getLevel() {
    return { rms: currentFlux, peak: peakEnv };
  }

  /** Get the recorded flux envelope (for autocorrelation-based tempo). */
  function getFluxEnvelope() {
    return { frames: fluxEnvelope, frameRate: fluxFrameRate };
  }

  /** Get band definitions (for UI labels). */
  function getBands() {
    return BANDS.map(b => ({ name: b.name, label: b.label }));
  }

  /**
   * Get captured raw PCM signal for Essentia.js post-recording analysis.
   * Returns { signal, sampleRate, pcmStartTime }.
   * pcmStartTime is the playbackTime (ms) of the first captured buffer,
   * needed to align Essentia's beat positions with session-relative onset times.
   */
  function getPcmSignal() {
    const totalLength = pcmChunks.reduce((s, a) => s + a.length, 0);
    const signal = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of pcmChunks) {
      signal.set(chunk, offset);
      offset += chunk.length;
    }
    return { signal, sampleRate: capturedSampleRate, pcmStartTime };
  }

  /**
   * Get all accumulated band onsets (for end-of-session analysis).
   * Returns { kick: [...], bass: [...], mid: [...], snare: [...], hihat: [...] }
   * Each onset has { time, amplitude }.
   */
  function getBandOnsets() {
    const result = {};
    for (const band of BANDS) {
      result[band.name] = bandState[band.name].allOnsets;
    }
    return result;
  }

  return {
    start,
    setSensitivity,
    setCooldown,
    setActive,
    reset,
    drainOnsets,
    getLevel,
    getFluxEnvelope,
    getBands,
    getBandOnsets,
    getPcmSignal
  };
})();
