// ============================================
// grid.js — Grid establishment (Click Mode)
//
// Manages the metronome click scheduling and stores
// the known grid timestamps for offset analysis.
// ============================================

const Grid = (() => {
  let clickGridTimes = [];  // Quarter-note positions (where click sounds)
  let allGridTimes = [];    // All 16th-note positions (for analysis)
  let gridUnitMs = 0;
  let beatMs = 0;
  let clickIntervalId = null;

  /**
   * Start the click track and build the grid.
   * Click plays on quarter notes only. All 16th-note positions are stored
   * for subdivision-aware analysis.
   *
   * @param {number} tempo - BPM
   * @param {AudioContext} audioCtx
   */
  function startClick(tempo, audioCtx) {
    clickGridTimes = [];
    allGridTimes = [];
    const beatIntervalSec = 60 / tempo;
    const gridUnitSec = beatIntervalSec / 4; // 16th note
    beatMs = beatIntervalSec * 1000;
    gridUnitMs = gridUnitSec * 1000;
    let nextTime = audioCtx.currentTime + 0.15;
    let gridIndex = 0;

    function schedule() {
      const now = audioCtx.currentTime;
      while (nextTime < now + 0.25) {
        const isQuarterNote = (gridIndex % 4 === 0);

        if (isQuarterNote) {
          Audio.playClick(nextTime);
          clickGridTimes.push(nextTime * 1000);
        }

        allGridTimes.push(nextTime * 1000);
        nextTime += gridUnitSec;
        gridIndex++;
      }
    }

    schedule();
    clickIntervalId = setInterval(schedule, 25);
  }

  /** Stop the click track. */
  function stopClick() {
    if (clickIntervalId) {
      clearInterval(clickIntervalId);
      clickIntervalId = null;
    }
  }

  /** Get quarter-note grid timestamps (ms). Used by calibration. */
  function getGridTimes() {
    return clickGridTimes;
  }

  /** Get the full 16th-note grid object for subdivision analysis. */
  function getSubdivisionGrid() {
    return {
      points: allGridTimes,
      gridUnitMs,
      beatMs,
      subdivisions: 4
    };
  }

  /** Clear grid data. */
  function reset() {
    clickGridTimes = [];
    allGridTimes = [];
    gridUnitMs = 0;
    beatMs = 0;
    stopClick();
  }

  return {
    startClick,
    stopClick,
    getGridTimes,
    getSubdivisionGrid,
    reset
  };
})();
