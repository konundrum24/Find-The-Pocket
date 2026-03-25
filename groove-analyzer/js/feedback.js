// ============================================
// feedback.js — Feel line generation for all modes
// ============================================

const Feedback = (() => {

  // ── Click Mode Feel Lines ──
  function generateFeelLine(avgOffset, stdDev, bpm, bpmStdDev) {
    const absOff = Math.abs(avgOffset);
    const posWord = avgOffset > 3 ? 'behind' : avgOffset < -3 ? 'ahead of' : 'right on';

    if (absOff < 5 && stdDev < 8)
      return `Dead center and tight \u2014 \u00b1${Math.round(stdDev)}ms consistency. Metronomic precision.`;

    if (avgOffset > 5 && avgOffset <= 25 && stdDev < 10)
      return `Relaxed and consistent \u2014 ${Math.round(absOff)}ms ${posWord} the beat, \u00b1${Math.round(stdDev)}ms. A laid-back pocket.`;

    if (avgOffset > 25 && stdDev < 14)
      return `Deep behind at ${Math.round(absOff)}ms, \u00b1${Math.round(stdDev)}ms. Committed and heavy.`;

    if (avgOffset < -5 && avgOffset >= -25 && stdDev < 10)
      return `Pushing ${Math.round(absOff)}ms ahead, \u00b1${Math.round(stdDev)}ms. Drive and urgency.`;

    if (stdDev > 18)
      return `\u00b1${Math.round(stdDev)}ms spread. The pocket didn\u2019t lock. Work on landing each note in the same spot.`;

    return `About ${Math.round(absOff)}ms ${posWord} the beat, \u00b1${Math.round(stdDev)}ms. ${stdDev < 10 ? 'Solid.' : 'Room to tighten.'}`;
  }

  // ── Free Play Feel Lines ──
  function generateFreePlayFeelLine(avgOffset, stdDev, bpm, bpmStdDev) {
    const ab = Math.abs(avgOffset);
    const pw = avgOffset > 3 ? 'behind' : avgOffset < -3 ? 'ahead of' : 'right on';

    if (ab < 5 && stdDev < 8)
      return `Locked in at ${Math.round(bpm)} BPM \u2014 sitting ${pw} the grid with \u00b1${Math.round(stdDev)}ms consistency. Tight groove.`;

    if (avgOffset > 5 && avgOffset <= 25 && stdDev < 12)
      return `Laid back at ${Math.round(bpm)} BPM \u2014 ${Math.round(ab)}ms ${pw} the beat, \u00b1${Math.round(stdDev)}ms spread. Relaxed pocket.`;

    if (avgOffset > 25 && stdDev < 15)
      return `Deep in the pocket at +${Math.round(ab)}ms behind, ${Math.round(bpm)} BPM. Heavy and committed.`;

    if (avgOffset < -5 && avgOffset >= -25 && stdDev < 12)
      return `Pushing ${Math.round(ab)}ms ahead at ${Math.round(bpm)} BPM. Driving feel, \u00b1${Math.round(stdDev)}ms.`;

    if (stdDev > 18)
      return `${Math.round(bpm)} BPM with \u00b1${Math.round(stdDev)}ms spread \u2014 the pocket is moving around. ${bpmStdDev > 3 ? `Tempo drifting too (\u00b1${bpmStdDev.toFixed(1)} BPM).` : ''}`;

    return `About ${Math.round(ab)}ms ${pw} the beat at ${Math.round(bpm)} BPM. \u00b1${Math.round(stdDev)}ms. ${stdDev < 10 ? 'Solid feel.' : 'Room to tighten.'}`;
  }

  // ── Pocket Playground Feel Lines ──
  function generatePlaygroundFeelLine(avgOffset, stdDev, target) {
    const inZone = avgOffset >= target.positionMin && avgOffset <= target.positionMax;
    const distToZone = inZone ? 0 :
      avgOffset < target.positionMin ? target.positionMin - avgOffset :
      avgOffset - target.positionMax;

    if (inZone && stdDev < 8)
      return `You nailed it \u2014 sitting right in the ${target.name} zone at ${Math.round(Math.abs(avgOffset))}ms with \u00b1${Math.round(stdDev)}ms consistency. This is the pocket.`;

    if (inZone && stdDev < 15)
      return `You found the ${target.name} zone. Position is right, but your spread (\u00b1${Math.round(stdDev)}ms) could tighten. The pocket is there \u2014 now lock it in.`;

    if (inZone)
      return `Your average lands in the ${target.name} zone, but individual hits are scattered (\u00b1${Math.round(stdDev)}ms). The target is right \u2014 the challenge is holding it.`;

    if (distToZone < 10 && stdDev < 12)
      return `Close \u2014 you're ${Math.round(distToZone)}ms from the ${target.name} zone with solid consistency. A small shift and you're there.`;

    if (distToZone < 10)
      return `Almost there \u2014 ${Math.round(distToZone)}ms from the ${target.name} zone. Tighten your spread (\u00b1${Math.round(stdDev)}ms) and you'll find it.`;

    return `The ${target.name} zone is ${avgOffset > target.positionMax ? 'deeper behind' : 'further ahead'} than where you landed. You're at ${avgOffset >= 0 ? '+' : ''}${Math.round(avgOffset)}ms \u2014 the target is ${target.positionMin} to ${target.positionMax}ms. Keep at it.`;
  }

  // ── Subdivision-Aware Free Play Feel Lines ──
  function generateSubdivisionFeelLine(metrics, bpm, bpmStdDev) {
    const { position, consistency, downbeats, subdivisions, density, densityLabel } = metrics;
    const ab = Math.abs(position);
    const pw = position > 3 ? 'behind' : position < -3 ? 'ahead of' : 'right on';

    // Dense pattern with good downbeats but wide overall
    if (density > 0.5 && downbeats && downbeats.consistency < 12 && consistency > 15) {
      return `Busy pattern at ${Math.round(bpm)} BPM \u2014 your downbeats are solid (\u00b1${Math.round(downbeats.consistency)}ms) ` +
        `but the ghost notes spread wider (\u00b1${Math.round(subdivisions ? subdivisions.consistency : consistency)}ms). ` +
        `That's normal for syncopated playing. Overall pocket: ${Math.round(ab)}ms ${pw} the beat.`;
    }

    // Dense pattern, everything tight
    if (density > 0.5 && consistency < 12) {
      return `Dense and locked \u2014 ${densityLabel.toLowerCase()} 16th-note pattern at ${Math.round(bpm)} BPM, ` +
        `${Math.round(ab)}ms ${pw} the beat with \u00b1${Math.round(consistency)}ms across all subdivisions. Tight groove.`;
    }

    // Sparse pattern (mostly quarter/eighth notes)
    if (density < 0.35) {
      if (ab < 5 && consistency < 8)
        return `Clean and centered at ${Math.round(bpm)} BPM. \u00b1${Math.round(consistency)}ms consistency. Solid time.`;
      if (consistency < 12)
        return `${Math.round(ab)}ms ${pw} the beat at ${Math.round(bpm)} BPM. ${consistency < 8 ? 'Tight.' : '\u00b1' + Math.round(consistency) + 'ms \u2014 solid.'} ` +
          `${densityLabel} rhythmic density \u2014 a spacious groove.`;
    }

    // Downbeats tight but overall messy
    if (downbeats && downbeats.consistency < 10 && consistency > 20) {
      return `Your main beats are locked (\u00b1${Math.round(downbeats.consistency)}ms) but the in-between notes are scattered ` +
        `(\u00b1${Math.round(consistency)}ms overall). At ${Math.round(bpm)} BPM, the foundation is there \u2014 ` +
        `tightening the subdivisions would bring the whole groove together.`;
    }

    // General case with downbeat/subdivision breakdown
    if (downbeats && subdivisions) {
      return `${Math.round(bpm)} BPM, ${Math.round(ab)}ms ${pw} the beat. ` +
        `Downbeats: \u00b1${Math.round(downbeats.consistency)}ms. Ghost notes: \u00b1${Math.round(subdivisions.consistency)}ms. ` +
        `${downbeats.consistency < subdivisions.consistency ? 'Main beats are tighter than subdivisions \u2014 that\'s typical.' : 'Interesting \u2014 your subdivisions are as tight as your main beats.'}`;
    }

    // Fallback
    return `${Math.round(bpm)} BPM, ${Math.round(ab)}ms ${pw} the beat, \u00b1${Math.round(consistency)}ms. ` +
      `${consistency < 12 ? 'Solid groove.' : 'The pocket has room to tighten.'}`;
  }

  function positionLabel(avgOffset) {
    if (avgOffset > 3) return 'Behind';
    if (avgOffset < -3) return 'Ahead';
    return 'Center';
  }

  function consistencyLabel(stdDev) {
    if (stdDev < 6) return 'Tight';
    if (stdDev < 12) return 'Moderate';
    return 'Wide';
  }

  function tempoLabel(bpmStdDev) {
    if (bpmStdDev < 1.5) return 'Rock solid';
    return '\u00b1' + bpmStdDev.toFixed(1);
  }

  return {
    generateFeelLine,
    generateFreePlayFeelLine,
    generateSubdivisionFeelLine,
    generatePlaygroundFeelLine,
    positionLabel,
    consistencyLabel,
    tempoLabel
  };
})();
