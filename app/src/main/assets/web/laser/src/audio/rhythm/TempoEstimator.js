import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

export class TempoEstimator {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this._candidates = [];
    this._selectedBpm = 0;
    this._state = 'searching';
    this._confidence = 0;
    this._stability = 0;
    this._lockedAt = 0;
    this._lastTempoChangeAt = 0;
    this._lastTempoChangeReason = null;
    this._lastDocumentedBpm = 0;
    this._lastCandidateAt = 0;
    this._pendingConflict = null;
    this._prior = null;
    this._reason = 'insufficient-candidates';
    this._rhythmContextResetReason = null;
    this._topCandidates = [];
  }

  reset(timestamp = 0, reason = 'manual-reset') {
    this._candidates = [];
    this._selectedBpm = 0;
    this._state = 'searching';
    this._confidence = 0;
    this._stability = 0;
    this._lockedAt = 0;
    this._lastTempoChangeAt = Math.max(0, finite(timestamp));
    this._lastTempoChangeReason = reason;
    this._lastDocumentedBpm = 0;
    this._lastCandidateAt = 0;
    this._pendingConflict = null;
    this._reason = reason;
    this._rhythmContextResetReason = reason;
    this._topCandidates = [];
    return this.getSnapshot(timestamp);
  }

  setPrior(bpm = 0, confidence = 0) {
    const value = finite(bpm);
    this._prior = value >= this.config.minBpm && value <= this.config.maxBpm
      ? { bpm: value, confidence: clamp01(confidence) }
      : null;
  }

  addCandidate(candidate = {}) {
    const timestamp = Math.max(0, finite(candidate.timestamp));
    if (!timestamp && this._candidates.length) return this.getSnapshot(timestamp);
    this._candidates.push(Object.freeze({
      timestamp,
      strength: clamp01(candidate.strength),
      confidence: clamp01(candidate.confidence),
    }));
    this._lastCandidateAt = timestamp;
    this._prune(timestamp);
    this._estimate(timestamp);
    return this.getSnapshot(timestamp);
  }

  update(timestamp = 0, { signalState = 'signal' } = {}) {
    const now = Math.max(0, finite(timestamp));
    this._prune(now);
    const age = this._lastCandidateAt ? Math.max(0, now - this._lastCandidateAt) : Infinity;
    if (this._selectedBpm > 0 && age >= this.config.lostAfterMs) {
      this._state = 'lost';
      this._confidence *= Math.exp(-Math.min(1, (age - this.config.lostAfterMs) / this.config.lostAfterMs));
      this._reason = 'rhythm-support-lost';
      if (['silence', 'ended', 'no-source', 'stale'].includes(signalState)) {
        this._rhythmContextResetReason = 'prolonged-silence';
      } else {
        this._rhythmContextResetReason = 'phase-lock-lost';
      }
    } else if (this._selectedBpm > 0 && age >= this.config.unstableAfterMs) {
      this._state = 'unstable';
      this._confidence = clamp01(this._confidence * 0.985);
      this._reason = 'weak-recent-support';
    }
    return this.getSnapshot(now);
  }

  getSnapshot(timestamp = 0) {
    const now = Math.max(0, finite(timestamp));
    return deepFreeze({
      state: this._state,
      bpm: this._selectedBpm,
      confidence: clamp01(this._confidence),
      stability: clamp01(this._stability),
      lockAgeMs: this._lockedAt ? Math.max(0, now - this._lockedAt) : 0,
      candidateCount: this._candidates.length,
      topCandidates: this._topCandidates.map((entry) => ({ ...entry })),
      reason: this._reason,
      lastTempoChangeAt: this._lastTempoChangeAt,
      lastTempoChangeReason: this._lastTempoChangeReason,
      rhythmContextResetReason: this._rhythmContextResetReason,
    });
  }

  _prune(timestamp) {
    const cutoff = timestamp - this.config.tempoStabilityWindowMs;
    this._candidates = this._candidates.filter((candidate) => candidate.timestamp >= cutoff);
  }

  _estimate(timestamp) {
    if (this._candidates.length < 2) return;
    const shortCutoff = timestamp - this.config.tempoShortWindowMs;
    const recent = this._candidates.filter((candidate) => candidate.timestamp >= shortCutoff);
    const working = recent.length >= this.config.tempoTentativeCandidates ? recent : this._candidates;
    const evidence = [];
    for (let index = 1; index < working.length; index++) {
      for (let lag = 1; lag <= Math.min(4, index); lag++) {
        const current = working[index];
        const previous = working[index - lag];
        const interval = current.timestamp - previous.timestamp;
        if (!(interval > 0)) continue;
        const rawBpm = 60_000 / interval;
        const recency = Math.exp(-(timestamp - current.timestamp) / Math.max(1, this.config.tempoShortWindowMs));
        const quality = (0.35 + Math.sqrt(current.strength * previous.strength) * 0.35
          + Math.sqrt(current.confidence * previous.confidence) * 0.3) * recency / lag;
        this._addEvidence(evidence, rawBpm, quality, '1x');
        this._addEvidence(evidence, rawBpm * 2, quality * 0.38, '2x');
        this._addEvidence(evidence, rawBpm / 2, quality * 0.28, '0.5x');
      }
    }
    if (!evidence.length) return;

    const clusters = [];
    for (const item of evidence.sort((a, b) => a.bpm - b.bpm)) {
      let cluster = clusters.find((entry) => Math.abs(entry.bpm - item.bpm)
        <= Math.max(1.25, item.bpm * 0.08));
      if (!cluster) {
        cluster = { bpm: item.bpm, weightedBpm: 0, score: 0, supportCount: 0 };
        clusters.push(cluster);
      }
      cluster.weightedBpm += item.bpm * item.weight;
      cluster.score += item.weight;
      cluster.supportCount++;
      cluster.bpm = cluster.weightedBpm / cluster.score;
    }
    if (this._prior) {
      const maximumScore = Math.max(...clusters.map((cluster) => cluster.score), 0);
      let priorCluster = clusters.find((cluster) => Math.abs(cluster.bpm - this._prior.bpm) <= 2);
      if (!priorCluster) {
        priorCluster = { bpm: this._prior.bpm, weightedBpm: this._prior.bpm, score: 0, supportCount: 0 };
        clusters.push(priorCluster);
      }
      const boost = maximumScore * this._prior.confidence * 0.45;
      priorCluster.weightedBpm += this._prior.bpm * boost;
      priorCluster.score += boost;
      if (priorCluster.score > 0) priorCluster.bpm = priorCluster.weightedBpm / priorCluster.score;
    }
    for (const cluster of clusters) cluster.bpm = this._refineBpm(working, cluster.bpm);
    clusters.sort((first, second) => second.score - first.score || second.supportCount - first.supportCount);
    const best = clusters[0];
    const maxScore = Math.max(best.score, 1e-9);
    const reference = this._selectedBpm || best.bpm;
    this._topCandidates = clusters.slice(0, 3).map((cluster) => ({
      bpm: Math.round(cluster.bpm * 100) / 100,
      score: clamp01(cluster.score / maxScore),
      confidence: clamp01(cluster.score / Math.max(maxScore + (clusters[1]?.score || 0) * 0.45, 1e-9)),
      supportCount: cluster.supportCount,
      harmonicRelation: relationBetween(cluster.bpm, reference),
    }));

    const selectedCluster = this._selectedBpm
      ? clusters.find((cluster) => relationBetween(cluster.bpm, this._selectedBpm) === '1x')
      : null;
    const fitBpm = selectedCluster?.bpm || best.bpm;
    const stability = this._calculateStability(working, fitBpm);
    const nonHarmonicSecond = clusters.find((cluster) => relationBetween(cluster.bpm, best.bpm) === 'none');
    const separation = best.score / Math.max(best.score + (nonHarmonicSecond?.score || 0), 1e-9);
    const supportFactor = clamp01(best.supportCount / Math.max(8, this.config.tempoLockCandidates));
    const confidence = clamp01(supportFactor * (stability * 0.62 + separation * 0.38));
    this._stability = stability;
    this._confidence = confidence;

    if (!this._selectedBpm) {
      this._selectTempo(best.bpm, timestamp, 'initial-tempo-hypothesis');
    } else if (selectedCluster && relationBetween(best.bpm, this._selectedBpm) === '1x') {
      this._selectedBpm += (selectedCluster.bpm - this._selectedBpm) * 0.2;
      this._selectedBpm = Math.round(this._selectedBpm * 100) / 100;
      this._documentTempoRefinement(timestamp);
      this._pendingConflict = null;
      this._reason = 'tempo-supported';
    } else if (selectedCluster && best.score <= selectedCluster.score * 1.15) {
      this._selectedBpm += (selectedCluster.bpm - this._selectedBpm) * 0.08;
      this._selectedBpm = Math.round(this._selectedBpm * 100) / 100;
      this._documentTempoRefinement(timestamp);
      this._pendingConflict = null;
      this._reason = 'existing-lock-hysteresis';
    } else {
      this._resolveConflict(best, clusters, timestamp);
    }

    const enoughForTentative = this._candidates.length >= this.config.tempoTentativeCandidates;
    const enoughForLock = this._candidates.length >= this.config.tempoLockCandidates
      && best.supportCount >= this.config.tempoLockCandidates
      && stability >= 0.68
      && confidence >= 0.48;
    if (enoughForLock) {
      if (this._state !== 'locked') this._lockedAt = timestamp;
      this._state = 'locked';
      this._reason = this._reason === 'tempo-supported' ? 'stable-tempo-lock' : this._reason;
    } else if (enoughForTentative) {
      this._state = 'tentative';
    } else {
      this._state = 'searching';
      this._reason = 'insufficient-candidates';
    }
  }

  _addEvidence(evidence, bpm, weight, relation) {
    if (bpm < this.config.minBpm - 1 || bpm > this.config.maxBpm + 1 || !(weight > 0)) return;
    evidence.push({ bpm: Math.max(this.config.minBpm, Math.min(this.config.maxBpm, bpm)), weight, relation });
  }

  _refineBpm(candidates, bpm) {
    if (candidates.length < 3 || !(bpm > 0)) return bpm;
    const referencePeriod = 60_000 / bpm;
    const periods = [];
    for (let index = 1; index < candidates.length; index++) {
      const interval = candidates[index].timestamp - candidates[index - 1].timestamp;
      const multiple = Math.max(1, Math.round(interval / referencePeriod));
      const normalizedPeriod = interval / multiple;
      if (Math.abs(normalizedPeriod - referencePeriod) / referencePeriod <= 0.16) {
        periods.push(normalizedPeriod);
      }
    }
    if (periods.length < 2) return bpm;
    periods.sort((a, b) => a - b);
    const trimmed = periods.length >= 7 ? periods.slice(1, -1) : periods;
    const meanPeriod = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
    const refined = 60_000 / meanPeriod;
    return refined >= this.config.minBpm && refined <= this.config.maxBpm ? refined : bpm;
  }

  _calculateStability(candidates, bpm) {
    if (candidates.length < 3 || !(bpm > 0)) return 0;
    const period = 60_000 / bpm;
    const errors = [];
    for (let index = 1; index < candidates.length; index++) {
      const interval = candidates[index].timestamp - candidates[index - 1].timestamp;
      const multiple = Math.max(1, Math.round(interval / period));
      errors.push(Math.abs(interval - multiple * period) / period);
    }
    const typicalError = median(errors);
    return clamp01(1 - typicalError / 0.18);
  }

  _resolveConflict(best, clusters, timestamp) {
    const currentCluster = clusters.find((cluster) => relationBetween(cluster.bpm, this._selectedBpm) === '1x');
    const currentScore = currentCluster?.score || 0;
    const harmonic = relationBetween(best.bpm, this._selectedBpm);
    const requiredRatio = harmonic === '0.5x' || harmonic === '2x'
      ? this.config.harmonicSwitchRatio
      : 1.15;
    if (best.score <= Math.max(0.001, currentScore) * requiredRatio) {
      this._pendingConflict = null;
      this._reason = harmonic === 'none' ? 'tempo-conflict-rejected' : 'harmonic-switch-rejected';
      return;
    }
    if (!this._pendingConflict || Math.abs(this._pendingConflict.bpm - best.bpm) > 2) {
      this._pendingConflict = { bpm: best.bpm, since: timestamp, harmonic };
      this._state = 'unstable';
      this._reason = harmonic === 'none' ? 'persistent-tempo-conflict-pending' : 'harmonic-switch-pending';
      return;
    }
    if (timestamp - this._pendingConflict.since >= this.config.tempoConflictHoldMs) {
      this._selectTempo(best.bpm, timestamp, harmonic === 'none' ? 'persistent-tempo-conflict' : `harmonic-switch-${harmonic}`);
      this._rhythmContextResetReason = harmonic === 'none' ? 'persistent-tempo-conflict' : null;
      this._pendingConflict = null;
    }
  }

  _selectTempo(bpm, timestamp, reason) {
    this._selectedBpm = Math.round(bpm * 100) / 100;
    this._lastDocumentedBpm = this._selectedBpm;
    this._lastTempoChangeAt = timestamp;
    this._lastTempoChangeReason = reason;
    this._reason = reason;
  }

  _documentTempoRefinement(timestamp) {
    if (Math.abs(this._selectedBpm - this._lastDocumentedBpm) < 1) return;
    this._lastDocumentedBpm = this._selectedBpm;
    this._lastTempoChangeAt = timestamp;
    this._lastTempoChangeReason = 'controlled-tempo-refinement';
  }
}
