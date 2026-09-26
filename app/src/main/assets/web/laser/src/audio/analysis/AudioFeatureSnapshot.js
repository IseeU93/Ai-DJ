import { AUDIO_FEATURE_SCHEMA_VERSION } from './AudioAnalysisConfig.js';

export const AUDIO_SIGNAL_STATES = Object.freeze([
  'no-source', 'source-active', 'silence', 'signal', 'clipping', 'stale', 'ended', 'error',
]);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));

const feature = (value = {}) => Object.freeze({
  raw: Math.max(0, finite(value.raw)),
  normalized: clamp01(value.normalized),
  smoothed: clamp01(value.smoothed),
  confidence: clamp01(value.confidence),
});

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

export const createAudioFeatureSnapshot = ({
  timestamp = 0,
  sourceStatus = {},
  rawFeatures = {},
  normalizedFeatures = {},
  signalState = 'no-source',
} = {}) => {
  const reasons = [];
  if (!AUDIO_SIGNAL_STATES.includes(signalState)) reasons.push('invalid-signal-state');
  const numericValues = Object.entries(rawFeatures)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => ({ key, value }));
  for (const { key, value } of numericValues) {
    if (!Number.isFinite(value)) reasons.push(`non-finite:${key}`);
  }
  if (['denied', 'unavailable', 'error'].includes(sourceStatus.state)) reasons.push(`source:${sourceStatus.state}`);

  const values = normalizedFeatures;
  const snapshot = {
    schemaVersion: AUDIO_FEATURE_SCHEMA_VERSION,
    timestamp: finite(timestamp),
    signalState: AUDIO_SIGNAL_STATES.includes(signalState) ? signalState : 'error',
    source: {
      id: String(sourceStatus.sourceId || ''),
      type: String(sourceStatus.sourceType || ''),
      state: String(sourceStatus.state || 'idle'),
      sampleRate: Math.max(0, finite(sourceStatus.sampleRate)),
      channelCount: Math.max(0, finite(sourceStatus.channelCount)),
    },
    level: {
      rms: feature(values.rms),
      peak: feature(values.peak),
      crestFactor: Math.max(0, finite(rawFeatures.crestFactor)),
      clipping: Boolean(rawFeatures.isClipping),
      silence: Boolean(rawFeatures.isSilent),
    },
    bands: {
      infra: feature(values.infraEnergy),
      sub: feature(values.subEnergy),
      lowBass: feature(values.lowBassEnergy),
      bassBody: feature(values.bassBodyEnergy),
      broadBass: feature(values.bassEnergy),
      bass: feature(values.bassEnergy),
      lowMid: feature(values.lowMidEnergy),
      mid: feature(values.midEnergy),
      highMid: feature(values.highMidEnergy),
      high: feature(values.highEnergy),
    },
    lowEnd: {
      sub: feature(values.subEnergy),
      lowBass: feature(values.lowBassEnergy),
      bassBody: feature(values.bassBodyEnergy),
      lowMid: feature(values.lowMidEnergy),
      totalEnergy: feature(values.lowFrequencyEnergy),
      impact: {
        value: clamp01(values.lowFrequencyImpact?.smoothed),
        confidence: clamp01(rawFeatures.lowFrequencyImpactConfidence),
      },
      sustained: clamp01(values.lowEndSustained?.smoothed),
      transient: clamp01(values.lowEndTransient?.smoothed),
      ratios: {
        subToLowMid: Math.max(0, Math.min(8, finite(rawFeatures.subToLowMidRatio))),
        lowBassToLowMid: Math.max(0, Math.min(8, finite(rawFeatures.lowBassToLowMidRatio))),
        impactToSustained: Math.max(0, Math.min(8, finite(rawFeatures.lowImpactToSustainedRatio))),
      },
    },
    spectrum: {
      centroidHz: Math.max(0, finite(rawFeatures.spectralCentroid)),
      flux: feature(values.spectralFlux),
      flatness: clamp01(rawFeatures.spectralFlatness),
      change: feature(values.spectralChange),
    },
    transient: {
      strength: feature(values.transientStrength),
      candidate: Boolean(rawFeatures.transientCandidate),
      confidence: clamp01(rawFeatures.transientConfidence),
    },
    quality: {
      valid: reasons.length === 0,
      confidence: clamp01(Object.values(values).length
        ? Object.values(values).reduce((sum, value) => sum + clamp01(value.confidence), 0) / Object.values(values).length
        : 0),
      reasons,
    },
  };
  return deepFreeze(snapshot);
};
