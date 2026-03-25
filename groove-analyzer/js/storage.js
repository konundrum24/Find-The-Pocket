// ============================================
// storage.js — localStorage CRUD for session history
// ============================================

const Storage = (() => {
  const STORAGE_KEY = 'groove_analyzer_sessions';
  const MAX_SESSIONS = 200;

  function saveSession(session) {
    // Strip large data before persisting to stay within localStorage quota
    const toStore = Object.assign({}, session);

    // Remove per-band onset arrays (only needed for live band timeline display)
    if (toStore.bandAnalysis) {
      toStore.bandAnalysis = toStore.bandAnalysis.map(b => {
        const { onsets, ...rest } = b;
        return rest;
      });
    }

    // Slim down onsets — keep time, offset, classification; drop amplitude/gridTime
    if (toStore.onsets) {
      toStore.onsets = toStore.onsets.map(o => ({
        time: o.time, offset: o.offset,
        isDownbeat: o.isDownbeat, isUpbeat: o.isUpbeat
      }));
    }

    const sessions = getAllSessions();
    sessions.unshift(toStore);
    if (sessions.length > MAX_SESSIONS) sessions.pop();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {
      console.warn('[Storage] Save failed, trimming old sessions:', e.message);
      // If still too large, drop oldest sessions until it fits
      while (sessions.length > 1) {
        sessions.pop();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
          return;
        } catch (_) { /* keep trimming */ }
      }
    }
  }

  function getAllSessions() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  }

  function getSession(id) {
    return getAllSessions().find(s => s.id === id);
  }

  function deleteSession(id) {
    const sessions = getAllSessions().filter(s => s.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }

  function getSessionsByMode(mode) {
    return getAllSessions().filter(s => s.mode === mode);
  }

  function getSessionsByTarget(targetName) {
    return getAllSessions().filter(s => s.targetName === targetName);
  }

  /**
   * Build a session data object from live session results.
   */
  function buildSessionObject(opts) {
    const now = Date.now();
    return {
      id: 'sess_' + now,
      timestamp: now,
      mode: opts.mode,
      tempo: opts.tempo,
      sensitivity: opts.sensitivity,
      latencyOffset: opts.latencyOffset != null ? opts.latencyOffset : null,
      pocketPosition: opts.avgOffset,
      pocketConsistency: opts.stdDev,
      tempoStability: opts.bpmStdDev,
      detectedBpm: opts.tempo,
      onsetCount: opts.hitCount,
      durationMs: opts.durationMs,
      offsets: opts.offsets,
      onsets: opts.onsets,
      targetName: opts.targetName || null,
      targetMin: opts.targetMin != null ? opts.targetMin : null,
      targetMax: opts.targetMax != null ? opts.targetMax : null,
      feelLine: opts.feelLine,
      tempoCurve: opts.tempoCurve || null,
      // Subdivision metrics (optional, present when subdivisions detected)
      downbeatMetrics: opts.downbeatMetrics || null,
      subdivisionMetrics: opts.subdivisionMetrics || null,
      density: opts.density != null ? opts.density : null,
      densityLabel: opts.densityLabel || null,
      bandAnalysis: opts.bandAnalysis || null,
      swingPercent: opts.swingPercent != null ? opts.swingPercent : null,
      swingLabel: opts.swingLabel || null
    };
  }

  /**
   * Compute progress summary from recent sessions.
   */
  function getProgressSummary() {
    const sessions = getAllSessions();
    if (!sessions.length) return null;

    // Current streak (consecutive days)
    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);

    while (true) {
      const dayStart = checkDate.getTime();
      const dayEnd = dayStart + 86400000;
      const hasSession = sessions.some(s => s.timestamp >= dayStart && s.timestamp < dayEnd);
      if (hasSession) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    // Last 10 sessions trends
    const recent10 = sessions.slice(0, 10);
    const older10 = sessions.slice(10, 20);

    const recentAvgPos = recent10.reduce((a, s) => a + s.pocketPosition, 0) / recent10.length;
    const recentAvgCon = recent10.reduce((a, s) => a + s.pocketConsistency, 0) / recent10.length;

    let olderAvgPos = null, olderAvgCon = null;
    if (older10.length >= 3) {
      olderAvgPos = older10.reduce((a, s) => a + s.pocketPosition, 0) / older10.length;
      olderAvgCon = older10.reduce((a, s) => a + s.pocketConsistency, 0) / older10.length;
    }

    return {
      totalSessions: sessions.length,
      streak,
      recentAvgPosition: recentAvgPos,
      recentAvgConsistency: recentAvgCon,
      olderAvgPosition: olderAvgPos,
      olderAvgConsistency: olderAvgCon
    };
  }

  return {
    saveSession,
    getAllSessions,
    getSession,
    deleteSession,
    getSessionsByMode,
    getSessionsByTarget,
    buildSessionObject,
    getProgressSummary
  };
})();
