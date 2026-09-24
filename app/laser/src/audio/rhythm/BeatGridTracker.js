import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const clamp01 = (value) => clamp(value, 0, 1);
const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const silentStates = new Set(['silence', 'no-source', 'stale', 'ended', 'error']);

/**
 * Maintains a regular quarter-note grid. Grid position is deliberately
 * provisional: this tracker does not infer downbeats, bars or phrases.
 */
export class BeatGridTracker {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this.reset();
  }

  reset(timestamp = 0, reason = 'manual-reset') {
    this.state = 'searching';
    this.bpm = 0;
    this.periodMs = 0;
    this.epoch = Math.max(0, finite(timestamp));
    this.lastTimestamp = this.epoch;
    this.lastBeatTime = 0;
    this.lastEmittedIndex = -1;
    this.lastEvent = null;
    this.lastCorrectionMs = 0;
    this.lastCandidateDistanceMs = null;
    this.lastCandidateAccepted = false;
    this.lastCandidateEvaluated = false;
    this.lastCandidateClassification = 'none';
    this.lastCandidateWeight = 0;
    this.lastAnchorAccepted = false;
    this.anchorRejectReason = 'none';
    this.currentAnchorCluster = null;
    this.anchorOffsetHistory = [];
    this.clusterStats = {
      clusters: 0,
      rejectedDuplicateOnsets: 0,
      acceptedClusterAnchors: 0,
    };
    this.consistentErrors = [];
    this.holdStartedAt = 0;
    this.holdPhase = 0;
    this.holdIndex = 0;
    this.gridConfidence = 0;
    this.gridStability = 0;
    this.observedSupport = 0;
    this.predictedSupport = 0;
    this.audioAnchors = [];
    this.anchorStats = {
      candidates: 0,
      veryClose: 0,
      close: 0,
      usable: 0,
      offGrid: 0,
      corrections: 0,
      confirmations: 0,
    };
    this.missingBeatCount = 0;
    this.reason = reason;
    return this.getSnapshot(this.epoch);
  }

  update({
    timestamp = 0,
    tempo = {},
    candidate = null,
    signalState = 'signal',
    forceBeat = false,
  } = {}) {
    const now = Math.max(this.lastTimestamp, Math.max(0, finite(timestamp)));
    const silent = silentStates.has(signalState);
    this.lastEvent = null;
    this.lastCandidateAccepted = false;
    this.lastAnchorAccepted = false;
    this.lastCandidateEvaluated = false;
    this.lastCorrectionMs = 0;

    if (silent) {
      this._enterHold(now, tempo);
      this.lastTimestamp = now;
      return this.getSnapshot(now);
    }
    this._leaveHold(now);
    this._adoptTempo(tempo, now);
    if (!(this.periodMs > 0)) {
      this.state = 'searching';
      this.reason = 'tempo-unavailable';
      this.lastTimestamp = now;
      return this.getSnapshot(now);
    }

    if (forceBeat) {
      const currentIndex = Math.max(0, Math.floor((now - this.epoch) / this.periodMs));
      this.epoch = now - currentIndex * this.periodMs;
      this.lastEmittedIndex = currentIndex - 1;
      this.consistentErrors = [];
      this.reason = 'manual-beat-sync';
    }

    if (candidate?.timestamp !== undefined) this._collectAnchorCandidate(candidate, now, tempo);
    this._emitCrossedBeat(now, candidate);
    this._updateConfidence(tempo, candidate, now);
    this.lastTimestamp = now;
    return this.getSnapshot(now);
  }

  getSnapshot(timestamp = this.lastTimestamp) {
    const now = Math.max(0, finite(timestamp));
    const elapsed = this.periodMs > 0 ? Math.max(0, now - this.epoch) : 0;
    const rawIndex = this.periodMs > 0 ? elapsed / this.periodMs : 0;
    const beatIndex = this.state === 'hold' ? this.holdIndex : Math.max(0, Math.floor(rawIndex));
    const phase = this.state === 'hold' ? this.holdPhase : (this.periodMs > 0 ? rawIndex - Math.floor(rawIndex) : 0);
    const next = this.periodMs > 0
      ? this.epoch + (Math.floor(rawIndex) + 1) * this.periodMs : 0;
    const event = this.lastEvent ? { ...this.lastEvent } : null;
    return Object.freeze({
      state: this.state,
      bpm: this.bpm,
      periodMs: this.periodMs,
      phase: clamp01(phase),
      gridConfidence: clamp01(this.gridConfidence),
      gridStability: clamp01(this.gridStability),
      phaseConfidence: clamp01(this.gridConfidence),
      lastBeatTime: this.lastBeatTime,
      predictedNextBeatTime: this.state === 'hold' ? 0 : next,
      timeToNextBeatMs: this.state === 'hold' ? 0 : Math.max(0, next - now),
      beatIndex,
      beatIndexSinceLock: beatIndex,
      provisionalGridPosition: beatIndex % 4,
      supportScore: clamp01(this.audioAnchors.reduce((sum, anchor) => sum + anchor.weight, 0) / 6),
      missingBeatTolerance: Math.max(0, this.missingBeatCount),
      correctionMs: this.lastCorrectionMs,
      nearestCandidateDistanceMs: this.lastCandidateDistanceMs,
      candidateAcceptedForCorrection: this.lastCandidateAccepted,
      candidateEvaluated: this.lastCandidateEvaluated,
      candidateClassification: this.lastCandidateClassification,
      candidateWeight: this.lastCandidateWeight,
      audioAnchorRate: this._audioAnchorRate(),
      audioAnchorCount: this.audioAnchors.length,
      audioAnchorCorrections: this.anchorStats.corrections,
      audioAnchorConfirmations: this.anchorStats.confirmations,
      audioAnchorCandidates: this.anchorStats.candidates,
      offGridCandidateCount: this.anchorStats.offGrid,
      clusterCandidateCount: this.currentAnchorCluster?.candidateCount || 0,
      clusterDurationMs: this.currentAnchorCluster
        ? Math.max(0, this.currentAnchorCluster.endTime - this.currentAnchorCluster.startTime) : 0,
      clusterStrength: clamp01(this.currentAnchorCluster?.combinedStrength || 0),
      representativeCandidateOffsetMs: this.currentAnchorCluster?.representativeOffsetMs ?? null,
      anchorOffsetConsistency: clamp01(this._anchorOffsetConsistency()),
      anchorAccepted: this.lastAnchorAccepted,
      anchorRejectReason: this.anchorRejectReason,
      anchorClusterCount: this.clusterStats.clusters,
      rejectedDuplicateOnsets: this.clusterStats.rejectedDuplicateOnsets,
      acceptedClusterAnchors: this.clusterStats.acceptedClusterAnchors,
      isPredictedBeat: event?.source === 'predicted',
      isObservedBeat: event?.source === 'observed-corrected',
      event,
      reason: this.reason,
    });
  }

  _enterHold(timestamp, tempo) {
    if (this.state !== 'hold') {
      const raw = this.periodMs > 0 ? Math.max(0, (timestamp - this.epoch) / this.periodMs) : 0;
      this.holdIndex = Math.floor(raw);
      this.holdPhase = raw - this.holdIndex;
      this.holdStartedAt = timestamp;
    }
    this.state = this.bpm || tempo.bpm ? 'hold' : 'searching';
    this.gridConfidence = clamp01(this.gridConfidence * 0.995);
    this.reason = 'silence-grid-hold';
  }

  _leaveHold(timestamp) {
    if (!this.holdStartedAt) return;
    this.epoch += Math.max(0, timestamp - this.holdStartedAt);
    this.holdStartedAt = 0;
    this.state = this.bpm ? 'tentative' : 'searching';
    this.reason = 'grid-resume';
  }

  _adoptTempo(tempo, timestamp) {
    const nextBpm = finite(tempo.bpm);
    if (!(nextBpm >= this.config.minBpm && nextBpm <= this.config.maxBpm)) {
      if (['lost', 'searching'].includes(tempo.state) && !this.bpm) this.state = tempo.state;
      return;
    }
    const nextPeriod = 60_000 / nextBpm;
    if (!(this.periodMs > 0)) {
      const anchor = finite(tempo.phaseAnchorTimestamp, timestamp);
      this.epoch = anchor <= timestamp ? anchor : timestamp;
      this.bpm = nextBpm;
      this.periodMs = nextPeriod;
      this.lastEmittedIndex = Math.floor((timestamp - this.epoch) / this.periodMs) - 1;
      this.state = tempo.state === 'locked' ? 'locked' : 'tentative';
      this.reason = 'grid-initialized';
      return;
    }
    if (Math.abs(nextBpm - this.bpm) < 0.0001) {
      this.state = tempo.state === 'locked' ? 'locked' : (tempo.state || this.state);
      return;
    }
    const oldRaw = Math.max(0, (timestamp - this.epoch) / this.periodMs);
    const index = Math.floor(oldRaw);
    const phase = oldRaw - index;
    this.epoch = timestamp - (index + phase) * nextPeriod;
    this.bpm = nextBpm;
    this.periodMs = nextPeriod;
    this.state = tempo.state === 'locked' ? 'locked' : 'tentative';
    this.reason = 'tempo-refinement-phase-preserved';
  }

  _collectAnchorCandidate(candidate, timestamp, tempo) {
    const observed = Math.max(0, finite(candidate.timestamp, timestamp));
    const clusterWindowMs = this._anchorClusterWindowMs();
    const active = this.currentAnchorCluster;
    if (active && observed - active.startTime <= clusterWindowMs) {
      active.endTime = Math.max(active.endTime, observed);
      active.candidateCount++;
      active.combinedStrength = clamp01(active.combinedStrength + clamp01(candidate.strength) * 0.35);
      const offset = this._candidateGridOffset(observed);
      const multiBand = this._candidateMultiBand(candidate);
      const representativeScore = this._representativeScore(offset, candidate, multiBand);
      if (representativeScore > active.representativeScore) {
        active.strongestCandidate = clamp01(candidate.strength) > clamp01(active.representative.strength)
          ? candidate : active.strongestCandidate;
      }
      this.lastCandidateEvaluated = true;
      this.lastCandidateDistanceMs = offset;
      this.lastCandidateClassification = 'duplicate-cluster';
      this.lastCandidateWeight = 0;
      this.lastAnchorAccepted = false;
      this.lastCandidateAccepted = false;
      this.anchorRejectReason = representativeScore > active.representativeScore
        ? 'duplicate-onset-cluster' : 'weaker-cluster-member';
      this.clusterStats.rejectedDuplicateOnsets++;
      this.reason = this.anchorRejectReason;
      return;
    }

    const offset = this._candidateGridOffset(observed);
    this.currentAnchorCluster = {
      startTime: observed,
      endTime: observed,
      candidateCount: 1,
      strongestCandidate: candidate,
      representative: candidate,
      representativeOffsetMs: offset,
      representativeScore: this._representativeScore(offset, candidate, this._candidateMultiBand(candidate)),
      combinedStrength: clamp01(candidate.strength),
    };
    this.clusterStats.clusters++;
    this._alignCandidate(candidate, timestamp, tempo);
    this.currentAnchorCluster.representativeOffsetMs = this.lastCandidateDistanceMs;
    if (this.lastAnchorAccepted) this.clusterStats.acceptedClusterAnchors++;
  }

  _anchorClusterWindowMs() {
    const periodWindow = this.periodMs > 0
      ? this.periodMs * this.config.anchorClusterPeriodFraction
      : this.config.anchorClusterMaximumMs;
    return clamp(periodWindow, this.config.anchorClusterMinimumMs, this.config.anchorClusterMaximumMs);
  }

  _candidateGridOffset(timestamp) {
    if (!(this.periodMs > 0)) return 0;
    const index = Math.round((timestamp - this.epoch) / this.periodMs);
    return timestamp - (this.epoch + index * this.periodMs);
  }

  _candidateMultiBand(candidate) {
    const values = [candidate.lowEndContribution, candidate.broadbandContribution, candidate.spectralContribution]
      .map(clamp01);
    return clamp01(mean(values) * 0.7 + values.filter((value) => value >= 0.2).length / 3 * 0.3);
  }

  _representativeScore(offset, candidate, multiBand) {
    const gridFit = this.periodMs > 0
      ? clamp01(1 - Math.abs(offset) / Math.max(1, this.periodMs * this.config.gridUsableFraction)) : 0.5;
    return clamp01(
      gridFit * 0.55
      + clamp01(candidate.confidence) * 0.20
      + multiBand * 0.15
      + clamp01(candidate.strength) * 0.10,
    );
  }

  _alignCandidate(candidate, timestamp, tempo) {
    const observed = Math.max(0, finite(candidate.timestamp, timestamp));
    const nearestIndex = Math.round((observed - this.epoch) / this.periodMs);
    const predicted = this.epoch + nearestIndex * this.periodMs;
    const error = observed - predicted;
    this.lastCandidateDistanceMs = error;
    this.lastCandidateEvaluated = true;
    this.anchorStats.candidates++;
    const absoluteError = Math.abs(error);
    const classification = this._classifyCandidateDistance(absoluteError);
    this.lastCandidateClassification = classification;
    this.anchorStats[classification === 'very-close' ? 'veryClose' : classification]++;
    if (classification === 'offGrid') {
      this.consistentErrors = [];
      this.anchorRejectReason = 'off-grid';
      this.reason = 'off-grid-candidate-rejected';
      return;
    }
    const confidence = clamp01(candidate.confidence ?? candidate.strength ?? 0);
    const signalWeight = clamp01(
      confidence * 0.34
      + clamp01(candidate.strength) * 0.20
      + clamp01(candidate.lowEndContribution) * 0.14
      + clamp01(candidate.broadbandContribution) * 0.22
      + clamp01(candidate.spectralContribution) * 0.10,
    );
    const distanceWeight = classification === 'very-close' ? 1
      : classification === 'close' ? 0.72 : 0.42;
    const tempoWeight = clamp01(finite(tempo?.confidence) * 0.6 + finite(tempo?.stability) * 0.4);
    const anchorWeight = clamp01(signalWeight * distanceWeight * (0.72 + tempoWeight * 0.28));
    this.lastCandidateWeight = anchorWeight;
    this.audioAnchors.push({ timestamp, weight: anchorWeight, classification });
    this._pruneAudioAnchors(timestamp);
    this.anchorStats.confirmations++;
    this.lastAnchorAccepted = true;
    this.anchorRejectReason = 'accepted-grid-anchor';
    this.anchorOffsetHistory.push(error);
    if (this.anchorOffsetHistory.length > this.config.anchorOffsetHistoryBeats) this.anchorOffsetHistory.shift();
    this.observedSupport = Math.min(24, this.observedSupport + Math.max(0.1, anchorWeight));
    this.missingBeatCount = Math.max(0, this.missingBeatCount - 1);
    if (classification === 'usable') {
      this.reason = 'grid-candidate-confirmed';
      return;
    }

    const strong = confidence >= 0.72 && anchorWeight >= 0.5;
    this.consistentErrors.push(Math.sign(error) || 0);
    if (this.consistentErrors.length > this.config.gridConsistentCorrectionCount) this.consistentErrors.shift();
    const directionConsistent = this.consistentErrors.length >= this.config.gridConsistentCorrectionCount
      && this.consistentErrors.every((sign) => sign === this.consistentErrors[0]);
    const baseGain = classification === 'very-close'
      ? this.config.gridCorrectionGain : this.config.gridCorrectionGain * 0.72;
    const gain = strong && directionConsistent
      ? this.config.gridStrongCorrectionGain : baseGain;
    const correction = clamp(error * gain * Math.max(0.25, anchorWeight),
      -this.config.gridMaxCorrectionMs, this.config.gridMaxCorrectionMs);
    this.epoch += correction;
    this.lastCorrectionMs = correction;
    this.lastCandidateAccepted = true;
    this.anchorStats.corrections++;
    this.reason = directionConsistent ? 'consistent-grid-correction' : 'bounded-grid-correction';
  }

  _anchorOffsetConsistency() {
    if (this.anchorOffsetHistory.length < 2 || !(this.periodMs > 0)) return 0;
    const average = mean(this.anchorOffsetHistory);
    const deviation = mean(this.anchorOffsetHistory.map((value) => Math.abs(value - average)));
    return clamp01(1 - deviation / Math.max(8, this.periodMs * 0.10));
  }

  _classifyCandidateDistance(absoluteError) {
    if (absoluteError <= Math.max(18, this.periodMs * this.config.gridVeryCloseFraction)) return 'very-close';
    if (absoluteError <= Math.max(35, this.periodMs * this.config.gridCloseFraction)) return 'close';
    if (absoluteError <= Math.max(65, this.periodMs * this.config.gridUsableFraction)) return 'usable';
    return 'offGrid';
  }

  _pruneAudioAnchors(timestamp) {
    const cutoff = timestamp - this.config.gridAudioAnchorWindowMs;
    while (this.audioAnchors.length && this.audioAnchors[0].timestamp < cutoff) this.audioAnchors.shift();
  }

  _audioAnchorRate() {
    if (!this.anchorStats.candidates) return 0;
    return clamp01((this.anchorStats.veryClose + this.anchorStats.close + this.anchorStats.usable)
      / this.anchorStats.candidates);
  }

  _emitCrossedBeat(timestamp, candidate) {
    const currentIndex = Math.floor((timestamp - this.epoch) / this.periodMs);
    if (currentIndex <= this.lastEmittedIndex) return;
    const emittedIndex = currentIndex;
    const predictedTimestamp = this.epoch + emittedIndex * this.periodMs;
    const observed = this.lastCandidateAccepted && candidate
      && Math.round((finite(candidate.timestamp) - this.epoch) / this.periodMs) === emittedIndex;
    this.lastEmittedIndex = emittedIndex;
    this.lastBeatTime = predictedTimestamp;
    if (observed) {
      this.predictedSupport = Math.max(0, this.predictedSupport - 0.25);
    } else {
      this.predictedSupport = Math.min(24, this.predictedSupport + 1);
      this.missingBeatCount++;
    }
    this.lastEvent = Object.freeze({
      timestamp: predictedTimestamp,
      predictedTimestamp,
      observedCandidateTimestamp: observed ? finite(candidate.timestamp) : null,
      source: observed ? 'observed-corrected' : 'predicted',
      strength: observed ? clamp01(candidate.strength) : 0,
      confidence: clamp01(this.gridConfidence * (observed ? 1 : 0.82)),
      bpm: this.bpm,
      phaseErrorMs: observed ? finite(candidate.timestamp) - predictedTimestamp : 0,
      beatIndex: emittedIndex,
    });
  }

  _updateConfidence(tempo, candidate, timestamp) {
    this._pruneAudioAnchors(timestamp);
    const recentAnchorWeight = clamp01(
      this.audioAnchors.reduce((sum, anchor) => sum + anchor.weight, 0) / 4,
    );
    const lastAnchor = this.audioAnchors.at(-1);
    const anchorRecency = lastAnchor
      ? clamp01(1 - (timestamp - lastAnchor.timestamp) / this.config.gridAudioAnchorWindowMs) : 0;
    const target = clamp01(finite(tempo.confidence) * 0.62
      + finite(tempo.stability) * 0.18
      + recentAnchorWeight * 0.20);
    this.gridConfidence = clamp01(this.gridConfidence * 0.86 + target * 0.14);
    const stabilityTarget = clamp01(
      finite(tempo.stability) * 0.4
      + recentAnchorWeight * 0.35
      + this._audioAnchorRate() * anchorRecency * 0.25,
    );
    this.gridStability = clamp01(this.gridStability * 0.9 + stabilityTarget * 0.1);
    if (tempo.state === 'locked') this.state = 'locked';
  }
}
