/**
 * File Input Module — Audio file loading, PCM decoding, trim, waveform,
 * and offline onset detection for the phase correction experiment.
 *
 * Enables loading audio files (MP3, WAV, etc.) and processing them through
 * the same analysis pipeline as live mic recording, with byte-for-byte
 * identical input every run.
 */
const FileInput = (function () {
  'use strict';

  // ── FFT Implementation (Cooley-Tukey radix-2) ──────────────────────────

  /** Precompute Blackman window coefficients. */
  function blackmanWindow(size) {
    const w = new Float32Array(size);
    const a0 = 0.42, a1 = 0.5, a2 = 0.08;
    for (let i = 0; i < size; i++) {
      w[i] = a0 - a1 * Math.cos(2 * Math.PI * i / size) + a2 * Math.cos(4 * Math.PI * i / size);
    }
    return w;
  }

  /** In-place radix-2 FFT. real and imag are Float64Arrays of length N (power of 2). */
  function fft(real, imag) {
    const N = real.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
        tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
      }
    }
    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = -2 * Math.PI / len;
      const wR = Math.cos(angle);
      const wI = Math.sin(angle);
      for (let i = 0; i < N; i += len) {
        let curR = 1, curI = 0;
        for (let j = 0; j < halfLen; j++) {
          const a = i + j;
          const b = a + halfLen;
          const tR = curR * real[b] - curI * imag[b];
          const tI = curR * imag[b] + curI * real[b];
          real[b] = real[a] - tR;
          imag[b] = imag[a] - tI;
          real[a] += tR;
          imag[a] += tI;
          const nextR = curR * wR - curI * wI;
          curI = curR * wI + curI * wR;
          curR = nextR;
        }
      }
    }
  }

  /**
   * Compute dB-scale magnitude spectrum (matches AnalyserNode.getFloatFrequencyData).
   * @param {Float32Array} samples - windowed time-domain samples (length = fftSize)
   * @param {Float32Array} window - precomputed window coefficients
   * @param {Float64Array} realBuf - reusable buffer
   * @param {Float64Array} imagBuf - reusable buffer
   * @returns {Float32Array} magnitude spectrum in dB (length = fftSize/2)
   */
  function computeSpectrum(samples, window, realBuf, imagBuf) {
    const N = samples.length;
    for (let i = 0; i < N; i++) {
      realBuf[i] = samples[i] * window[i];
      imagBuf[i] = 0;
    }
    fft(realBuf, imagBuf);
    const numBins = N >> 1;
    const spectrum = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
      const mag = Math.sqrt(realBuf[i] * realBuf[i] + imagBuf[i] * imagBuf[i]) / N;
      spectrum[i] = mag > 0 ? 20 * Math.log10(mag) : -100;
    }
    return spectrum;
  }

  // ── Band definitions (must match onset-detector.js exactly) ────────────

  const BANDS = [
    { name: 'kick',  binStart: 4,   binEnd: 14,  sensScale: 1.4, path: 'LF' },
    { name: 'bass',  binStart: 14,  binEnd: 37,  sensScale: 1.2, path: 'LF' },
    { name: 'mid',   binStart: 9,   binEnd: 47,  sensScale: 1.0, path: 'HF' },
    { name: 'snare', binStart: 47,  binEnd: 116, sensScale: 1.0, path: 'HF' },
    { name: 'hihat', binStart: 140, binEnd: 372, sensScale: 0.4, path: 'HF' }
  ];
  const HF_BANDS = BANDS.filter(b => b.path === 'HF');
  const LF_BANDS = BANDS.filter(b => b.path === 'LF');

  // ── Constants matching onset-detector.js ────────────────────────────────

  const HF_FFT_SIZE = 1024;
  const HF_BUFFER_SIZE = 512;
  const LF_FFT_SIZE = 4096;
  const LF_BUFFER_SIZE = 1024;
  const SPIKE_RATIO = 2.0;
  const MIN_FLUX_FLOOR = 1e-4;
  const AUTO_GAIN_WINDOW = 40;
  const WARMUP_FRAMES_HF = AUTO_GAIN_WINDOW + 5;
  const WARMUP_FRAMES_LF = Math.ceil(WARMUP_FRAMES_HF / 2);
  const TARGET_PEAK = 0.25;
  const MAX_GAIN = 32;
  const MIN_GAIN = 1;
  // Broadband bins (HF path)
  const BB_BIN_START = 2;
  const BB_BIN_END = 200;

  // ── Audio File Loading ─────────────────────────────────────────────────

  /**
   * Load and decode an audio file to mono PCM at 44100 Hz.
   * @param {File} file - audio file from <input type="file">
   * @returns {Promise<{pcm: Float32Array, sampleRate: number, duration: number, audioBuffer: AudioBuffer}>}
   */
  async function loadAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    let audioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } catch (err) {
      audioContext.close();
      throw new Error("Couldn't decode audio file — it may be DRM-protected. Try an MP3 or WAV file.");
    }

    // Mix to mono
    let pcm;
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

    audioContext.close();
    return { pcm, sampleRate: 44100, duration: audioBuffer.duration, audioBuffer };
  }

  /**
   * Trim PCM to a time range.
   * @param {Float32Array} pcm
   * @param {number} sampleRate
   * @param {number} startSec
   * @param {number} endSec
   * @returns {Float32Array}
   */
  function trimPCM(pcm, sampleRate, startSec, endSec) {
    const s = Math.max(0, Math.floor(startSec * sampleRate));
    const e = Math.min(pcm.length, Math.floor(endSec * sampleRate));
    return pcm.slice(s, e);
  }

  // ── Waveform Rendering ─────────────────────────────────────────────────

  /**
   * Draw a waveform overview on a canvas.
   * @param {AudioBuffer} audioBuffer
   * @param {HTMLCanvasElement} canvas
   * @param {number} [trimStart=0] - highlight start (seconds)
   * @param {number} [trimEnd] - highlight end (seconds)
   */
  function renderWaveform(audioBuffer, canvas, trimStart, trimEnd) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const data = audioBuffer.getChannelData(0);
    const dur = audioBuffer.duration;
    trimStart = trimStart || 0;
    trimEnd = trimEnd != null ? trimEnd : dur;

    const step = Math.max(1, Math.floor(data.length / w));

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Draw waveform
    for (let i = 0; i < w; i++) {
      const start = i * step;
      let sumSq = 0;
      for (let j = start; j < start + step && j < data.length; j++) {
        sumSq += data[j] * data[j];
      }
      const rms = Math.sqrt(sumSq / step);
      const barH = Math.min(rms * h * 4, h * 0.95);

      // Dim outside trim region
      const timeSec = (i / w) * dur;
      if (timeSec >= trimStart && timeSec <= trimEnd) {
        ctx.fillStyle = 'rgba(29, 158, 117, 0.8)';
      } else {
        ctx.fillStyle = 'rgba(29, 158, 117, 0.2)';
      }
      ctx.fillRect(i, (h - barH) / 2, 1, barH);
    }

    // Trim markers
    const startX = (trimStart / dur) * w;
    const endX = (trimEnd / dur) * w;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(startX, 0); ctx.lineTo(startX, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(endX, 0); ctx.lineTo(endX, h); ctx.stroke();

    // Selected region overlay
    ctx.fillStyle = 'rgba(251, 191, 36, 0.08)';
    ctx.fillRect(startX, 0, endX - startX, h);
  }

  // ── Auto-detect Groove Start ───────────────────────────────────────────

  /**
   * Detect where periodic groove activity begins using onset density.
   * @param {Float32Array} pcm - full PCM signal
   * @param {number} sampleRate
   * @returns {number} estimated groove start in seconds
   */
  function detectGrooveStart(pcm, sampleRate) {
    // Quick amplitude-based onset detection
    const hopSamples = Math.floor(sampleRate * 0.01); // 10ms hops
    const frameSamples = Math.floor(sampleRate * 0.02); // 20ms frames
    const energies = [];
    for (let i = 0; i < pcm.length - frameSamples; i += hopSamples) {
      let sum = 0;
      for (let j = i; j < i + frameSamples; j++) sum += pcm[j] * pcm[j];
      energies.push(Math.sqrt(sum / frameSamples));
    }

    // Simple onset detection: energy rise exceeding threshold
    const onsetTimes = [];
    const threshold = 0.02;
    let lastOnsetIdx = -10;
    for (let i = 1; i < energies.length; i++) {
      const rise = energies[i] - energies[i - 1];
      if (rise > threshold && i - lastOnsetIdx > 5) {
        onsetTimes.push(i * 0.01); // seconds
        lastOnsetIdx = i;
      }
    }

    if (onsetTimes.length < 4) return 0;

    // Compute onset density in 2s rolling windows, 0.5s hop
    const windowSec = 2.0;
    const hopSec = 0.5;
    const densities = [];
    const totalDur = pcm.length / sampleRate;
    for (let t = 0; t < totalDur - windowSec; t += hopSec) {
      const count = onsetTimes.filter(o => o >= t && o < t + windowSec).length;
      densities.push({ time: t, density: count / windowSec });
    }

    if (densities.length < 2) return 0;

    // Find the first window where density is at least 50% of max density
    const maxDensity = Math.max(...densities.map(d => d.density));
    const grooveThreshold = maxDensity * 0.5;
    for (const d of densities) {
      if (d.density >= grooveThreshold) return Math.max(0, d.time);
    }
    return 0;
  }

  // ── Offline Onset Detection (mirrors onset-detector.js) ────────────────

  /**
   * Process PCM data offline through the same dual-path onset detection
   * as the real-time engine, producing sessionOnsets and bandOnsets.
   *
   * @param {Float32Array} pcm - mono PCM at 44100 Hz
   * @param {number} sampleRate - must be 44100
   * @param {number|Object} sensitivityOrParams - sensitivity number (legacy) or params object
   * @param {number} [cooldownMs] - cooldown between onsets (default 80), ignored if params object used
   * @returns {{sessionOnsets: Array, bandOnsets: Object, fluxEnvelope: Array, fluxFrameRate: number}}
   */
  function detectOnsetsOffline(pcm, sampleRate, sensitivityOrParams, cooldownMs) {
    // Support both legacy (sensitivity, cooldownMs) and new params object API
    let sensitivity, fftSizeHF, fftSizeLF, bufferSizeHF, bufferSizeLF;
    if (sensitivityOrParams && typeof sensitivityOrParams === 'object') {
      const p = sensitivityOrParams;
      sensitivity = p.sensitivity || 8;
      cooldownMs = p.cooldownMs || 80;
      fftSizeHF = p.fftSizeHF || HF_FFT_SIZE;
      fftSizeLF = p.fftSizeLF || LF_FFT_SIZE;
      bufferSizeHF = p.bufferSizeHF || HF_BUFFER_SIZE;
      bufferSizeLF = p.bufferSizeLF || LF_BUFFER_SIZE;
    } else {
      sensitivity = sensitivityOrParams || 8;
      cooldownMs = cooldownMs || 80;
      fftSizeHF = HF_FFT_SIZE;
      fftSizeLF = LF_FFT_SIZE;
      bufferSizeHF = HF_BUFFER_SIZE;
      bufferSizeLF = LF_BUFFER_SIZE;
    }
    const cooldownSamples = Math.floor((cooldownMs / 1000) * sampleRate);

    // Recompute warmup frames based on actual buffer size
    const warmupFramesHF = Math.ceil((AUTO_GAIN_WINDOW + 5) * HF_BUFFER_SIZE / bufferSizeHF);
    const warmupFramesLF = Math.ceil(warmupFramesHF / 2);

    // ── Auto-gain: measure peak over first ~0.5s ──
    const autoGainSamples = AUTO_GAIN_WINDOW * bufferSizeHF;
    let peakAmp = 0;
    const measEnd = Math.min(autoGainSamples, pcm.length);
    for (let i = 0; i < measEnd; i++) {
      const abs = Math.abs(pcm[i]);
      if (abs > peakAmp) peakAmp = abs;
    }
    const gain = peakAmp > 0.0001
      ? Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_PEAK / peakAmp))
      : 1;
    console.log('[FileInput] Auto-gain: peak=' + peakAmp.toFixed(5) +
      ', boost=' + gain.toFixed(1) + 'x');

    // Apply gain to a copy of PCM
    const gained = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) gained[i] = pcm[i] * gain;

    // ── Precompute windows and FFT buffers ──
    const hfWindow = blackmanWindow(fftSizeHF);
    const lfWindow = blackmanWindow(fftSizeLF);
    const hfReal = new Float64Array(fftSizeHF);
    const hfImag = new Float64Array(fftSizeHF);
    const lfReal = new Float64Array(fftSizeLF);
    const lfImag = new Float64Array(fftSizeLF);

    // ── HF path state ──
    let hfPrevSpectrum = new Float32Array(fftSizeHF >> 1).fill(-100);
    let hfPrevFlux = 0, hfPrevPrevFlux = 0, hfPeakEnv = 0.001;
    let hfLastOnsetSample = 0, hfPrevFrameTimeMs = 0;
    const sessionOnsets = [];
    const fluxEnvelope = [];
    const fluxFrameRate = sampleRate / bufferSizeHF;

    // Recompute HF band bin ranges if FFT size changed from default
    const hfBinScale = fftSizeHF / HF_FFT_SIZE;
    const activeBandsHF = HF_BANDS.map(b => ({
      ...b,
      binStart: Math.round(b.binStart * hfBinScale),
      binEnd: Math.round(b.binEnd * hfBinScale)
    }));
    const bbBinStart = Math.round(BB_BIN_START * hfBinScale);
    const bbBinEnd = Math.round(BB_BIN_END * hfBinScale);

    // Per-band state for HF bands
    const hfBandState = {};
    for (const b of activeBandsHF) {
      hfBandState[b.name] = {
        prevFlux: 0, prevPrevFlux: 0, prevFrameTimeMs: 0,
        peakEnv: 0.001, lastOnsetSample: 0, allOnsets: []
      };
    }

    // ── LF path state ──
    let lfPrevSpectrum = new Float32Array(fftSizeLF >> 1).fill(-100);
    // Recompute LF band bin ranges if FFT size changed from default
    const lfBinScale = fftSizeLF / LF_FFT_SIZE;
    const activeBandsLF = LF_BANDS.map(b => ({
      ...b,
      binStart: Math.round(b.binStart * lfBinScale),
      binEnd: Math.round(b.binEnd * lfBinScale)
    }));

    const lfBandState = {};
    for (const b of activeBandsLF) {
      lfBandState[b.name] = {
        prevFlux: 0, prevPrevFlux: 0, prevFrameTimeMs: 0,
        peakEnv: 0.001, lastOnsetSample: 0, allOnsets: []
      };
    }

    // ── Process HF path ──
    let hfTotalSamples = 0;
    let hfWarmup = warmupFramesHF;
    const hfFrameDurationMs = (bufferSizeHF / sampleRate) * 1000;

    for (let frameStart = 0; frameStart + fftSizeHF <= gained.length; frameStart += bufferSizeHF) {
      const frameTimeMs = ((frameStart + bufferSizeHF / 2) / sampleRate) * 1000;
      hfTotalSamples += bufferSizeHF;

      // Get spectrum
      const samples = gained.subarray(frameStart, frameStart + fftSizeHF);
      const spectrum = computeSpectrum(samples, hfWindow, hfReal, hfImag);

      // Broadband flux
      let flux = 0;
      const end = Math.min(bbBinEnd, spectrum.length);
      for (let i = bbBinStart; i < end; i++) {
        const curr = Math.pow(10, spectrum[i] / 20);
        const prev = Math.pow(10, hfPrevSpectrum[i] / 20);
        const diff = curr - prev;
        if (diff > 0) flux += diff;
      }
      flux /= (end - bbBinStart);

      // Per-band flux
      const bandFlux = {};
      for (const band of activeBandsHF) {
        let bf = 0;
        const bEnd = Math.min(band.binEnd, spectrum.length);
        for (let i = band.binStart; i < bEnd; i++) {
          const curr = Math.pow(10, spectrum[i] / 20);
          const prev = Math.pow(10, hfPrevSpectrum[i] / 20);
          const diff = curr - prev;
          if (diff > 0) bf += diff;
        }
        bf /= Math.max(1, bEnd - band.binStart);
        bandFlux[band.name] = bf < MIN_FLUX_FLOOR ? 0 : bf;
      }

      // Swap spectrum
      hfPrevSpectrum = spectrum;

      // Track broadband peak envelope
      if (flux > hfPeakEnv) hfPeakEnv = flux;
      hfPeakEnv *= 0.9999;
      if (hfPeakEnv < 0.001) hfPeakEnv = 0.001;

      fluxEnvelope.push({ time: frameTimeMs, flux: flux });

      const warming = hfWarmup > 0;
      if (hfWarmup > 0) hfWarmup--;

      // Per-band onset detection
      for (const band of activeBandsHF) {
        const bs = hfBandState[band.name];
        const bf = bandFlux[band.name];
        if (bf > bs.peakEnv) bs.peakEnv = bf;
        bs.peakEnv *= 0.9999;
        if (bs.peakEnv < 0.001) bs.peakEnv = 0.001;

        if (!warming) {
          const bandThresh = (sensitivity / 100) * band.sensScale * bs.peakEnv;
          const isPeak = bs.prevFlux > bandThresh
            && bs.prevFlux > bs.prevPrevFlux * SPIKE_RATIO
            && bs.prevFlux >= bf;
          const cooldownOk = (hfTotalSamples - bs.lastOnsetSample) > cooldownSamples;

          if (isPeak && cooldownOk && bs.prevFrameTimeMs > 0) {
            const denom = bs.prevPrevFlux - 2 * bs.prevFlux + bf;
            let delta = 0;
            if (Math.abs(denom) > 1e-10) {
              delta = 0.5 * (bs.prevPrevFlux - bf) / denom;
              delta = Math.max(-0.5, Math.min(0.5, delta));
            }
            const refinedTime = bs.prevFrameTimeMs + delta * hfFrameDurationMs;
            bs.lastOnsetSample = hfTotalSamples - bufferSizeHF;
            bs.allOnsets.push({ time: refinedTime, amplitude: bs.prevFlux });
          }
        }
        bs.prevPrevFlux = bs.prevFlux;
        bs.prevFrameTimeMs = frameTimeMs;
        bs.prevFlux = bf;
      }

      // Broadband onset detection
      if (!warming) {
        const thresh = (sensitivity / 100) * hfPeakEnv;
        const isPrevPeak = hfPrevFlux > thresh
          && hfPrevFlux > hfPrevPrevFlux * SPIKE_RATIO
          && hfPrevFlux >= flux;
        const cooldownOk = (hfTotalSamples - hfLastOnsetSample) > cooldownSamples;

        if (isPrevPeak && cooldownOk && hfPrevFrameTimeMs > 0) {
          const denom = hfPrevPrevFlux - 2 * hfPrevFlux + flux;
          let delta = 0;
          if (Math.abs(denom) > 1e-10) {
            delta = 0.5 * (hfPrevPrevFlux - flux) / denom;
            delta = Math.max(-0.5, Math.min(0.5, delta));
          }
          const refinedTime = hfPrevFrameTimeMs + delta * hfFrameDurationMs;
          hfLastOnsetSample = hfTotalSamples - bufferSizeHF;
          sessionOnsets.push({ time: refinedTime, amplitude: hfPrevFlux });
        }
      }

      hfPrevPrevFlux = hfPrevFlux;
      hfPrevFrameTimeMs = frameTimeMs;
      hfPrevFlux = flux;
    }

    // ── Process LF path ──
    let lfTotalSamples = 0;
    let lfWarmup = warmupFramesLF;
    const lfFrameDurationMs = (bufferSizeLF / sampleRate) * 1000;

    for (let frameStart = 0; frameStart + fftSizeLF <= gained.length; frameStart += bufferSizeLF) {
      const frameTimeMs = ((frameStart + bufferSizeLF / 2) / sampleRate) * 1000;
      lfTotalSamples += bufferSizeLF;

      const samples = gained.subarray(frameStart, frameStart + fftSizeLF);
      const spectrum = computeSpectrum(samples, lfWindow, lfReal, lfImag);

      // Per-band flux
      const bandFlux = {};
      for (const band of activeBandsLF) {
        let bf = 0;
        const bEnd = Math.min(band.binEnd, spectrum.length);
        for (let i = band.binStart; i < bEnd; i++) {
          const curr = Math.pow(10, spectrum[i] / 20);
          const prev = Math.pow(10, lfPrevSpectrum[i] / 20);
          const diff = curr - prev;
          if (diff > 0) bf += diff;
        }
        bf /= Math.max(1, bEnd - band.binStart);
        bandFlux[band.name] = bf < MIN_FLUX_FLOOR ? 0 : bf;
      }

      lfPrevSpectrum = spectrum;

      const warming = lfWarmup > 0;
      if (lfWarmup > 0) lfWarmup--;

      // Per-band onset detection for LF
      for (const band of activeBandsLF) {
        const bs = lfBandState[band.name];
        const bf = bandFlux[band.name];
        if (bf > bs.peakEnv) bs.peakEnv = bf;
        bs.peakEnv *= 0.9999;
        if (bs.peakEnv < 0.001) bs.peakEnv = 0.001;

        if (!warming) {
          const bandThresh = (sensitivity / 100) * band.sensScale * bs.peakEnv;
          const isPeak = bs.prevFlux > bandThresh
            && bs.prevFlux > bs.prevPrevFlux * SPIKE_RATIO
            && bs.prevFlux >= bf;
          const cooldownOk = (lfTotalSamples - bs.lastOnsetSample) > cooldownSamples;

          if (isPeak && cooldownOk && bs.prevFrameTimeMs > 0) {
            const denom = bs.prevPrevFlux - 2 * bs.prevFlux + bf;
            let delta = 0;
            if (Math.abs(denom) > 1e-10) {
              delta = 0.5 * (bs.prevPrevFlux - bf) / denom;
              delta = Math.max(-0.5, Math.min(0.5, delta));
            }
            const refinedTime = bs.prevFrameTimeMs + delta * lfFrameDurationMs;
            bs.lastOnsetSample = lfTotalSamples - bufferSizeLF;
            bs.allOnsets.push({ time: refinedTime, amplitude: bs.prevFlux });
          }
        }
        bs.prevPrevFlux = bs.prevFlux;
        bs.prevFrameTimeMs = frameTimeMs;
        bs.prevFlux = bf;
      }
    }

    // Assemble band onsets
    const bandOnsets = {};
    for (const b of BANDS) {
      const state = b.path === 'HF' ? hfBandState[b.name] : lfBandState[b.name];
      bandOnsets[b.name] = state.allOnsets;
    }

    console.log('[FileInput] Offline detection complete: ' +
      sessionOnsets.length + ' broadband onsets, ' +
      'kick=' + bandOnsets.kick.length + ', snare=' + bandOnsets.snare.length +
      ', hihat=' + bandOnsets.hihat.length);

    return { sessionOnsets, bandOnsets, fluxEnvelope, fluxFrameRate };
  }

  // ── Format time as MM:SS ───────────────────────────────────────────────

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  return {
    loadAudioFile,
    trimPCM,
    renderWaveform,
    detectGrooveStart,
    detectOnsetsOffline,
    formatTime
  };
})();
