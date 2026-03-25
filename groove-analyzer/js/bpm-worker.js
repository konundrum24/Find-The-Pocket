// ============================================
// bpm-worker.js — Web Worker for live BPM estimation
//
// Loads Essentia.js WASM and runs PercivalBpmEstimator
// on accumulated PCM audio during Free Play recording.
// ============================================

let essentia = null;
let essentiaReady = false;

// Load Essentia.js WASM inside the worker
importScripts(
  'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.js',
  'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.js'
);

async function initEssentia() {
  try {
    const wasmModule = await EssentiaWASM();
    essentia = new Essentia(wasmModule);
    essentiaReady = true;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Essentia init failed: ' + err.message });
  }
}

initEssentia();

self.onmessage = function (e) {
  if (e.data.type !== 'estimate') return;

  if (!essentiaReady || !essentia) {
    self.postMessage({ type: 'result', bpm: null, error: 'Essentia not ready' });
    return;
  }

  const pcm = e.data.pcm; // Float32Array (already a copy from main thread)
  const sampleRate = e.data.sampleRate || 44100;

  try {
    // Resample to 44100 if needed
    let signal = pcm;
    if (sampleRate !== 44100) {
      const ratio = 44100 / sampleRate;
      const newLength = Math.round(pcm.length * ratio);
      signal = new Float32Array(newLength);
      for (let i = 0; i < newLength; i++) {
        const srcIdx = i / ratio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, pcm.length - 1);
        const frac = srcIdx - idx0;
        signal[i] = pcm[idx0] * (1 - frac) + pcm[idx1] * frac;
      }
    }

    const vectorSignal = essentia.arrayToVector(signal);

    let result;
    try {
      result = essentia.PercivalBpmEstimator(vectorSignal);
    } catch (err) {
      vectorSignal.delete();
      self.postMessage({ type: 'result', bpm: null, error: 'PercivalBpmEstimator failed: ' + err.message });
      return;
    }

    // Deep copy the BPM value before cleaning up WASM memory
    const bpm = Number(result.bpm);

    // Clean up WASM vectors
    try { vectorSignal.delete(); } catch (_) {}

    if (!bpm || isNaN(bpm) || bpm <= 0) {
      self.postMessage({ type: 'result', bpm: null, error: 'Invalid BPM result' });
      return;
    }

    self.postMessage({ type: 'result', bpm: bpm });
  } catch (err) {
    self.postMessage({ type: 'result', bpm: null, error: err.message });
  }
};
