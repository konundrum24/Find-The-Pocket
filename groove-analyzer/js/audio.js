// ============================================
// audio.js — Audio context, mic access, click generation
// ============================================

const Audio = (() => {
  let audioCtx = null;
  let micStream = null;
  let micSource = null;
  let analyser = null;

  /** Initialize AudioContext and request mic access. Returns true on success. */
  async function init() {
    if (audioCtx) return true;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
    } catch (e) {
      alert('Microphone access is required for Groove Analyzer.');
      audioCtx = null;
      return false;
    }

    micSource = audioCtx.createMediaStreamSource(micStream);

    // Analyser for level display (separate from onset detection)
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    micSource.connect(analyser);

    return true;
  }

  /** Get the AudioContext (must call init first). */
  function getContext() {
    return audioCtx;
  }

  /** Get the mic source node. */
  function getMicSource() {
    return micSource;
  }

  /** Get the analyser node. */
  function getAnalyser() {
    return analyser;
  }

  /** Get current sample rate. */
  function getSampleRate() {
    return audioCtx ? audioCtx.sampleRate : 44100;
  }

  /**
   * Play a click sound at the given audio-context time (seconds).
   * 1kHz sine, 40ms decay — clean and spectrally distinct from instruments.
   */
  function playClick(time) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 1000;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.25, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  /** Resume audio context (required after user gesture on some browsers). */
  async function resume() {
    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
  }

  return {
    init,
    getContext,
    getMicSource,
    getAnalyser,
    getSampleRate,
    playClick,
    resume
  };
})();
