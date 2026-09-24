import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const response = (deltaSeconds, seconds) => 1 - Math.exp(-Math.max(0, deltaSeconds) / Math.max(0.001, seconds));

const createNoveltyState = () => ({ baseline: 0, deviation: 0.025 });

const frozenEmptyAnalysis = () => Object.freeze({
  timestamp: 0,
  lowEndContribution: 0,
  broadbandContribution: 0,
  spectralContribution: 0,
  strength: 0,
  confidence: 0,
  thresholds: Object.freeze({ lowEnd: 0, broadband: 0, spectral: 0 }),
  reasonFlags: Object.freeze([]),
  lastCandidateTimestamp: 0,
  candidate: null,
});

export class BeatCandidateExtractor {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this._states = {
      lowEnd: createNoveltyState(),
      broadband: createNoveltyState(),
      spectral: createNoveltyState(),
    };
    this._lastTimestamp = null;
    this._previousRawSignals = { lowEnd: 0, broadband: 0, spectral: 0 };
    this._lastCandidateAt = -Infinity;
    this.lastCandidate = null;
    this.lastAnalysis = frozenEmptyAnalysis();
  }

  reset() {
    this._states = {
      lowEnd: createNoveltyState(),
      broadband: createNoveltyState(),
      spectral: createNoveltyState(),
    };
    this._lastTimestamp = null;
    this._previousRawSignals = { lowEnd: 0, broadband: 0, spectral: 0 };
    this._lastCandidateAt = -Infinity;
    this.lastCandidate = null;
    this.lastAnalysis = frozenEmptyAnalysis();
  }

  process(snapshot = {}) {
    const timestamp = Math.max(0, finite(snapshot.timestamp));
    const deltaSeconds = this._lastTimestamp === null
      ? 0.025
      : Math.max(0.001, Math.min(0.25, (timestamp - this._lastTimestamp) / 1000));
    const previousTimestamp = this._lastTimestamp;
    this._lastTimestamp = timestamp;

    const lowImpact = clamp01(snapshot.lowEnd?.impact?.value);
    const lowConfidence = clamp01(snapshot.lowEnd?.impact?.confidence);
    const lowTransient = clamp01(snapshot.lowEnd?.transient);
    const subRatio = Math.min(8, Math.max(0, finite(snapshot.lowEnd?.ratios?.subToLowMid)));
    const lowBassRatio = Math.min(8, Math.max(0, finite(snapshot.lowEnd?.ratios?.lowBassToLowMid)));
    const lowDominance = clamp01((subRatio + lowBassRatio) / 8);

    const flux = clamp01(snapshot.spectrum?.flux?.smoothed);
    const change = clamp01(snapshot.spectrum?.change?.smoothed);
    const transientStrength = clamp01(snapshot.transient?.strength?.smoothed);
    const transientConfidence = clamp01(snapshot.transient?.confidence);
    const midHighEnergy = clamp01((
      clamp01(snapshot.bands?.mid?.smoothed)
      + clamp01(snapshot.bands?.highMid?.smoothed)
      + clamp01(snapshot.bands?.high?.smoothed)
    ) / 3);

    const rawSignals = {
      lowEnd: clamp01(lowImpact * 0.52 + lowConfidence * 0.22 + lowTransient * 0.16 + lowDominance * lowImpact * 0.1),
      broadband: clamp01(flux * 0.38 + change * 0.22 + transientStrength * 0.25 + transientConfidence * 0.15),
      spectral: clamp01((flux * 0.65 + change * 0.35) * (0.45 + midHighEnergy * 0.55)),
    };

    const contributions = {};
    const thresholds = {};
    for (const [key, raw] of Object.entries(rawSignals)) {
      const state = this._states[key];
      const threshold = state.baseline
        + state.deviation * this.config.candidateThresholdDeviation
        + this.config.candidateMinimumThreshold;
      thresholds[key] = threshold;
      contributions[key] = clamp01((raw - threshold) / Math.max(0.08, threshold * 1.8));
      state.baseline += (raw - state.baseline) * response(deltaSeconds, this.config.candidateBaselineSeconds);
      const absoluteDeviation = Math.abs(raw - state.baseline);
      state.deviation += (absoluteDeviation - state.deviation)
        * response(deltaSeconds, this.config.candidateDeviationSeconds);
    }

    const lowEndContribution = contributions.lowEnd;
    const broadbandContribution = contributions.broadband;
    const spectralContribution = contributions.spectral;
    const strength = clamp01(
      lowEndContribution * 0.48
      + broadbandContribution * 0.42
      + spectralContribution * 0.1,
    );
    const confidence = clamp01(
      strength * 0.55
      + Math.max(lowConfidence, transientConfidence) * 0.25
      + Math.max(lowEndContribution, broadbandContribution) * 0.2,
    );
    const reasonFlags = [];
    if (lowEndContribution > 0.08) reasonFlags.push('low-end-impact');
    if (broadbandContribution > 0.08) reasonFlags.push('broadband-onset');
    if (spectralContribution > 0.08) reasonFlags.push('spectral-onset');
    if (reasonFlags.length) reasonFlags.push('adaptive-threshold-exceeded');

    const outsideRefractory = timestamp - this._lastCandidateAt >= this.config.candidateRefractoryMs;
    const signalUsable = !['silence', 'no-source', 'stale', 'ended', 'error'].includes(snapshot.signalState);
    let candidate = null;
    if (signalUsable
      && outsideRefractory
      && strength >= this.config.candidateMinimumStrength
      && (lowEndContribution > 0.08 || broadbandContribution > 0.08)) {
      const dominantKey = Object.entries(contributions)
        .sort((first, second) => second[1] - first[1])[0]?.[0] || 'lowEnd';
      const previousRaw = this._previousRawSignals[dominantKey];
      const currentRaw = rawSignals[dominantKey];
      const crossingFraction = previousTimestamp !== null && currentRaw > previousRaw
        ? clamp01((thresholds[dominantKey] - previousRaw) / (currentRaw - previousRaw))
        : 1;
      const candidateTimestamp = previousTimestamp === null
        ? timestamp
        : previousTimestamp + (timestamp - previousTimestamp) * crossingFraction;
      candidate = Object.freeze({
        timestamp: candidateTimestamp,
        strength,
        confidence,
        lowEndContribution,
        broadbandContribution,
        spectralContribution,
        reasonFlags: Object.freeze([...reasonFlags]),
      });
      this._lastCandidateAt = candidateTimestamp;
      this.lastCandidate = candidate;
    }

    this.lastAnalysis = Object.freeze({
      timestamp,
      lowEndContribution,
      broadbandContribution,
      spectralContribution,
      strength,
      confidence,
      thresholds: Object.freeze({ ...thresholds }),
      reasonFlags: Object.freeze([...reasonFlags]),
      lastCandidateTimestamp: this.lastCandidate?.timestamp || 0,
      candidate,
    });
    this._previousRawSignals = { ...rawSignals };
    return candidate;
  }
}
