import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const clamp01 = (value) => clamp(value, 0, 1);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const standardDeviation = (values, average = mean(values)) => values.length
  ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length)
  : 0;
const weightedMedian = (entries) => {
  if (!entries.length) return 0;
  const sorted = [...entries].sort((a, b) => a.bpm - b.bpm);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= total * 0.5) return entry.bpm;
  }
  return sorted.at(-1).bpm;
};
const relationBetween = (candidate, reference) => {
  if (!(candidate > 0) || !(reference > 0)) return 'none';
  const ratio = candidate / reference;
  if (Math.abs(ratio - 1) <= 0.035) return '1x';
  if (Math.abs(ratio - 0.5) <= 0.04) return '0.5x';
  if (Math.abs(ratio - 2) <= 0.08) return '2x';
  return 'none';
};
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const NOVELTY_KEYS = Object.freeze([
  'lowEndNovelty', 'broadbandNovelty', 'spectralNovelty', 'highFrequencyNovelty',
]);

/**
 * Scores tempo hypotheses from continuous novelty. Discrete BeatCandidates are
 * optional alignment evidence and are never required to produce a tempo.
 */
export class ContinuousTempoEstimator {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this.reset();
  }

  reset(timestamp = 0, reason = 'manual-reset') {
    this.history = [];
    this.candidateTimes = [];
    this.selectedBpm = 0;
    this.selectedCandidate = null;
    this.state = 'searching';
    this.confidence = 0;
    this.stability = 0;
    this.lockedAt = 0;
    this.firstSelectionAt = 0;
    this.lastAnalysisAt = -Infinity;
    this.lastSupportAt = 0;
    this.lastTempoChangeAt = Math.max(0, finite(timestamp));
    this.lastTempoChangeReason = reason;
    this.lastTempoChange = null;
    this.pendingSwitch = null;
    this.topCandidates = [];
    this.prior = null;
    this.reason = reason;
    this.rhythmContextResetReason = reason;
    this.silenceStartedAt = 0;
    this.harmonicDiagnostics = this._emptyHarmonicDiagnostics();
    this.tempoEvidence = [];
    this.tempoCenterBpm = 0;
    this.lastTempoRefinementAt = Math.max(0, finite(timestamp));
    this.lastTempoMaturityLabel = 'immature';
    this.lastAnyAnchorAt = 0;
    this.lastStrongAnchorAt = 0;
    this.recentAnchorEvents = [];
    this.recentGridSupport = 0;
    this.recentTempoAgreement = 0;
    this.lockFreshness = 0;
    this.staleLockScore = 0;
    this.rhythmicContinuity = 0;
    this.transitionState = 'transition-search';
    this.staleStartedAt = 0;
    this.transitionStartedAt = Math.max(0, finite(timestamp));
    this.reacquireStartedAt = 0;
    this.lastReacquireDurationMs = 0;
    this.transitionOldTempo = 0;
    this.transitionCandidateTempo = 0;
    this.stableAudioSignature = null;
    this.audioContinuity = 0;
    this.signalPresent = false;
    this.hasAudioContext = false;
    this.baselineGridSupport = 0;
    this.baselineTempoAgreement = 0;
    this.lowContinuityStartedAt = 0;
    this.fullTimeSupportHistory = 0;
    this.halfTimeTakeoverEvidence = 0;
    this.halfTimeTakeoverArmed = false;
    this.halfTimeTakeoverStartedAt = 0;
    this.halfTimeTakeoverCandidateBpm = 0;
    this.halfTimeTakeoverReason = 'no-established-full-time-lock';
    this.lastHarmonicSupportAt = Math.max(0, finite(timestamp));
    this.acquisitionConfidence = 0;
    this.acquisitionMaturity = 0;
    this.lockQuality = 0;
    this.periodicityConfidence = 0;
    this.acquisitionAnchorSupport = 0;
    this.acquisitionEvidenceAgeMs = 0;
    this.acquisitionReason = 'insufficient-history';
    return this.getSnapshot(timestamp);
  }

  setPrior(bpm = 0, confidence = 0) {
    const value = finite(bpm);
    this.prior = value >= this.config.minBpm && value <= this.config.maxBpm
      ? { bpm: value, confidence: clamp01(confidence) }
      : null;
  }

  update(novelty = {}, timestamp = novelty.timestamp || 0, {
    signalState = 'signal', candidate = null, audioSnapshot = null,
  } = {}) {
    const now = Math.max(0, finite(timestamp));
    this._appendNovelty(novelty, now);
    if (candidate?.timestamp !== undefined) {
      this.candidateTimes.push(Math.max(0, finite(candidate.timestamp)));
    }
    this._observeAudioContext(audioSnapshot, signalState, now);
    this._observeAnchorCandidate(candidate, now);
    this._prune(now);

    const silent = ['silence', 'no-source', 'stale', 'ended', 'error'].includes(signalState);
    if (silent) {
      if (!this.silenceStartedAt) this.silenceStartedAt = now;
      const beatAwareHoldMs = this.selectedBpm
        ? Math.min(2_000, Math.max(this.config.silenceHoldMs, (60_000 / this.selectedBpm) * 2.5))
        : this.config.silenceHoldMs;
      if (now - this.silenceStartedAt < beatAwareHoldMs) return this.getSnapshot(now);
      this.pendingSwitch = null;
      if (this.selectedBpm) {
        const silenceAge = this.lastSupportAt ? now - this.lastSupportAt : Infinity;
        this.state = silenceAge >= this.config.lostAfterMs ? 'lost' : 'hold';
        this.confidence *= Math.exp(-Math.min(250, Math.max(0, now - Math.max(this.lastAnalysisAt, 0))) / 8_000);
        this.reason = this.state === 'lost' ? 'prolonged-silence' : 'silence-hold';
        if (this.state === 'lost') this.rhythmContextResetReason = 'prolonged-silence';
        this.transitionState = this.state === 'lost' ? 'transition-search' : 'hold';
      }
      this._updateFreshness(now);
      return this.getSnapshot(now);
    }
    this.silenceStartedAt = 0;

    if (now - this.lastAnalysisAt >= this.config.tempoAnalysisIntervalMs) {
      this.lastAnalysisAt = now;
      this._analyze(now);
      this._updateFreshness(now);
      this._applyFreshnessState(now);
    }
    return this.getSnapshot(now);
  }

  getSnapshot(timestamp = 0) {
    const now = Math.max(0, finite(timestamp));
    return deepFreeze({
      state: this.state,
      bpm: this.selectedBpm,
      selectedBpm: this.selectedBpm,
      confidence: clamp01(this.confidence),
      stability: clamp01(this.stability),
      lockAgeMs: this.lockedAt ? Math.max(0, now - this.lockedAt) : 0,
      candidateCount: this.candidateTimes.length,
      topCandidates: this.topCandidates.map((entry) => ({ ...entry })),
      periodicityScore: this.selectedCandidate?.periodicityScore || 0,
      phaseFitScore: this.selectedCandidate?.phaseFitScore || 0,
      multiBandAgreement: this.selectedCandidate?.multiBandAgreement || 0,
      continuityScore: this.selectedCandidate?.continuityScore || 0,
      harmonicScore: this.selectedCandidate?.harmonicScore || 0,
      onGridScore: this.selectedCandidate?.onGridScore || 0,
      offGridScore: this.selectedCandidate?.offGridScore || 0,
      supportDurationMs: this.selectedCandidate?.supportDurationMs || 0,
      phaseAnchorTimestamp: this.selectedCandidate?.phaseAnchorTimestamp || 0,
      supportedGridPositions: this.selectedCandidate?.supportedGridPositions || 0,
      expectedGridPositions: this.selectedCandidate?.expectedGridPositions || 0,
      reason: this.reason,
      lastTempoChangeAt: this.lastTempoChangeAt,
      lastTempoChangeReason: this.lastTempoChangeReason,
      lastTempoChange: this.lastTempoChange ? { ...this.lastTempoChange } : null,
      rhythmContextResetReason: this.rhythmContextResetReason,
      lockMaturity: this._lockMaturity(now),
      lockMaturityLabel: this._lockMaturityLabel(now),
      halfTimeCandidate: this.harmonicDiagnostics.halfTimeCandidate,
      fullTimeCandidate: this.harmonicDiagnostics.fullTimeCandidate,
      fullTimeEvidence: this.harmonicDiagnostics.fullTimeEvidence,
      harmonicScoreDelta: this.harmonicDiagnostics.harmonicScoreDelta,
      harmonicConfidenceDelta: this.harmonicDiagnostics.harmonicConfidenceDelta,
      harmonicRelation: this.harmonicDiagnostics.harmonicRelation,
      baseBpm: this.harmonicDiagnostics.baseBpm,
      doubleBpm: this.harmonicDiagnostics.doubleBpm,
      intermediateBeatSupport: this.harmonicDiagnostics.intermediateBeatSupport,
      intermediateEventQuality: this.harmonicDiagnostics.intermediateEventQuality,
      baseTempoEvidence: this.harmonicDiagnostics.baseTempoEvidence,
      intermediateSupportConsistency: this.harmonicDiagnostics.supportConsistency,
      intermediateMultiBandAgreement: this.harmonicDiagnostics.intermediateMultiBandAgreement,
      intermediateSupportDurationMs: this.harmonicDiagnostics.intermediateSupportDurationMs,
      intermediateOnsetRegularity: this.harmonicDiagnostics.intermediateOnsetRegularity,
      dancePriorContribution: this.harmonicDiagnostics.dancePriorContribution,
      finalHarmonicDecision: this.harmonicDiagnostics.finalHarmonicDecision,
      harmonicRelockPersistenceMs: this.pendingSwitch?.relation === '2x'
        ? Math.max(0, now - this.pendingSwitch.startedAt) : 0,
      fullTimeSupportHistory: this.fullTimeSupportHistory,
      halfTimeTakeoverEvidence: this.halfTimeTakeoverEvidence,
      halfTimeTakeoverReason: this.halfTimeTakeoverReason,
      halfTimeTakeoverPersistenceMs: this.halfTimeTakeoverStartedAt
        ? Math.max(0, now - this.halfTimeTakeoverStartedAt) : 0,
      harmonicLockMaturity: this._lockMaturity(now),
      harmonicAmbiguity: this._harmonicAmbiguity(),
      tempoCenterBpm: this.tempoCenterBpm || this.selectedBpm,
      tempoClusterSpreadBpm: this._tempoClusterSpread(),
      tempoRefinementSlewBpmPerSecond: this.config.tempoRefinementSlewBpmPerSecond,
      lockFreshness: this.lockFreshness,
      lastStrongAnchorAgeMs: this.lastStrongAnchorAt ? Math.max(0, now - this.lastStrongAnchorAt) : null,
      lastAnyAnchorAgeMs: this.lastAnyAnchorAt ? Math.max(0, now - this.lastAnyAnchorAt) : null,
      recentAnchorCount: this.recentAnchorEvents.length,
      recentGridSupport: this.recentGridSupport,
      recentTempoAgreement: this.recentTempoAgreement,
      rhythmicContinuity: this.rhythmicContinuity,
      staleLockScore: this.staleLockScore,
      transitionState: this.transitionState,
      transitionOldTempo: this.transitionOldTempo,
      transitionCandidateTempo: this.transitionCandidateTempo,
      staleDurationMs: this.staleStartedAt ? Math.max(0, now - this.staleStartedAt) : 0,
      reacquireDurationMs: this.reacquireStartedAt
        ? Math.max(0, now - this.reacquireStartedAt) : this.lastReacquireDurationMs,
      acquisitionConfidence: this.acquisitionConfidence,
      acquisitionMaturity: this.acquisitionMaturity,
      lockQuality: this.lockQuality,
      periodicityConfidence: this.periodicityConfidence,
      acquisitionAnchorSupport: this.acquisitionAnchorSupport,
      acquisitionEvidenceAgeMs: this.acquisitionEvidenceAgeMs,
      acquisitionReason: this.acquisitionReason,
    });
  }

  _appendNovelty(novelty, timestamp) {
    if (this.history.length && timestamp <= this.history[this.history.length - 1].timestamp) {
      if (timestamp < this.history[this.history.length - 1].timestamp) return;
      this.history.pop();
    }
    const sample = Object.freeze({
      timestamp,
      lowEndNovelty: clamp01(novelty.lowEndNovelty),
      broadbandNovelty: clamp01(novelty.broadbandNovelty),
      spectralNovelty: clamp01(novelty.spectralNovelty),
      highFrequencyNovelty: clamp01(novelty.highFrequencyNovelty),
      combinedNovelty: clamp01(novelty.combinedNovelty),
    });
    this.history.push(sample);
    if (sample.combinedNovelty >= 0.075) this.lastSupportAt = timestamp;
  }

  _prune(timestamp) {
    const cutoff = timestamp - this.config.noveltyHistoryMs;
    while (this.history.length && this.history[0].timestamp < cutoff) this.history.shift();
    while (this.candidateTimes.length && this.candidateTimes[0] < cutoff) this.candidateTimes.shift();
  }

  _analyze(timestamp) {
    if (this.history.length < 4) return;
    const duration = timestamp - this.history[0].timestamp;
    if (duration < this.config.tempoMinimumHistoryMs) {
      this.state = 'searching';
      this.reason = 'insufficient-continuous-history';
      return;
    }
    const series = this._resample(timestamp);
    if (series.combined.length < 8) return;
    const energy = mean(series.combined);
    const variation = standardDeviation(series.combined, energy);
    if (energy < 0.008 || variation < 0.008) {
      this._handleWeakSupport(timestamp);
      return;
    }

    const preliminary = [];
    for (let bpm = this.config.minBpm; bpm <= this.config.maxBpm + 1e-9; bpm += this.config.tempoBpmStep) {
      preliminary.push(this._scoreBpm(bpm, series, timestamp, true));
    }
    preliminary.sort((a, b) => b.score - a.score || a.bpm - b.bpm);
    const exactBpms = new Set();
    const includeNeighborhood = (bpm) => {
      if (!(bpm >= this.config.minBpm && bpm <= this.config.maxBpm)) return;
      for (let delta = -1; delta <= 1; delta += this.config.tempoBpmStep) {
        const value = Math.round((bpm + delta) / this.config.tempoBpmStep) * this.config.tempoBpmStep;
        if (value >= this.config.minBpm && value <= this.config.maxBpm) exactBpms.add(value);
      }
    };
    preliminary.slice(0, 10).forEach(({ bpm }) => {
      includeNeighborhood(bpm);
      includeNeighborhood(bpm * 0.5);
      includeNeighborhood(bpm * 2);
    });
    includeNeighborhood(this.selectedBpm);
    includeNeighborhood(this.prior?.bpm);
    const scored = [...exactBpms].map((bpm) => this._scoreBpm(bpm, series, timestamp, false));
    this._applyDanceHarmonicResolver(scored, timestamp, series);
    this._updateHarmonicPersistence(timestamp, scored);
    scored.sort((a, b) => Number(Boolean(b.harmonicPromotion)) - Number(Boolean(a.harmonicPromotion))
      || b.score - a.score || b.confidence - a.confidence || a.bpm - b.bpm);
    const best = scored[0];
    this._updateAcquisitionDiagnostics(timestamp, best, series);
    this._select(timestamp, best, scored);
    const reference = this.selectedBpm || best.bpm;
    this.topCandidates = scored.slice(0, 5).map((entry) => ({
      ...entry,
      harmonicRelation: relationBetween(entry.bpm, reference),
    }));
    this.selectedCandidate = this._nearestCandidate(scored, this.selectedBpm) || best;
    const selected = this.selectedCandidate;
    this.recentGridSupport = clamp01(this.recentGridSupport * 0.55 + (
      selected.phaseFitScore * 0.42
      + selected.periodicityScore * 0.28
      + selected.multiBandAgreement * 0.30
    ) * 0.45);
    const currentCandidate = this._nearestCandidate(scored, this.selectedBpm);
    this.recentTempoAgreement = clamp01(this.recentTempoAgreement * 0.55 + (
      currentCandidate
        ? Math.exp(-Math.abs(currentCandidate.bpm - this.selectedBpm) / 3)
          * currentCandidate.confidence
        : 0
    ) * 0.45);
  }

  _observeAudioContext(audioSnapshot, signalState, timestamp) {
    this.signalPresent = !['silence', 'no-source', 'stale', 'ended', 'error'].includes(signalState);
    if (!audioSnapshot || typeof audioSnapshot !== 'object') {
      this.audioContinuity = this.signalPresent ? Math.max(this.audioContinuity * 0.98, 0.65) : 0;
      return;
    }
    this.hasAudioContext = true;
    const feature = (value) => clamp01(value?.smoothed ?? value?.normalized ?? value?.value ?? value);
    const signature = {
      rms: feature(audioSnapshot.level?.rms),
      low: feature(audioSnapshot.lowEnd?.totalEnergy),
      mid: feature(audioSnapshot.bands?.mid),
      high: feature(audioSnapshot.bands?.highMid) * 0.6 + feature(audioSnapshot.bands?.high) * 0.4,
      flux: feature(audioSnapshot.spectrum?.flux),
    };
    if (!this.stableAudioSignature) {
      this.stableAudioSignature = signature;
      this.audioContinuity = this.signalPresent ? 1 : 0;
      return;
    }
    const distance = Math.abs(signature.rms - this.stableAudioSignature.rms) * 0.24
      + Math.abs(signature.low - this.stableAudioSignature.low) * 0.28
      + Math.abs(signature.mid - this.stableAudioSignature.mid) * 0.18
      + Math.abs(signature.high - this.stableAudioSignature.high) * 0.18
      + Math.abs(signature.flux - this.stableAudioSignature.flux) * 0.12;
    const instantaneousContinuity = this.signalPresent ? clamp01(Math.exp(-distance * 5.5)) : 0;
    this.audioContinuity = clamp01(this.audioContinuity * 0.9 + instantaneousContinuity * 0.1);
    if (this.signalPresent && this.audioContinuity < 0.32) {
      if (!this.lowContinuityStartedAt) this.lowContinuityStartedAt = timestamp;
    } else {
      this.lowContinuityStartedAt = 0;
    }
    const strongAnchorFresh = this.lastStrongAnchorAt
      && timestamp - this.lastStrongAnchorAt <= this.config.lockFreshnessGraceMs;
    if (this.state === 'locked' && this.lockFreshness >= 0.48 && strongAnchorFresh) {
      for (const key of Object.keys(signature)) {
        this.stableAudioSignature[key] += (signature[key] - this.stableAudioSignature[key]) * 0.015;
      }
    }
  }

  _observeAnchorCandidate(candidate, timestamp) {
    if (candidate?.timestamp === undefined) return;
    this.lastAnyAnchorAt = timestamp;
    let aligned = !this.selectedBpm;
    if (this.selectedBpm && this.selectedCandidate?.phaseAnchorTimestamp >= 0) {
      const period = 60_000 / this.selectedBpm;
      const anchor = this.selectedCandidate.phaseAnchorTimestamp;
      const cycles = Math.round((finite(candidate.timestamp) - anchor) / period);
      aligned = Math.abs(finite(candidate.timestamp) - (anchor + cycles * period)) <= period * 0.18;
    }
    const multiBand = [candidate.lowEndContribution, candidate.broadbandContribution, candidate.spectralContribution]
      .map(clamp01).filter((value) => value >= 0.16).length / 3;
    const strong = aligned
      && clamp01(candidate.confidence) >= 0.42
      && (multiBand >= 1 / 3 || clamp01(candidate.strength) >= 0.68);
    if (strong) this.lastStrongAnchorAt = timestamp;
    this.recentAnchorEvents.push({ timestamp, strong, aligned });
  }

  _updateFreshness(timestamp) {
    const cutoff = timestamp - this.config.lockFreshnessWindowMs;
    this.recentAnchorEvents = this.recentAnchorEvents.filter((entry) => entry.timestamp >= cutoff);
    const strongAge = this.lastStrongAnchorAt ? timestamp - this.lastStrongAnchorAt : Infinity;
    const anyAge = this.lastAnyAnchorAt ? timestamp - this.lastAnyAnchorAt : Infinity;
    const strongRecency = clamp01(1 - strongAge / this.config.lockFreshnessWindowMs);
    const anyRecency = clamp01(1 - anyAge / this.config.lockFreshnessWindowMs);
    this.lockFreshness = clamp01(
      strongRecency * 0.32
      + anyRecency * 0.08
      + this.recentGridSupport * 0.28
      + this.recentTempoAgreement * 0.20
      + this.audioContinuity * 0.12,
    );
    this.rhythmicContinuity = clamp01(
      this.recentGridSupport * 0.25
      + this.recentTempoAgreement * 0.20
      + strongRecency * 0.20
      + this.audioContinuity * 0.25
      + (this.signalPresent ? 0.10 : 0),
    );
    this.staleLockScore = clamp01(1 - this.lockFreshness);
    if (this.state === 'locked' && this.transitionState === 'stable') {
      const alpha = this.baselineGridSupport ? 0.015 : 1;
      this.baselineGridSupport += (this.recentGridSupport - this.baselineGridSupport) * alpha;
      this.baselineTempoAgreement += (this.recentTempoAgreement - this.baselineTempoAgreement) * alpha;
    }
  }

  _applyFreshnessState(timestamp) {
    if (!this.selectedBpm) {
      this.transitionState = this.transitionState === 'reacquiring' ? 'reacquiring' : 'transition-search';
      return;
    }
    const strongAge = this.lastStrongAnchorAt ? timestamp - this.lastStrongAnchorAt : Infinity;
    const selectionAge = this.firstSelectionAt ? timestamp - this.firstSelectionAt : 0;
    const periodicEvidenceCollapsed = this.baselineGridSupport > 0.12
      && this.baselineTempoAgreement > 0.12
      && this.recentGridSupport < this.baselineGridSupport * 0.52
      && this.recentTempoAgreement < this.baselineTempoAgreement * 0.52;
    const contextDiscontinuity = strongAge >= this.config.staleLockReleaseMinimumMs
      && this.lowContinuityStartedAt > 0
      && timestamp - this.lowContinuityStartedAt >= 2_500
      && (this.recentGridSupport < this.baselineGridSupport * 0.95
        || this.recentTempoAgreement < this.baselineTempoAgreement * 0.95);
    const stale = this.hasAudioContext
      && selectionAge >= this.config.staleLockReleaseMinimumMs
      && strongAge >= this.config.lockFreshnessGraceMs
      && ((this.staleLockScore >= this.config.staleLockThreshold && periodicEvidenceCollapsed)
        || contextDiscontinuity);
    if (!stale) {
      this.staleStartedAt = 0;
      if (this.transitionState === 'reacquiring') {
        if (this.state === 'locked' && timestamp - this.reacquireStartedAt >= this.config.reacquireConfirmationMs) {
          this.lastReacquireDurationMs = timestamp - this.reacquireStartedAt;
          this.reacquireStartedAt = 0;
          this.transitionState = 'stable';
        }
      } else if (this.state === 'locked') {
        this.transitionState = 'stable';
      }
      return;
    }
    if (!this.staleStartedAt) this.staleStartedAt = timestamp;
    const continuousBreakdown = this.rhythmicContinuity >= this.config.rhythmicContinuityHoldThreshold
      && this.audioContinuity >= 0.42;
    this.transitionState = continuousBreakdown ? 'hold' : 'stale';
    this.confidence = clamp01(this.confidence * (continuousBreakdown ? 0.975 : 0.94));
    this.stability = clamp01(this.stability * (continuousBreakdown ? 0.985 : 0.95));
    this.state = continuousBreakdown ? 'hold' : 'unstable';
    this.reason = continuousBreakdown ? 'breakdown-continuity-hold' : 'stale-lock-decay';
    const continuitySpan = this.config.staleLockReleaseMaximumMs - this.config.staleLockReleaseMinimumMs;
    const releaseAfter = this.config.staleLockReleaseMinimumMs
      + clamp01(this.rhythmicContinuity) * continuitySpan;
    if (!continuousBreakdown && timestamp - this.staleStartedAt >= releaseAfter) {
      this._releaseStaleTempo(timestamp);
    }
  }

  _releaseStaleTempo(timestamp) {
    const oldBpm = this.selectedBpm;
    this.transitionOldTempo = oldBpm;
    this.transitionCandidateTempo = this.topCandidates[0]?.bpm || 0;
    this.transitionState = 'transition-search';
    this.transitionStartedAt = timestamp;
    this.selectedBpm = 0;
    this.selectedCandidate = null;
    this.firstSelectionAt = 0;
    this.lockedAt = 0;
    this.pendingSwitch = null;
    this.tempoEvidence = [];
    this.tempoCenterBpm = 0;
    this.baselineGridSupport = 0;
    this.baselineTempoAgreement = 0;
    this.confidence = 0;
    this.stability = 0;
    this.state = 'searching';
    this.reason = 'stale-tempo-released';
    this.lastTempoChangeAt = timestamp;
    this.lastTempoChangeReason = 'stale-tempo-released';
    this.lastTempoChange = Object.freeze({
      oldBpm, newBpm: 0, reason: 'stale-tempo-released', scoreDelta: 0,
      persistenceMs: Math.max(0, timestamp - this.staleStartedAt),
    });
    this.rhythmContextResetReason = 'phase-lock-lost';
    this.staleStartedAt = 0;
    this.acquisitionConfidence = 0;
    this.acquisitionMaturity = 0;
    this.lockQuality = 0;
    this.periodicityConfidence = 0;
    this.acquisitionAnchorSupport = 0;
    this.acquisitionEvidenceAgeMs = 0;
    this.acquisitionReason = 'stale-tempo-released';
  }

  _resample(timestamp) {
    // Active scoring uses the short evidence window so a persistent new rhythm
    // can replace stale history. Lock age and switch hysteresis retain the
    // longer-term stability signal independently.
    const start = Math.max(this.history[0].timestamp, timestamp - this.config.tempoShortWindowMs);
    const step = this.config.tempoSampleIntervalMs;
    const times = [];
    const result = { combined: [], bands: NOVELTY_KEYS.map(() => []) };
    let sourceIndex = 0;
    while (sourceIndex + 1 < this.history.length && this.history[sourceIndex + 1].timestamp < start) sourceIndex++;
    for (let time = start; time <= timestamp + 1e-6; time += step) {
      while (sourceIndex + 1 < this.history.length
        && Math.abs(this.history[sourceIndex + 1].timestamp - time)
          <= Math.abs(this.history[sourceIndex].timestamp - time)) sourceIndex++;
      const sample = this.history[sourceIndex];
      times.push(time);
      result.combined.push(sample.combinedNovelty);
      NOVELTY_KEYS.forEach((key, index) => result.bands[index].push(sample[key]));
    }
    return { ...result, times, start, step, duration: timestamp - start };
  }

  _scoreBpm(bpm, series, timestamp, periodicityOnly = false) {
    const periodMs = 60_000 / bpm;
    const lag = periodMs / series.step;
    const combinedMean = mean(series.combined);
    const combinedDeviation = standardDeviation(series.combined, combinedMean);
    let cross = 0;
    let energyA = 0;
    let energyB = 0;
    let correlationCount = 0;
    for (let index = Math.ceil(lag); index < series.combined.length; index++) {
      const delayed = this._interpolate(series.combined, index - lag);
      const a = series.combined[index] - combinedMean;
      const b = delayed - combinedMean;
      cross += a * b;
      energyA += a * a;
      energyB += b * b;
      correlationCount++;
    }
    const correlation = correlationCount && energyA > 0 && energyB > 0
      ? cross / Math.sqrt(energyA * energyB) : 0;
    const periodicityScore = clamp01(Math.max(0, correlation) * 0.9
      + Math.max(0, correlation - 0.25) * 0.2);

    let bestPhase = null;
    if (!periodicityOnly) {
      const phaseStep = Math.max(series.step, periodMs / 20);
      for (let offset = 0; offset < periodMs; offset += phaseStep) {
        const phase = this._scorePhase(offset, periodMs, series, combinedMean, combinedDeviation);
        if (!bestPhase || phase.phaseFitScore > bestPhase.phaseFitScore + 0.01
          || (Math.abs(phase.phaseFitScore - bestPhase.phaseFitScore) <= 0.01
            && phase.onGridScore > bestPhase.onGridScore)) {
          bestPhase = phase;
        }
      }
    }
    bestPhase ||= {
      phaseFitScore: 0, onGridScore: 0, offGridScore: 0,
      multiBandAgreement: 0, supportedGridPositions: 0, expectedGridPositions: 0,
      phaseOffsetMs: 0,
    };

    const supportRatio = bestPhase.expectedGridPositions
      ? bestPhase.supportedGridPositions / bestPhase.expectedGridPositions : 0;
    const durationScore = clamp01(series.duration / this.config.tempoShortWindowMs);
    const continuityScore = this.selectedBpm
      ? Math.max(
        Math.exp(-Math.abs(bpm - this.selectedBpm) / 7),
        relationBetween(bpm, this.selectedBpm) !== 'none' ? 0.72 : 0,
      ) : 0.5;
    const candidateAlignment = this._candidateAlignment(bpm, series.start + bestPhase.phaseOffsetMs, timestamp);
    const dancePrior = bpm >= this.config.dancePriorStartBpm && bpm <= this.config.dancePriorEndBpm
      ? this.config.dancePriorWeight : 0;
    const priorScore = this.prior ? Math.exp(-Math.abs(bpm - this.prior.bpm) / 2.5) * this.prior.confidence * 0.08 : 0;
    const harmonicScore = clamp01(dancePrior + priorScore + candidateAlignment * 0.05);
    const confidence = periodicityOnly ? clamp01(periodicityScore * 0.85 + durationScore * 0.15) : clamp01(
      periodicityScore * 0.29
      + bestPhase.phaseFitScore * 0.35
      + bestPhase.multiBandAgreement * 0.18
      + supportRatio * 0.10
      + durationScore * 0.08,
    );
    const score = periodicityOnly ? clamp01(confidence * 0.9 + dancePrior) : clamp01(
      confidence * 0.82
      + continuityScore * 0.07
      + harmonicScore
      + supportRatio * 0.055,
    );
    const latestIndex = Math.floor((timestamp - (series.start + bestPhase.phaseOffsetMs)) / periodMs);
    const phaseAnchorTimestamp = series.start + bestPhase.phaseOffsetMs + Math.max(0, latestIndex) * periodMs;
    return {
      bpm,
      score,
      periodicityScore,
      phaseFitScore: bestPhase.phaseFitScore,
      multiBandAgreement: bestPhase.multiBandAgreement,
      continuityScore,
      harmonicScore,
      confidence,
      supportDurationMs: series.duration,
      supportCount: bestPhase.supportedGridPositions,
      supportedGridPositions: bestPhase.supportedGridPositions,
      expectedGridPositions: bestPhase.expectedGridPositions,
      phaseOffsetMs: bestPhase.phaseOffsetMs,
      phaseAnchorTimestamp,
      onGridScore: bestPhase.onGridScore,
      offGridScore: bestPhase.offGridScore,
      candidateAlignment,
      dancePriorContribution: dancePrior,
      harmonicRelation: 'none',
    };
  }

  _scorePhase(offsetMs, periodMs, series, overallMean, overallDeviation) {
    const startTime = series.start + offsetMs;
    const combinedOn = [];
    const combinedNear = [];
    const combinedOff = [];
    const bandOn = NOVELTY_KEYS.map(() => []);
    const bandOff = NOVELTY_KEYS.map(() => []);
    const threshold = overallMean + Math.max(0.025, overallDeviation * 0.16);
    for (let gridTime = startTime; gridTime <= series.times[series.times.length - 1] + 1e-6; gridTime += periodMs) {
      const index = (gridTime - series.start) / series.step;
      const center = this._interpolate(series.combined, index);
      const before = this._interpolate(series.combined, index - 1);
      const after = this._interpolate(series.combined, index + 1);
      combinedOn.push(Math.max(center, before * 0.72, after * 0.72));
      combinedNear.push((before + center + after) / 3);
      combinedOff.push(this._interpolate(series.combined, index + periodMs / (2 * series.step)));
      NOVELTY_KEYS.forEach((key, bandIndex) => {
        bandOn[bandIndex].push(this._interpolate(series.bands[bandIndex], index));
        bandOff[bandIndex].push(this._interpolate(
          series.bands[bandIndex], index + periodMs / (2 * series.step),
        ));
      });
    }
    if (combinedOn.length < 3) return {
      phaseFitScore: 0, onGridScore: 0, offGridScore: 0,
      multiBandAgreement: 0, supportedGridPositions: 0,
      expectedGridPositions: combinedOn.length, phaseOffsetMs: offsetMs,
    };
    const onGridScore = mean(combinedOn);
    const nearGridScore = mean(combinedNear);
    const offGridScore = mean(combinedOff);
    const contrast = clamp01((onGridScore - offGridScore + 0.025) / (overallDeviation * 1.5 + 0.08));
    const supportCount = combinedOn.filter((value) => value >= threshold).length;
    const supportRatio = supportCount / combinedOn.length;
    const energyFit = clamp01(onGridScore / (overallMean + overallDeviation + 0.06));
    const phaseFitScore = clamp01(contrast * 0.48 + supportRatio * 0.34 + energyFit * 0.12
      + clamp01(nearGridScore / (onGridScore + 0.08)) * 0.06);
    const bandScores = bandOn.map((values, index) => {
      const on = mean(values);
      const off = mean(bandOff[index]);
      const base = mean(series.bands[index]);
      const deviation = standardDeviation(series.bands[index], base);
      return clamp01((on - off + 0.02) / (deviation * 1.8 + 0.08));
    });
    const activeBands = bandScores.filter((value) => value >= 0.25).length / bandScores.length;
    const multiBandAgreement = clamp01(mean(bandScores) * 0.72 + activeBands * 0.28);
    return {
      phaseFitScore,
      onGridScore,
      offGridScore,
      multiBandAgreement,
      supportedGridPositions: supportCount,
      expectedGridPositions: combinedOn.length,
      phaseOffsetMs: offsetMs,
    };
  }

  _candidateAlignment(bpm, anchor, timestamp) {
    if (!this.candidateTimes.length) return 0;
    const period = 60_000 / bpm;
    const cutoff = timestamp - this.config.noveltyShortHistoryMs;
    const recent = this.candidateTimes.filter((time) => time >= cutoff);
    if (!recent.length) return 0;
    const aligned = recent.filter((time) => {
      const cycles = Math.round((time - anchor) / period);
      return Math.abs(time - (anchor + cycles * period)) <= period * 0.18;
    }).length;
    return aligned / recent.length;
  }

  _applyDanceHarmonicResolver(candidates, timestamp, series) {
    this.harmonicDiagnostics = this._emptyHarmonicDiagnostics();
    const selectedLowTarget = this.selectedBpm
      ? (this.selectedBpm < this.config.dancePriorStartBpm
        ? this.selectedBpm : this.selectedBpm * 0.5)
      : 0;
    const selectedLow = selectedLowTarget
      ? this._nearestCandidate(candidates, selectedLowTarget) : null;
    let diagnosticDistance = Infinity;
    for (const low of candidates) {
      if (low.bpm < 62 || low.bpm > this.config.lowTempoProtectionMaxBpm) continue;
      const doubled = this._nearestCandidate(candidates, low.bpm * 2);
      const doubledTarget = low.bpm * 2;
      const pairTolerance = Math.max(2, doubledTarget * 0.02);
      if (!doubled || doubled.bpm > this.config.dancePriorEndBpm
        || Math.abs(doubled.bpm - doubledTarget) > pairTolerance) continue;
      const intermediate = this._intermediateBeatSupport(low, doubled, series);
      const supportRatio = low.expectedGridPositions
        ? low.supportedGridPositions / low.expectedGridPositions : 0;
      const baseTempoEvidence = clamp01(
        low.periodicityScore * 0.24
        + low.phaseFitScore * 0.27
        + low.multiBandAgreement * 0.18
        + supportRatio * 0.14
        + low.candidateAlignment * 0.07
        + clamp01(low.supportDurationMs / this.config.tempoShortWindowMs) * 0.10
      );
      const structuredIntermediate = clamp01(
        intermediate.value * 0.46
        + intermediate.eventQuality * 0.54
      );
      // Preserve the established 64/67 -> 128/134 sparse-dance acquisition path.
      // From 69 BPM upward, base-vs-double is decided by structured evidence.
      const lowTempoPair = low.bpm >= 69.5
        && baseTempoEvidence >= this.config.lowTempoBaseEvidenceMinimum;
      const fullTimeSupported = doubled.phaseFitScore >= low.phaseFitScore - 0.075
        && doubled.periodicityScore >= low.periodicityScore - 0.10
        && doubled.multiBandAgreement >= low.multiBandAgreement - 0.12
        && doubled.supportedGridPositions >= Math.max(3, low.supportedGridPositions * 1.35)
        && (!lowTempoPair || (structuredIntermediate >= this.config.intermediateSupportMinimum
          && intermediate.eventQuality >= this.config.intermediateEventQualityMinimum));
      const legacyEvidence = this._fullTimeEvidence(low, doubled);
      // A sparse full-time dance grid may expose only every second quarter-note.
      // Restrict this prior to the common 64/75 -> 128/150 ambiguity so clean
      // 60 and 90 BPM material is not automatically doubled.
      const sparseDanceGridSupported = low.bpm <= 80
        && doubled.confidence >= 0.42
        && doubled.phaseFitScore >= low.phaseFitScore - 0.50
        && doubled.multiBandAgreement >= low.multiBandAgreement - 0.60
        && doubled.supportedGridPositions >= Math.max(3, low.supportedGridPositions * 0.45)
        && (low.bpm < 68.5 || intermediate.eventQuality >= 0.45);
      const evidence = lowTempoPair
        ? clamp01(structuredIntermediate * 0.74 + legacyEvidence * 0.26)
        : legacyEvidence;
      const distance = selectedLow ? Math.abs(low.bpm - selectedLow.bpm) : -low.score;
      if (distance < diagnosticDistance) {
        diagnosticDistance = distance;
        this.harmonicDiagnostics = {
          halfTimeCandidate: {
            bpm: low.bpm, score: low.score, confidence: low.confidence,
            phaseFitScore: low.phaseFitScore, periodicityScore: low.periodicityScore,
            multiBandAgreement: low.multiBandAgreement,
            supportedGridPositions: low.supportedGridPositions,
          },
          fullTimeCandidate: {
            bpm: doubled.bpm, score: doubled.score, confidence: doubled.confidence,
            phaseFitScore: doubled.phaseFitScore, periodicityScore: doubled.periodicityScore,
            multiBandAgreement: doubled.multiBandAgreement,
            supportedGridPositions: doubled.supportedGridPositions,
          },
          fullTimeEvidence: evidence,
          harmonicScoreDelta: doubled.score - low.score,
          harmonicConfidenceDelta: doubled.confidence - low.confidence,
          harmonicRelation: '2x',
          baseBpm: low.bpm,
          doubleBpm: doubled.bpm,
          intermediateBeatSupport: intermediate.value,
          intermediateEventQuality: intermediate.eventQuality,
          baseTempoEvidence,
          supportConsistency: intermediate.consistency,
          intermediateMultiBandAgreement: intermediate.multiBandAgreement,
          intermediateSupportDurationMs: intermediate.supportDurationMs,
          intermediateOnsetRegularity: intermediate.onsetRegularity,
          dancePriorContribution: doubled.dancePriorContribution || 0,
          finalHarmonicDecision: 'unresolved',
        };
      }
      const earlyFullTimeCorrection = low.bpm >= 62 && low.bpm <= 88
        && this.selectedBpm > 0
        && this.selectedBpm < this.config.dancePriorStartBpm
        && Math.abs(low.bpm - this.selectedBpm) <= Math.max(3, this.selectedBpm * 0.04)
        && doubled.supportDurationMs >= this.config.harmonicEvidenceMinimumMs
        && evidence >= this.config.fullTimeEvidenceThreshold
        && doubled.confidence - low.confidence >= this.config.harmonicEarlyConfidenceDelta
        && this._lockMaturityLabel(timestamp) === 'immature';
      if (fullTimeSupported || sparseDanceGridSupported) {
        const boost = sparseDanceGridSupported ? 0.16 : 0.075;
        doubled.score = clamp01(doubled.score + boost);
        if (sparseDanceGridSupported) doubled.score = clamp01(Math.max(doubled.score, low.score + 0.03));
        doubled.harmonicScore = clamp01(doubled.harmonicScore + boost);
        low.score = clamp01(low.score - 0.02);
        if (distance <= diagnosticDistance) {
          this.harmonicDiagnostics.finalHarmonicDecision = sparseDanceGridSupported
            ? 'sparse-dance-full-time' : 'intermediate-supported-full-time';
        }
      } else if (lowTempoPair && (structuredIntermediate < this.config.intermediateSupportMinimum
        || intermediate.eventQuality < this.config.intermediateEventQualityMinimum)) {
        const protection = clamp01(
          (this.config.intermediateSupportMinimum - structuredIntermediate)
          / this.config.intermediateSupportMinimum,
        );
        doubled.score = clamp01(doubled.score - (0.08 + protection * 0.08));
        doubled.harmonicScore = clamp01(doubled.harmonicScore - protection * 0.06);
        low.score = clamp01(low.score + 0.035 + protection * 0.035);
        low.lowTempoProtection = true;
        if (distance <= diagnosticDistance) this.harmonicDiagnostics.finalHarmonicDecision = 'protected-low-tempo';
      }
      if (earlyFullTimeCorrection) {
        doubled.harmonicPromotion = true;
        doubled.score = clamp01(Math.max(doubled.score, low.score + 0.035));
        doubled.harmonicScore = clamp01(doubled.harmonicScore + evidence * 0.22);
        low.score = clamp01(low.score - 0.015);
      }
    }
    const takeoverBase = this._nearestCandidate(candidates, this.harmonicDiagnostics.baseBpm);
    const takeoverFull = this._nearestCandidate(candidates, this.harmonicDiagnostics.doubleBpm);
    const takeoverMatchesCurrent = takeoverBase && takeoverFull && this.selectedBpm >= 120
      && relationBetween(takeoverBase.bpm, this.selectedBpm) === '0.5x'
      && relationBetween(takeoverFull.bpm, this.selectedBpm) === '1x';
    if (takeoverMatchesCurrent
      && this.halfTimeTakeoverArmed
      && this.harmonicDiagnostics.finalHarmonicDecision === 'protected-low-tempo') {
      takeoverBase.harmonicPromotion = true;
      takeoverBase.score = clamp01(Math.max(takeoverBase.score, takeoverFull.score + 0.045));
      takeoverFull.score = clamp01(takeoverFull.score - 0.025);
      this.harmonicDiagnostics.finalHarmonicDecision = 'persistent-half-time-takeover';
    }
  }

  _intermediateBeatSupport(low, doubled, series) {
    if (!series?.combined?.length || !(low?.bpm > 0) || !(doubled?.bpm > 0)) {
      return {
        value: 0, supportRatio: 0, consistency: 0, multiBandAgreement: 0,
        supportDurationMs: 0, onsetRegularity: 0, eventQuality: 0,
      };
    }
    const basePeriod = 60_000 / low.bpm;
    let baseTime = finite(low.phaseAnchorTimestamp, series.start);
    while (baseTime - basePeriod >= series.start) baseTime -= basePeriod;
    while (baseTime < series.start) baseTime += basePeriod;
    const overallMean = mean(series.combined);
    const overallDeviation = standardDeviation(series.combined, overallMean);
    const threshold = overallMean + Math.max(0.03, overallDeviation * 0.28);
    const values = [];
    const bandSupport = [];
    const bandQualities = [];
    const supportTimes = [];
    for (let time = baseTime + basePeriod * 0.5;
      time <= series.times.at(-1) + 1e-6; time += basePeriod) {
      const index = (time - series.start) / series.step;
      const value = Math.max(
        this._interpolate(series.combined, index),
        this._interpolate(series.combined, index - 1) * 0.8,
        this._interpolate(series.combined, index + 1) * 0.8,
      );
      values.push(value);
      const positionBandQuality = series.bands.map((band) => {
        const average = mean(band);
        const deviation = standardDeviation(band, average);
        const sampled = Math.max(
          this._interpolate(band, index),
          this._interpolate(band, index - 1) * 0.78,
          this._interpolate(band, index + 1) * 0.78,
        );
        return clamp01((sampled - average + 0.015) / (deviation * 1.7 + 0.075));
      });
      const activeBands = positionBandQuality.filter((quality) => quality >= 0.28).length
        / series.bands.length;
      bandSupport.push(activeBands);
      bandQualities.push(mean(positionBandQuality));
      if (value >= threshold) supportTimes.push(time);
    }
    if (values.length < 3) {
      return {
        value: 0, supportRatio: 0, consistency: 0, multiBandAgreement: 0,
        supportDurationMs: 0, onsetRegularity: 0, eventQuality: 0,
      };
    }
    const supportFlags = values.map((value) => value >= threshold ? 1 : 0);
    const supportRatio = mean(supportFlags);
    const longestRun = supportFlags.reduce((state, supported) => {
      const current = supported ? state.current + 1 : 0;
      return { current, maximum: Math.max(state.maximum, current) };
    }, { current: 0, maximum: 0 }).maximum;
    const consistency = clamp01(supportRatio * 0.65 + longestRun / values.length * 0.35);
    const supportedValues = values.filter((value) => value >= threshold);
    const supportedMean = mean(supportedValues);
    const onsetRegularity = supportedValues.length >= 3
      ? clamp01(1 - standardDeviation(supportedValues, supportedMean) / Math.max(0.08, supportedMean))
      : 0;
    const multiBandAgreement = clamp01(mean(bandSupport));
    const supportDurationMs = supportTimes.length >= 2
      ? supportTimes.at(-1) - supportTimes[0] : 0;
    const durationScore = clamp01(supportDurationMs / Math.max(1, series.duration * 0.7));
    const value = clamp01(
      supportRatio * 0.42
      + consistency * 0.20
      + multiBandAgreement * 0.20
      + onsetRegularity * 0.10
      + durationScore * 0.08,
    );
    const qualityStability = bandQualities.length >= 3
      ? clamp01(1 - standardDeviation(bandQualities, mean(bandQualities)) / 0.45) : 0;
    const eventQuality = clamp01(
      consistency * 0.27
      + multiBandAgreement * 0.22
      + onsetRegularity * 0.14
      + supportRatio * 0.17
      + durationScore * 0.10
      + qualityStability * 0.10
    );
    return {
      value, supportRatio, consistency, multiBandAgreement,
      supportDurationMs, onsetRegularity, eventQuality,
    };
  }

  _fullTimeEvidence(low, doubled) {
    const extraPositions = Math.max(1, doubled.expectedGridPositions - low.expectedGridPositions);
    const extraSupport = clamp01(
      (doubled.supportedGridPositions - low.supportedGridPositions) / extraPositions,
    );
    const fullCoverage = doubled.expectedGridPositions
      ? doubled.supportedGridPositions / doubled.expectedGridPositions : 0;
    const phaseRelative = clamp01(1 - Math.max(0, low.phaseFitScore - doubled.phaseFitScore) / 0.34);
    const multiBandRelative = clamp01(1 - Math.max(0, low.multiBandAgreement - doubled.multiBandAgreement) / 0.42);
    const confidenceRelative = clamp01(1 - Math.max(0, low.confidence - doubled.confidence) / 0.30);
    const duration = clamp01(doubled.supportDurationMs / this.config.tempoShortWindowMs);
    return clamp01(
      extraSupport * 0.42
      + fullCoverage * 0.18
      + phaseRelative * 0.13
      + multiBandRelative * 0.09
      + confidenceRelative * 0.08
      + duration * 0.07
      + doubled.candidateAlignment * 0.03,
    );
  }

  _updateHarmonicPersistence(timestamp, candidates) {
    const elapsed = Math.max(0, timestamp - this.lastHarmonicSupportAt);
    this.lastHarmonicSupportAt = timestamp;
    const current = this._nearestCandidate(candidates, this.selectedBpm);
    const half = this.selectedBpm >= 120
      ? this._nearestCandidate(candidates, this.selectedBpm * 0.5) : null;
    const isFullTimePair = current && half
      && relationBetween(half.bpm, current.bpm) === '0.5x'
      && Math.abs(current.bpm - this.selectedBpm) <= Math.max(3, this.selectedBpm * 0.035);
    const diagnosticsMatch = isFullTimePair
      && Math.abs(this.harmonicDiagnostics.baseBpm - half.bpm) <= 3;
    const intermediate = diagnosticsMatch ? this.harmonicDiagnostics.intermediateBeatSupport : 0;
    const supportNow = isFullTimePair ? clamp01(
      current.phaseFitScore * 0.22
      + current.periodicityScore * 0.18
      + current.multiBandAgreement * 0.16
      + current.candidateAlignment * 0.10
      + intermediate * 0.22
      + this.recentGridSupport * 0.12
    ) : 0;
    const established = this.selectedBpm >= 120
      && ['locked', 'hold'].includes(this.state)
      && this._lockMaturityLabel(timestamp) !== 'immature';
    const target = established ? supportNow : 0;
    const timeConstant = target >= this.fullTimeSupportHistory
      ? this.config.fullTimeSupportAttackMs : this.config.fullTimeSupportDecayMs;
    const alpha = clamp01(elapsed / Math.max(1, timeConstant));
    this.fullTimeSupportHistory = clamp01(
      this.fullTimeSupportHistory + (target - this.fullTimeSupportHistory) * alpha,
    );

    if (!isFullTimePair) {
      this.halfTimeTakeoverEvidence = clamp01(this.halfTimeTakeoverEvidence * (1 - alpha));
      if (this.halfTimeTakeoverEvidence < this.config.halfTimeTakeoverEvidenceThreshold - 0.14) {
        this.halfTimeTakeoverArmed = false;
        this.halfTimeTakeoverStartedAt = 0;
        this.halfTimeTakeoverCandidateBpm = 0;
      }
      this.halfTimeTakeoverReason = established
        ? 'no-valid-half-time-candidate' : 'no-established-full-time-lock';
      return;
    }
    const scoreAdvantage = clamp01((half.score - current.score + 0.04) / 0.28);
    const confidenceAdvantage = clamp01((half.confidence - current.confidence + 0.05) / 0.30);
    const phaseAdvantage = clamp01((half.phaseFitScore - current.phaseFitScore + 0.05) / 0.35);
    const missingIntermediate = clamp01(1 - intermediate);
    const weakCurrent = clamp01(1 - (
      current.periodicityScore * 0.34
      + current.phaseFitScore * 0.36
      + current.multiBandAgreement * 0.20
      + current.candidateAlignment * 0.10
    ));
    const contextChange = this.hasAudioContext ? clamp01(1 - this.audioContinuity) : 0;
    const instantEvidence = clamp01(
      missingIntermediate * 0.25
      + scoreAdvantage * 0.23
      + confidenceAdvantage * 0.14
      + phaseAdvantage * 0.18
      + weakCurrent * 0.12
      + contextChange * 0.08
    );
    const evidenceAlpha = clamp01(elapsed / 2_000);
    this.halfTimeTakeoverEvidence = clamp01(
      this.halfTimeTakeoverEvidence
      + (instantEvidence - this.halfTimeTakeoverEvidence) * evidenceAlpha,
    );
    const threshold = this.config.halfTimeTakeoverEvidenceThreshold;
    if (this.halfTimeTakeoverEvidence >= threshold) {
      if (!this.halfTimeTakeoverArmed) {
        this.halfTimeTakeoverStartedAt = timestamp;
        this.halfTimeTakeoverCandidateBpm = half.bpm;
      }
      this.halfTimeTakeoverArmed = true;
    } else if (this.halfTimeTakeoverEvidence < threshold - 0.14) {
      this.halfTimeTakeoverArmed = false;
      this.halfTimeTakeoverStartedAt = 0;
      this.halfTimeTakeoverCandidateBpm = 0;
    }
    if (this.halfTimeTakeoverEvidence >= threshold) {
      this.halfTimeTakeoverReason = 'persistent-half-time-fit';
    } else if (this.fullTimeSupportHistory >= this.config.halfTimeTakeoverHistoryThreshold) {
      this.halfTimeTakeoverReason = 'mature-full-time-history-hold';
    } else if (missingIntermediate < 0.45) {
      this.halfTimeTakeoverReason = 'intermediate-full-time-support';
    } else {
      this.halfTimeTakeoverReason = 'insufficient-half-time-evidence';
    }
  }

  _harmonicAmbiguity() {
    const delta = Math.abs(this.harmonicDiagnostics.harmonicScoreDelta || 0);
    const confidenceDelta = Math.abs(this.harmonicDiagnostics.harmonicConfidenceDelta || 0);
    if (!this.harmonicDiagnostics.harmonicRelation || this.harmonicDiagnostics.harmonicRelation === 'none') return 0;
    return clamp01(1 - (delta * 2.4 + confidenceDelta * 1.6));
  }

  _updateAcquisitionDiagnostics(timestamp, best, series) {
    if (!best) {
      this.acquisitionConfidence = 0;
      this.acquisitionMaturity = 0;
      this.lockQuality = 0;
      this.periodicityConfidence = 0;
      this.acquisitionAnchorSupport = 0;
      this.acquisitionEvidenceAgeMs = 0;
      this.acquisitionReason = 'no-tempo-hypothesis';
      return;
    }
    const supportRatio = best.expectedGridPositions
      ? best.supportedGridPositions / best.expectedGridPositions : 0;
    const evidenceAge = Math.max(0, finite(series?.duration));
    const durationScore = clamp01(evidenceAge / this.config.acquisitionMinimumEvidenceMs);
    const anchorSupport = clamp01(supportRatio * 0.64 + best.candidateAlignment * 0.36);
    const periodicityConfidence = clamp01(
      best.periodicityScore * 0.52 + best.phaseFitScore * 0.32 + supportRatio * 0.16,
    );
    const harmonicAmbiguity = this._harmonicAmbiguity();
    const independence = clamp01(
      periodicityConfidence * 0.28
      + best.phaseFitScore * 0.23
      + best.multiBandAgreement * 0.19
      + anchorSupport * 0.18
      + durationScore * 0.12,
    );
    const confidence = clamp01(
      best.confidence * 0.42
      + independence * 0.48
      + durationScore * 0.10
      - harmonicAmbiguity * 0.12,
    );
    const maturity = clamp01(
      durationScore * 0.48
      + clamp01(best.supportedGridPositions / 8) * 0.22
      + anchorSupport * 0.16
      + best.multiBandAgreement * 0.14,
    );
    const lockQuality = clamp01(
      confidence * 0.34
      + maturity * 0.24
      + periodicityConfidence * 0.20
      + best.phaseFitScore * 0.12
      + anchorSupport * 0.10,
    );
    this.acquisitionConfidence = confidence;
    this.acquisitionMaturity = maturity;
    this.lockQuality = lockQuality;
    this.periodicityConfidence = periodicityConfidence;
    this.acquisitionAnchorSupport = anchorSupport;
    this.acquisitionEvidenceAgeMs = evidenceAge;
    if (evidenceAge < this.config.acquisitionMinimumEvidenceMs) {
      this.acquisitionReason = 'insufficient-evidence-age';
    } else if (periodicityConfidence < 0.30) {
      this.acquisitionReason = 'weak-periodicity';
    } else if (anchorSupport < 0.28) {
      this.acquisitionReason = 'weak-anchor-support';
    } else if (harmonicAmbiguity > this.config.acquisitionMaximumHarmonicAmbiguity) {
      this.acquisitionReason = 'harmonic-ambiguity';
    } else if (lockQuality < this.config.acquisitionMinimumLockQuality) {
      this.acquisitionReason = 'lock-quality-below-gate';
    } else {
      this.acquisitionReason = 'lock-quality-gate-passed';
    }
  }

  _acquisitionGatePassed() {
    return this.acquisitionConfidence >= this.config.acquisitionMinimumConfidence
      && this.acquisitionMaturity >= this.config.acquisitionMinimumMaturity
      && this.lockQuality >= this.config.acquisitionMinimumLockQuality
      && this.acquisitionEvidenceAgeMs >= this.config.acquisitionMinimumEvidenceMs
      && this._harmonicAmbiguity() <= this.config.acquisitionMaximumHarmonicAmbiguity;
  }

  _lockMaturity(timestamp) {
    if (!this.firstSelectionAt) return 0;
    const age = Math.max(0, timestamp - this.firstSelectionAt);
    const timeMaturity = clamp01(age / this.config.harmonicMatureAgeMs);
    return clamp01(timeMaturity * 0.65 + this.stability * 0.2 + this.confidence * 0.15);
  }

  _lockMaturityLabel(timestamp) {
    const age = this.firstSelectionAt ? Math.max(0, timestamp - this.firstSelectionAt) : 0;
    if (age >= this.config.harmonicMatureAgeMs && this.stability >= 0.65) return 'mature';
    if (age >= this.config.harmonicEstablishedAgeMs && this.stability >= 0.4) return 'established';
    return 'immature';
  }

  _emptyHarmonicDiagnostics() {
    return {
      halfTimeCandidate: null,
      fullTimeCandidate: null,
      fullTimeEvidence: 0,
      harmonicScoreDelta: 0,
      harmonicConfidenceDelta: 0,
      harmonicRelation: 'none',
      baseBpm: 0,
      doubleBpm: 0,
      intermediateBeatSupport: 0,
      intermediateEventQuality: 0,
      baseTempoEvidence: 0,
      supportConsistency: 0,
      intermediateMultiBandAgreement: 0,
      intermediateSupportDurationMs: 0,
      intermediateOnsetRegularity: 0,
      dancePriorContribution: 0,
      finalHarmonicDecision: 'none',
    };
  }

  _select(timestamp, best, candidates) {
    if (!best || best.confidence < 0.18) {
      this._handleWeakSupport(timestamp);
      return;
    }
    if (!this.selectedBpm) {
      this.selectedBpm = best.bpm;
      this.selectedCandidate = best;
      this.firstSelectionAt = timestamp;
      this.lastTempoChangeAt = timestamp;
      this.lastTempoChangeReason = 'continuous-tempo-acquired';
      this.reason = 'continuous-tempo-acquired';
      this.state = 'tentative';
      this.confidence = best.confidence;
      this.stability = 0;
      this._resetTempoCenter(timestamp, best);
      this.lastTempoMaturityLabel = 'immature';
      this.transitionCandidateTempo = best.bpm;
      if (this.transitionOldTempo > 0) {
        this.transitionState = 'reacquiring';
        this.reacquireStartedAt = timestamp;
      } else {
        this.transitionState = 'stable';
      }
      return;
    }

    const current = this._nearestCandidate(candidates, this.selectedBpm);
    const maturityLabel = this._lockMaturityLabel(timestamp);
    const consensus = this._tempoConsensus(candidates, best, maturityLabel === 'immature'
      ? this.config.tempoAcquisitionRadiusBpm : this.config.tempoClusterRadiusBpm);
    const difference = Math.abs(consensus.bpm - this.selectedBpm);
    if (this.lastTempoMaturityLabel === 'immature' && maturityLabel === 'established'
      && relationBetween(consensus.bpm, this.selectedBpm) === '1x') {
      // Early autocorrelation has a wide peak. Once the lock has enough history,
      // discard that acquisition bias and seed the robust center from current evidence.
      this._resetTempoCenter(timestamp, consensus);
    }
    this.lastTempoMaturityLabel = maturityLabel;
    const acquiringTempo = maturityLabel === 'immature';
    const refinementRange = acquiringTempo
      ? this.config.tempoAcquisitionRadiusBpm : this.config.tempoMeaningfulChangeBpm;
    if (difference <= refinementRange) {
      const previous = this.selectedBpm;
      const clusterRadius = acquiringTempo
        ? this.config.tempoAcquisitionRadiusBpm : this.config.tempoClusterRadiusBpm;
      const withinCluster = Math.abs(consensus.bpm - (this.tempoCenterBpm || this.selectedBpm))
        <= clusterRadius;
      if (withinCluster) this._refineTempoCenter(timestamp, consensus);
      else this.lastTempoRefinementAt = timestamp;
      this.selectedCandidate = withinCluster ? best : (current || this.selectedCandidate);
      const preserveHalfTimeTakeover = this.halfTimeTakeoverArmed
        && this.pendingSwitch?.relation === '0.5x';
      if (!preserveHalfTimeTakeover) this.pendingSwitch = null;
      this.confidence = clamp01(this.confidence * 0.68 + best.confidence * 0.32);
      const precision = clamp01(1 - Math.abs(best.bpm - this.selectedBpm)
        / this.config.tempoMeaningfulChangeBpm);
      this.stability = clamp01(this.stability * 0.78 + precision * 0.22);
      const age = timestamp - this.firstSelectionAt;
      const wasLocked = this.state === 'locked';
      const acquisitionReady = this._acquisitionGatePassed();
      const previouslyLockedAtThisTempo = this.lockedAt > 0;
      this.state = wasLocked || (age >= 2_000 && this.confidence >= 0.38
        && (acquisitionReady || previouslyLockedAtThisTempo))
        ? 'locked' : 'tentative';
      if (this.state === 'locked' && !this.lockedAt) this.lockedAt = timestamp;
      this.reason = this.state === 'tentative' && !acquisitionReady
        ? `acquisition-${this.acquisitionReason}`
        : (withinCluster ? 'continuous-tempo-refinement' : 'tempo-cluster-hold');
      return;
    }

    const relation = relationBetween(best.bpm, this.selectedBpm);
    const harmonic = relation === '0.5x' || relation === '2x';
    const scoreDelta = best.score - (current?.score || 0);
    const weakCurrent = !current || current.confidence < 0.28 || this.confidence < 0.32
      || ['stale', 'transition-search'].includes(this.transitionState);
    const halfTimeRegression = relation === '0.5x'
      && this.selectedBpm >= this.config.dancePriorStartBpm
      && best.bpm >= 62 && best.bpm <= 88;
    const protectResolvedFullTime = halfTimeRegression
      && this.lastTempoChangeReason === 'harmonic-full-time-relock'
      && this.confidence >= 0.35;
    const matureFullTimeHistory = halfTimeRegression
      && this.fullTimeSupportHistory >= this.config.halfTimeTakeoverHistoryThreshold;
    const halfTimeTakeoverReady = halfTimeRegression
      && this.halfTimeTakeoverArmed;
    const protectTrueLowTempo = relation === '2x'
      && this.harmonicDiagnostics.finalHarmonicDecision === 'protected-low-tempo'
      && this.harmonicDiagnostics.baseTempoEvidence >= this.config.lowTempoBaseEvidenceMinimum
      && Math.abs(this.harmonicDiagnostics.baseBpm - this.selectedBpm)
        <= Math.max(3, this.selectedBpm * 0.04)
      && this.harmonicDiagnostics.intermediateEventQuality
        < this.config.intermediateEventQualityMinimum
      && this.confidence >= 0.32;
    const requiredDelta = halfTimeRegression
      ? (halfTimeTakeoverReady ? Math.max(0.04, this.config.harmonicMatureScoreDelta) : 0.20)
      : harmonic
      ? (maturityLabel === 'immature'
        ? this.config.harmonicEarlyScoreDelta
        : maturityLabel === 'established'
          ? this.config.harmonicEstablishedScoreDelta
          : this.config.harmonicMatureScoreDelta)
      : this.config.tempoNormalSwitchScoreDelta;
    const requiredPersistence = halfTimeRegression
      ? this.config.harmonicMaturePersistenceMs
        + this.fullTimeSupportHistory * this.config.halfTimeTakeoverMaximumExtraMs
      : harmonic
      ? (maturityLabel === 'immature'
        ? this.config.harmonicEarlyPersistenceMs
        : maturityLabel === 'established'
          ? this.config.harmonicEstablishedPersistenceMs
          : this.config.harmonicMaturePersistenceMs)
      : this.config.tempoNormalSwitchPersistenceMs;
    const confidenceDelta = best.confidence - (current?.confidence || 0);
    const requiredConfidenceDelta = halfTimeRegression
      ? (halfTimeTakeoverReady ? -0.05 : 0.10)
      : maturityLabel === 'immature'
      ? this.config.harmonicEarlyConfidenceDelta
      : maturityLabel === 'established'
        ? this.config.harmonicEstablishedConfidenceDelta
        : this.config.harmonicMatureConfidenceDelta;
    if (((protectResolvedFullTime && !halfTimeTakeoverReady)
      || (matureFullTimeHistory && !halfTimeTakeoverReady)
      || protectTrueLowTempo || scoreDelta < requiredDelta
      || (harmonic && confidenceDelta < requiredConfidenceDelta)) && !weakCurrent) {
      this.pendingSwitch = null;
      this.selectedCandidate = current || this.selectedCandidate;
      this.confidence = clamp01(this.confidence * 0.985);
      this.stability = clamp01(this.stability * 0.99);
      this.state = this.confidence >= 0.35 ? 'locked' : 'unstable';
      this.reason = 'tempo-lock-hysteresis';
      return;
    }

    const pendingTolerance = harmonic ? Math.max(4, best.bpm * 0.035) : Math.max(2, best.bpm * 0.02);
    const samePending = this.pendingSwitch
      && this.pendingSwitch.relation === relation
      && Math.abs(this.pendingSwitch.bpm - best.bpm) <= pendingTolerance;
    if (!samePending) {
      this.pendingSwitch = { bpm: best.bpm, startedAt: timestamp, relation, scoreDelta, confidenceDelta };
      const retainLock = this.state === 'locked';
      this.state = retainLock ? 'locked' : 'unstable';
      this.reason = retainLock
        ? (harmonic ? 'harmonic-change-observing' : 'tempo-change-observing')
        : (harmonic ? 'harmonic-relock-pending' : 'tempo-change-pending');
      return;
    }
    this.pendingSwitch.scoreDelta = scoreDelta;
    this.pendingSwitch.confidenceDelta = confidenceDelta;
    if (harmonic) this.pendingSwitch.bpm = this.pendingSwitch.bpm * 0.75 + best.bpm * 0.25;
    const takeoverPersistenceMs = relation === '0.5x'
      && this.halfTimeTakeoverArmed
      && this.halfTimeTakeoverStartedAt
      && Math.abs(this.halfTimeTakeoverCandidateBpm - best.bpm) <= pendingTolerance
      ? timestamp - this.halfTimeTakeoverStartedAt
      : 0;
    const persistenceMs = Math.max(timestamp - this.pendingSwitch.startedAt, takeoverPersistenceMs);
    if (persistenceMs < requiredPersistence && !weakCurrent) {
      const conflictEstablished = persistenceMs >= Math.min(1_000, requiredPersistence * 0.5);
      if (this.state !== 'locked' || conflictEstablished) this.state = 'unstable';
      this.reason = this.state === 'locked'
        ? (harmonic ? 'harmonic-change-observing' : 'tempo-change-observing')
        : (harmonic ? 'harmonic-relock-pending' : 'tempo-change-pending');
      return;
    }

    const oldBpm = this.selectedBpm;
    this.selectedBpm = best.bpm;
    this.selectedCandidate = best;
    this.firstSelectionAt = timestamp;
    this.lockedAt = 0;
    this.confidence = best.confidence;
    this.stability = 0.25;
    this._resetTempoCenter(timestamp, best);
    this.lastTempoMaturityLabel = 'immature';
    this.state = 'tentative';
    this.lastTempoChangeAt = timestamp;
    this.lastTempoChangeReason = harmonic ? 'harmonic-full-time-relock' : 'persistent-tempo-change';
    this.lastTempoChange = Object.freeze({
      oldBpm,
      newBpm: best.bpm,
      reason: this.lastTempoChangeReason,
      scoreDelta,
      persistenceMs,
    });
    this.reason = this.lastTempoChangeReason;
    this.transitionOldTempo = oldBpm;
    this.transitionCandidateTempo = best.bpm;
    this.transitionState = 'reacquiring';
    this.reacquireStartedAt = timestamp;
    this.pendingSwitch = null;
    if (relation === '0.5x') {
      this.halfTimeTakeoverArmed = false;
      this.halfTimeTakeoverStartedAt = 0;
      this.halfTimeTakeoverCandidateBpm = 0;
    }
  }

  _resetTempoCenter(timestamp, candidate) {
    this.tempoCenterBpm = candidate?.bpm || this.selectedBpm;
    this.tempoEvidence = candidate ? [{
      timestamp,
      bpm: candidate.bpm,
      weight: Math.max(0.05, candidate.score * 0.55 + candidate.confidence * 0.45),
    }] : [];
    this.lastTempoRefinementAt = timestamp;
  }

  _tempoConsensus(candidates, best, radius) {
    const local = candidates.filter((candidate) => (
      Math.abs(candidate.bpm - best.bpm) <= radius
      && candidate.score >= best.score - 0.065
    )).map((candidate) => ({
      bpm: candidate.bpm,
      weight: Math.max(0.01, candidate.score * 0.45 + candidate.confidence * 0.55),
    }));
    if (local.length < 2) return best;
    return { ...best, bpm: weightedMedian(local) };
  }

  _refineTempoCenter(timestamp, candidate) {
    const cutoff = timestamp - this.config.tempoCenterWindowMs;
    this.tempoEvidence = this.tempoEvidence.filter((entry) => entry.timestamp >= cutoff);
    this.tempoEvidence.push({
      timestamp,
      bpm: candidate.bpm,
      weight: Math.max(0.05, candidate.score * 0.55 + candidate.confidence * 0.45),
    });
    const robustCenter = weightedMedian(this.tempoEvidence);
    const elapsedSeconds = Math.max(0, timestamp - this.lastTempoRefinementAt) / 1_000;
    const maxStep = this.config.tempoRefinementSlewBpmPerSecond * elapsedSeconds;
    const delta = clamp(robustCenter - this.selectedBpm, -maxStep, maxStep);
    this.selectedBpm += delta;
    this.tempoCenterBpm = robustCenter;
    this.lastTempoRefinementAt = timestamp;
  }

  _tempoClusterSpread() {
    if (!this.tempoEvidence.length) return 0;
    const center = this.tempoCenterBpm || weightedMedian(this.tempoEvidence);
    return weightedMedian(this.tempoEvidence.map((entry) => ({
      bpm: Math.abs(entry.bpm - center), weight: entry.weight,
    })));
  }

  _handleWeakSupport(timestamp) {
    if (!this.selectedBpm) {
      this.state = 'searching';
      this.reason = 'weak-continuous-periodicity';
      return;
    }
    const age = this.lastSupportAt ? timestamp - this.lastSupportAt : Infinity;
    if (age <= this.config.tempoBreakdownHoldMs) {
      this.state = 'unstable';
      this.confidence = clamp01(this.confidence * 0.985);
      this.stability = clamp01(this.stability * 0.992);
      this.reason = 'breakdown-grid-hold';
    } else {
      this.state = 'lost';
      this.confidence = clamp01(this.confidence * 0.94);
      this.reason = 'continuous-rhythm-support-lost';
      this.rhythmContextResetReason = 'phase-lock-lost';
    }
  }

  _nearestCandidate(candidates, bpm) {
    if (!candidates?.length || !(bpm > 0)) return null;
    return candidates.reduce((nearest, entry) => (
      !nearest || Math.abs(entry.bpm - bpm) < Math.abs(nearest.bpm - bpm) ? entry : nearest
    ), null);
  }

  _interpolate(values, index) {
    if (!values.length) return 0;
    const bounded = clamp(index, 0, values.length - 1);
    const lower = Math.floor(bounded);
    const upper = Math.min(values.length - 1, lower + 1);
    const fraction = bounded - lower;
    return values[lower] * (1 - fraction) + values[upper] * fraction;
  }
}
