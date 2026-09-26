import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const clamp01 = (value) => clamp(value, 0, 1);
const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

export class BeatPhaseTracker {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this.reset();
  }

  reset(timestamp = 0, reason = 'manual-reset') {
    this._epoch = null;
    this._periodMs = 0;
    this._bpm = 0;
    this._phaseConfidence = 0;
    this._lastUpdateAt = Math.max(0, finite(timestamp));
    this._lastEmittedIndex = -1;
    this._lastBeatTime = 0;
    this._correctionMs = 0;
    this._consistentErrorCount = 0;
    this._lastErrorSign = 0;
    this._silenceSince = null;
    this._holdAt = null;
    this._holdPhase = 0;
    this._state = 'searching';
    this._resetReason = reason;
    return this.getSnapshot(timestamp);
  }

  update({
    timestamp = 0,
    bpm = 0,
    tempoState = 'searching',
    tempoConfidence = 0,
    candidate = null,
    signalState = 'signal',
    forceBeat = false,
  } = {}) {
    const now = Math.max(0, finite(timestamp));
    const selectedBpm = finite(bpm);
    const signalSilent = ['silence', 'no-source', 'stale', 'ended', 'error'].includes(signalState);
    if (signalSilent) {
      if (this._silenceSince === null) this._silenceSince = now;
    } else {
      this._silenceSince = null;
    }

    const hold = this._silenceSince !== null && now - this._silenceSince >= this.config.silenceHoldMs;
    if (hold && this._holdAt === null) {
      this._holdAt = now;
      this._holdPhase = this._currentPhase(now);
    } else if (!hold && this._holdAt !== null) {
      if (this._epoch !== null) this._epoch += now - this._holdAt;
      this._holdAt = null;
    }

    if (!(selectedBpm >= this.config.minBpm && selectedBpm <= this.config.maxBpm)) {
      this._state = hold ? 'hold' : tempoState === 'lost' ? 'lost' : 'searching';
      this._phaseConfidence = clamp01(this._phaseConfidence * 0.98);
      this._lastUpdateAt = now;
      return this.getSnapshot(now);
    }

    const nextPeriod = 60_000 / selectedBpm;
    if (!this._periodMs) {
      this._periodMs = nextPeriod;
      this._bpm = selectedBpm;
    } else if (Math.abs(nextPeriod - this._periodMs) > 0.001) {
      const preservedIndex = this._epoch === null
        ? 0
        : Math.max(0, Math.floor((now - this._epoch) / this._periodMs + 1e-9));
      const preservedPhase = this._currentPhase(now);
      this._periodMs = nextPeriod;
      this._bpm = selectedBpm;
      if (this._epoch !== null) {
        this._epoch = now - (preservedIndex + preservedPhase) * this._periodMs;
      }
    }

    let acceptedCandidate = null;
    let phaseErrorMs = 0;
    this._correctionMs = 0;
    if (forceBeat) {
      this._epoch = now;
      this._lastEmittedIndex = -1;
      this._phaseConfidence = Math.max(this._phaseConfidence, 0.75);
      acceptedCandidate = { timestamp: now, strength: 1, confidence: 1 };
    } else if (candidate && !hold) {
      if (this._epoch === null || tempoState === 'lost') {
        this._epoch = candidate.timestamp;
        this._lastEmittedIndex = -1;
        this._phaseConfidence = Math.max(0.35, clamp01(candidate.confidence) * 0.7);
        acceptedCandidate = candidate;
      } else {
        const nearestIndex = Math.round((candidate.timestamp - this._epoch) / this._periodMs);
        const predicted = this._epoch + nearestIndex * this._periodMs;
        phaseErrorMs = candidate.timestamp - predicted;
        const outlierLimit = Math.max(
          this.config.phaseMinimumOutlierMs,
          this._periodMs * this.config.phaseOutlierFraction,
        );
        if (Math.abs(phaseErrorMs) <= outlierLimit) {
          const sign = Math.sign(phaseErrorMs);
          this._consistentErrorCount = sign !== 0 && sign === this._lastErrorSign
            ? this._consistentErrorCount + 1 : 1;
          this._lastErrorSign = sign;
          const strong = Math.abs(phaseErrorMs) >= this.config.phaseStrongCorrectionMs
            && this._consistentErrorCount >= this.config.phaseRelockObservations;
          const gain = strong ? this.config.phaseStrongCorrectionGain : this.config.phaseCorrectionGain;
          const maxCorrection = strong
            ? this.config.phaseMaxCorrectionMs * 1.8
            : this.config.phaseMaxCorrectionMs;
          this._correctionMs = clamp(phaseErrorMs * gain, -maxCorrection, maxCorrection);
          this._epoch += this._correctionMs;
          this._phaseConfidence = clamp01(
            this._phaseConfidence * 0.84
            + clamp01(candidate.confidence) * 0.13
            + (1 - Math.abs(phaseErrorMs) / outlierLimit) * 0.08,
          );
          acceptedCandidate = candidate;
        } else {
          this._consistentErrorCount = 0;
          this._phaseConfidence = clamp01(this._phaseConfidence * 0.94);
        }
      }
    }

    if (this._epoch === null) {
      this._state = hold ? 'hold' : 'awaiting-phase-anchor';
      this._lastUpdateAt = now;
      return this.getSnapshot(now);
    }

    const currentIndex = Math.max(0, Math.floor((now - this._epoch) / this._periodMs + 1e-9));
    const predictedTimestamp = this._epoch + currentIndex * this._periodMs;
    const crossedBeat = currentIndex > this._lastEmittedIndex;
    const eventAllowed = !hold && tempoState !== 'lost' && this._phaseConfidence > 0.08;
    let event = null;
    if (crossedBeat && eventAllowed) {
      const observedNearCurrentBeat = acceptedCandidate
        && Math.abs(acceptedCandidate.timestamp - predictedTimestamp)
          <= Math.max(this.config.phaseMinimumOutlierMs, this._periodMs * 0.25);
      event = Object.freeze({
        timestamp: observedNearCurrentBeat ? acceptedCandidate.timestamp : predictedTimestamp,
        predictedTimestamp,
        observedCandidateTimestamp: observedNearCurrentBeat ? acceptedCandidate.timestamp : null,
        source: observedNearCurrentBeat ? 'observed-corrected' : 'predicted',
        strength: observedNearCurrentBeat ? clamp01(acceptedCandidate.strength) : 0,
        confidence: clamp01(this._phaseConfidence * clamp01(tempoConfidence || 0.6)),
        bpm: selectedBpm,
        phaseErrorMs: observedNearCurrentBeat ? phaseErrorMs : 0,
      });
      this._lastEmittedIndex = currentIndex;
      this._lastBeatTime = predictedTimestamp;
    }

    const elapsedWithoutObservation = acceptedCandidate ? 0 : Math.max(0, now - this._lastUpdateAt);
    if (!acceptedCandidate) {
      const decaySeconds = tempoState === 'locked' ? 20 : 8;
      this._phaseConfidence *= Math.exp(-elapsedWithoutObservation / (decaySeconds * 1000));
    }
    if (hold) this._phaseConfidence *= 0.985;
    if (tempoState === 'unstable') this._phaseConfidence *= 0.992;
    if (tempoState === 'lost') this._phaseConfidence *= 0.96;

    this._state = hold ? 'hold' : tempoState === 'lost' ? 'lost' : 'running';
    this._lastUpdateAt = now;
    return this.getSnapshot(now, event, acceptedCandidate);
  }

  getSnapshot(timestamp = 0, event = null, acceptedCandidate = null) {
    const now = Math.max(0, finite(timestamp));
    const phase = this._holdAt !== null ? this._holdPhase : this._currentPhase(now);
    const currentIndex = this._epoch !== null && this._periodMs
      ? Math.max(0, Math.floor((now - this._epoch) / this._periodMs + 1e-9)) : 0;
    const predictedNextBeatTime = this._epoch !== null && this._periodMs
      ? this._epoch + (currentIndex + 1) * this._periodMs : 0;
    return Object.freeze({
      state: this._state,
      phase,
      periodMs: this._periodMs,
      lastBeatTime: this._lastBeatTime,
      predictedNextBeatTime,
      timeToNextBeatMs: predictedNextBeatTime ? Math.max(0, predictedNextBeatTime - now) : 0,
      beatIndexSinceLock: currentIndex,
      phaseConfidence: clamp01(this._phaseConfidence),
      correctionMs: this._correctionMs,
      isPredictedBeat: event?.source === 'predicted',
      isObservedBeat: event?.source === 'observed-corrected' || Boolean(acceptedCandidate && event),
      event,
    });
  }

  _currentPhase(timestamp) {
    if (this._epoch === null || !this._periodMs) return 0;
    return modulo(timestamp - this._epoch, this._periodMs) / this._periodMs;
  }
}
