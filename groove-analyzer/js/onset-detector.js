// ============================================
// onset-detector.js — ScriptProcessorNode onset detection
//
// Uses spectral flux for onset detection: compares FFT
// magnitude spectra frame-by-frame, triggers on positive
// flux spikes. Timestamps via e.playbackTime for
// sample-accurate timing.
// ============================================

const OnsetDetector = (() => {
  // ── HF path (mid, snare, hi-hat) — FFT 1024 / Buf 512 ──
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

  // ── LF path (kick, bass) — FFT 4096 / Buf 1024 ──
  let processorLF = null;
  let analyserLF = null;
  let currentSpectrumLF = null;
  let prevSpectrumLF = null;
  let totalSamplesLF = 0;
  let warmupRemainingLF = 0;
  let warmingLF = false;

  const BUFFER_SIZE_LF = 1024;
  const FFT_SIZE_LF = 4096;

  // Auto-gain: boost quiet signals so spectral flux rises above analyser noise floor
  let autoGainFrames = 0;
  let autoGainPeak = 0;
  const AUTO_GAIN_WINDOW = 40;  // ~0.5s at 512-sample buffers / 44.1kHz
  const WARMUP_FRAMES = AUTO_GAIN_WINDOW + 5; // suppress onsets until gain + prevSpectrum stabilize
  // LF warmup: same wall-clock time, fewer frames (1024-sample buffers = 2x slower frame rate)
  const WARMUP_FRAMES_LF = Math.ceil((AUTO_GAIN_WINDOW + 5) / 2);
  let warmupRemaining = 0;
  let warming = false;
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

  // ── Frequency band definitions (v2 — multi-resolution) ──
  // HF bands: FFT 1024 at 44.1kHz (~43 Hz/bin) — mid, snare crack, hi-hat
  // LF bands: FFT 4096 at 44.1kHz (~10.77 Hz/bin) — kick, bass
  // path: 'LF' or 'HF' determines which analyser/processor handles each band.
  // sensScale: per-band sensitivity multiplier applied to the global threshold.
  const BANDS = [
    { name: 'kick',   label: 'Kick (40–150 Hz)',        binStart: 4,   binEnd: 14,  sensScale: 1.4, path: 'LF' },  // FFT 4096: ~43–151 Hz (10 bins)
    { name: 'bass',   label: 'Bass (150–400 Hz)',       binStart: 14,  binEnd: 37,  sensScale: 1.2, path: 'LF' },  // FFT 4096: ~151–399 Hz (23 bins)
    { name: 'mid',    label: 'Mid (400 Hz–2 kHz)',      binStart: 9,   binEnd: 47,  sensScale: 1.0, path: 'HF' },  // FFT 1024: ~387–2025 Hz
    { name: 'snare',  label: 'Snare Crack (2–5 kHz)',   binStart: 47,  binEnd: 116, sensScale: 1.0, path: 'HF' },  // FFT 1024: ~2025–4996 Hz
    { name: 'hihat',  label: 'Hi-hat (6–16 kHz)',       binStart: 140, binEnd: 372, sensScale: 0.4, path: 'HF' }   // FFT 1024: ~6029–16kHz
  ];

  // Precompute band lists per path (avoids filtering every frame)
  const HF_BANDS = BANDS.filter(b => b.path === 'HF');
  const LF_BANDS = BANDS.filter(b => b.path === 'LF');

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

  /**
   * Compute per-band spectral flux values from current/prev spectrum buffers.
   * @param {Array} bands - band definitions to process
   * @param {Float32Array} current - current spectrum (dB)
   * @param {Float32Array} prev - previous spectrum (dB)
   * @returns {Object} bandName → flux value
   */
  function computeBandFlux(bands, current, prev) {
    const result = {};
    for (const band of bands) {
      let bandFlux = 0;
      const bEnd = Math.min(band.binEnd, current.length);
      for (let i = band.binStart; i < bEnd; i++) {
        const curr = Math.pow(10, current[i] / 20);
        const prv = Math.pow(10, prev[i] / 20);
        const diff = curr - prv;
        if (diff > 0) bandFlux += diff;
      }
      bandFlux = bandFlux / Math.max(1, bEnd - band.binStart);
      result[band.name] = bandFlux < MIN_FLUX_FLOOR ? 0 : bandFlux;
    }
    return result;
  }

  /**
   * Run per-band peak detection + parabolic interpolation for a set of bands.
   * @param {Array} bands - band definitions to process
   * @param {Object} fluxValues - bandName → flux value
   * @param {number} frameTimeMs - current frame timestamp (ms)
   * @param {number} frameDurationMs - duration of one frame (ms)
   * @param {number} samples - total samples counter for this path
   * @param {number} bufferLen - input buffer length for this path
   * @param {boolean} isWarming - whether warmup is active for this path
   */
  function detectBandOnsets(bands, fluxValues, frameTimeMs, frameDurationMs, samples, bufferLen, isWarming) {
    for (const band of bands) {
      const bs = bandState[band.name];
      const bandFlux = fluxValues[band.name];

      // Track per-band peak envelope
      if (bandFlux > bs.peakEnv) bs.peakEnv = bandFlux;
      bs.peakEnv *= 0.9999;
      if (bs.peakEnv < 0.001) bs.peakEnv = 0.001;

      // Record per-band flux envelope
      bs.fluxEnvelope.push({ time: frameTimeMs, flux: bandFlux });

      // Peak detection: previous frame was a local max?
      if (!isWarming) {
        const bandThresh = (sensitivity / 100) * band.sensScale * bs.peakEnv;
        const isBandPrevPeak = bs.prevFlux > bandThresh
          && bs.prevFlux > bs.prevPrevFlux * SPIKE_RATIO
          && bs.prevFlux >= bandFlux;
        const bandCooldownOk = (samples - bs.lastOnsetSample) > cooldownSampleCount;

        if (isBandPrevPeak && bandCooldownOk && bs.prevFrameTimeMs > 0) {
          // Parabolic interpolation for sub-frame timing
          const denom = bs.prevPrevFlux - 2 * bs.prevFlux + bandFlux;
          let delta = 0;
          if (Math.abs(denom) > 1e-10) {
            delta = 0.5 * (bs.prevPrevFlux - bandFlux) / denom;
            delta = Math.max(-0.5, Math.min(0.5, delta));
          }
          const refinedTime = bs.prevFrameTimeMs + delta * frameDurationMs;
          bs.lastOnsetSample = samples - bufferLen;
          bs.allOnsets.push({ time: refinedTime, amplitude: bs.prevFlux });
        }
      }

      bs.prevPrevFlux = bs.prevFlux;
      bs.prevFrameTimeMs = frameTimeMs;
      bs.prevFlux = bandFlux;
    }
  }

  /** Create and connect dual-path audio processing (HF + LF). */
  function start(micSource, audioCtx) {
    if (processor) return;

    capturedSampleRate = audioCtx.sampleRate;

    // ── HF path: AnalyserNode FFT 1024 — mid, snare, hi-hat ──
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;

    const numBins = analyser.frequencyBinCount; // FFT_SIZE / 2 = 512
    currentSpectrum = new Float32Array(numBins);
    prevSpectrum = new Float32Array(numBins);

    // ── LF path: AnalyserNode FFT 4096 — kick, bass ──
    analyserLF = audioCtx.createAnalyser();
    analyserLF.fftSize = FFT_SIZE_LF;
    analyserLF.smoothingTimeConstant = 0;

    const numBinsLF = analyserLF.frequencyBinCount; // FFT_SIZE_LF / 2 = 2048
    currentSpectrumLF = new Float32Array(numBinsLF);
    prevSpectrumLF = new Float32Array(numBinsLF);

    initBandState();

    // GainNode for input amplification — zero latency, just a per-sample multiply.
    // Auto-gain measures the first ~0.5s and boosts quiet signals (phone speakers,
    // distant mics) so spectral flux rises above the AnalyserNode's noise floor.
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1; // start at unity, auto-gain adjusts after measuring

    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorLF = audioCtx.createScriptProcessor(BUFFER_SIZE_LF, 1, 1);

    // ── HF path callback: broadband onset detection + mid/snare/hihat bands ──
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
          gainNode.gain.linearRampToValueAtTime(desiredGain, audioCtx.currentTime + 0.05);
          console.log('[Groove] Auto-gain: peak=' + autoGainPeak.toFixed(5) +
            ', boost=' + desiredGain.toFixed(1) + 'x (' + (20 * Math.log10(desiredGain)).toFixed(1) + ' dB)');
        }
      }

      // Capture raw PCM for Essentia post-recording analysis
      if (active) {
        if (pcmChunks.length === 0) {
          pcmStartTime = (e.playbackTime + (input.length / 2) / sr) * 1000;
        }
        pcmChunks.push(new Float32Array(input));
      }

      // Pull current spectrum from HF analyser (dB values)
      analyser.getFloatFrequencyData(currentSpectrum);

      // Compute broadband spectral flux (for tempo detection + broadband onsets)
      let flux = 0;
      const end = Math.min(BIN_END, currentSpectrum.length);
      for (let i = BIN_START; i < end; i++) {
        const curr = Math.pow(10, currentSpectrum[i] / 20);
        const prev = Math.pow(10, prevSpectrum[i] / 20);
        const diff = curr - prev;
        if (diff > 0) flux += diff;
      }
      flux /= (end - BIN_START);

      // Per-band flux for HF bands only
      const bandFluxValues = active ? computeBandFlux(HF_BANDS, currentSpectrum, prevSpectrum) : {};

      // Swap HF spectrum buffers
      const tmp = prevSpectrum;
      prevSpectrum = currentSpectrum;
      currentSpectrum = tmp;

      totalSamples += input.length;

      // Track peak for normalization
      if (flux > peakEnv) peakEnv = flux;
      peakEnv *= 0.9999;
      if (peakEnv < 0.001) peakEnv = 0.001;

      // Store for level display
      currentFlux = flux;

      // Record continuous flux envelope for autocorrelation-based tempo
      if (active) {
        fluxEnvelope.push({ time: frameTimeMs, flux: flux });
        if (fluxFrameRate === 0) fluxFrameRate = sr / input.length;

        warming = warmupRemaining > 0;
        if (warming) warmupRemaining--;

        // Per-band onset detection for HF bands (mid, snare, hi-hat)
        detectBandOnsets(HF_BANDS, bandFluxValues, frameTimeMs, frameDurationMs, totalSamples, input.length, warming);
      }

      if (!active) {
        prevPrevFlux = prevFlux;
        prevFrameTimeMs = frameTimeMs;
        prevFlux = flux;
        return;
      }

      // Broadband peak detection with sub-frame parabolic interpolation
      if (!warming) {
        const thresh = (sensitivity / 100) * peakEnv;
        const isPrevPeak = prevFlux > thresh
          && prevFlux > prevPrevFlux * SPIKE_RATIO
          && prevFlux >= flux;
        const cooldownOk = (totalSamples - lastOnsetSample) > cooldownSampleCount;

        if (isPrevPeak && cooldownOk && prevFrameTimeMs > 0) {
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
      }

      prevPrevFlux = prevFlux;
      prevFrameTimeMs = frameTimeMs;
      prevFlux = flux;
    };

    // ── LF path callback: kick and bass bands only ──
    processorLF.onaudioprocess = function (e) {
      if (!active) return;

      const input = e.inputBuffer.getChannelData(0);
      const sr = audioCtx.sampleRate;
      const frameTimeMs = (e.playbackTime + (input.length / 2) / sr) * 1000;
      const frameDurationMs = (input.length / sr) * 1000;

      // Pull current spectrum from LF analyser (dB values)
      analyserLF.getFloatFrequencyData(currentSpectrumLF);

      // Per-band flux for LF bands
      const bandFluxValues = computeBandFlux(LF_BANDS, currentSpectrumLF, prevSpectrumLF);

      // Swap LF spectrum buffers
      const tmp = prevSpectrumLF;
      prevSpectrumLF = currentSpectrumLF;
      currentSpectrumLF = tmp;

      totalSamplesLF += input.length;

      // LF warmup (scaled for slower frame rate)
      warmingLF = warmupRemainingLF > 0;
      if (warmingLF) warmupRemainingLF--;

      // Per-band onset detection for LF bands (kick, bass)
      detectBandOnsets(LF_BANDS, bandFluxValues, frameTimeMs, frameDurationMs, totalSamplesLF, input.length, warmingLF);
    };

    // Signal chain: mic → gain → both analysers → both processors → destination
    micSource.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(analyserLF);
    analyser.connect(processor);
    processor.connect(audioCtx.destination);
    analyserLF.connect(processorLF);
    processorLF.connect(audioCtx.destination);
  }

  /** Set sensitivity (0–100). */
  function setSensitivity(val) {
    sensitivity = val;
  }

  /** Set cooldown in samples based on interval. */
  function setCooldown(samples) {
    cooldownSampleCount = samples;
  }

  /** Enable/disable onset detection. */
  function setActive(val) {
    active = val;
    if (val) {
      pendingOnsets = [];
      pcmChunks = [];
      pcmStartTime = 0;
      autoGainFrames = 0;
      autoGainPeak = 0;
      warmupRemaining = WARMUP_FRAMES;
      warmupRemainingLF = WARMUP_FRAMES_LF;
      if (gainNode) gainNode.gain.value = 1; // reset to unity for new measurement
    }
  }

  /** Reset all detection state (call before new session). */
  function reset() {
    // HF path state
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
    if (prevSpectrum) prevSpectrum.fill(-Infinity);

    // LF path state
    totalSamplesLF = 0;
    warmupRemainingLF = 0;
    warmingLF = false;
    if (prevSpectrumLF) prevSpectrumLF.fill(-Infinity);

    initBandState();
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
