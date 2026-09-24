import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const featureValue = (value) => {
  if (value && typeof value === 'object') {
    return clamp01(value.smoothed ?? value.normalized ?? value.value ?? value.raw);
  }
  return clamp01(value);
};
const positiveDelta = (value, previous) => Math.max(0, value - previous);

const freezeSample = (sample) => Object.freeze({
  timestamp: sample.timestamp,
  lowEndNovelty: sample.lowEndNovelty,
  broadbandNovelty: sample.broadbandNovelty,
  spectralNovelty: sample.spectralNovelty,
  highFrequencyNovelty: sample.highFrequencyNovelty,
  combinedNovelty: sample.combinedNovelty,
  adaptiveBaseline: sample.adaptiveBaseline || 0,
  adaptiveThreshold: sample.adaptiveThreshold || 0,
});

class AdaptiveNoveltyChannel {
  constructor(config) {
    this.config = config;
    this.baseline = 0;
    this.deviation = 0.02;
    this.initialized = false;
  }

  update(rawValue, deltaSeconds) {
    const raw = clamp01(rawValue);
    const dt = Math.max(0.001, Math.min(0.25, finite(deltaSeconds, 0.025)));
    if (!this.initialized) {
      this.baseline = raw;
      this.deviation = Math.max(0.02, raw * 0.25);
      this.initialized = true;
    }
    const baselineAlpha = 1 - Math.exp(-dt / this.config.noveltyBaselineSeconds);
    const deviationAlpha = 1 - Math.exp(-dt / this.config.noveltyDeviationSeconds);
    const priorBaseline = this.baseline;
    this.baseline += (raw - this.baseline) * baselineAlpha;
    this.deviation += (Math.abs(raw - priorBaseline) - this.deviation) * deviationAlpha;
    const floor = Math.max(0.025, this.deviation * 0.8);
    const adaptive = (raw - this.baseline * 0.62) / (floor * 3.2 + 0.055);
    return clamp01(adaptive);
  }

  reset() {
    this.baseline = 0;
    this.deviation = 0.02;
    this.initialized = false;
  }
}

/**
 * Produces continuous, time-based multi-band rhythm novelty for every audio update.
 * It deliberately does not classify instruments or require a discrete BeatCandidate.
 */
export class RhythmNoveltyTracker {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this.channels = Object.fromEntries(
      ['lowEnd', 'broadband', 'spectral', 'high'].map((name) => [name, new AdaptiveNoveltyChannel(this.config)]),
    );
    this.reset();
  }

  reset() {
    for (const channel of Object.values(this.channels)) channel.reset();
    this.previous = {
      lowEnergy: 0, lowImpact: 0, flux: 0, spectralChange: 0,
      transient: 0, mid: 0, highMid: 0, high: 0,
    };
    this.lastTimestamp = 0;
    this.history = [];
    this.lastSnapshot = freezeSample({
      timestamp: 0,
      lowEndNovelty: 0,
      broadbandNovelty: 0,
      spectralNovelty: 0,
      highFrequencyNovelty: 0,
      combinedNovelty: 0,
    });
    return this.lastSnapshot;
  }

  update(audioSnapshot = {}, timestamp = audioSnapshot.timestamp || 0) {
    const now = Math.max(0, finite(timestamp));
    const dt = this.lastTimestamp ? Math.max(0.001, (now - this.lastTimestamp) / 1000) : 0.025;
    const silent = ['silence', 'no-source', 'stale', 'ended', 'error'].includes(audioSnapshot.signalState);
    const values = {
      lowEnergy: featureValue(audioSnapshot.lowEnd?.totalEnergy),
      lowImpact: featureValue(audioSnapshot.lowEnd?.impact?.value),
      lowTransient: featureValue(audioSnapshot.lowEnd?.transient),
      flux: featureValue(audioSnapshot.spectrum?.flux),
      spectralChange: featureValue(audioSnapshot.spectrum?.change),
      transient: featureValue(audioSnapshot.transient?.strength),
      transientConfidence: featureValue(audioSnapshot.transient?.confidence),
      mid: featureValue(audioSnapshot.bands?.mid),
      highMid: featureValue(audioSnapshot.bands?.highMid),
      high: featureValue(audioSnapshot.bands?.high),
    };

    const lowRaw = silent ? 0 : clamp01(
      values.lowImpact * 0.42
      + values.lowTransient * 0.20
      + positiveDelta(values.lowEnergy, this.previous.lowEnergy) * 1.55
      + positiveDelta(values.lowImpact, this.previous.lowImpact) * 0.55,
    );
    const broadbandRaw = silent ? 0 : clamp01(
      values.transient * 0.35
      + values.transientConfidence * 0.12
      + values.flux * 0.30
      + values.spectralChange * 0.23,
    );
    const spectralRaw = silent ? 0 : clamp01(
      values.flux * 0.48
      + values.spectralChange * 0.32
      + positiveDelta(values.mid, this.previous.mid) * 0.55
      + positiveDelta(values.highMid, this.previous.highMid) * 0.40,
    );
    const highRaw = silent ? 0 : clamp01(
      positiveDelta(values.high, this.previous.high) * 0.85
      + positiveDelta(values.highMid, this.previous.highMid) * 0.65
      + values.flux * 0.22
      + values.transient * 0.18,
    );

    const lowEndNovelty = this.channels.lowEnd.update(lowRaw, dt);
    const broadbandNovelty = this.channels.broadband.update(broadbandRaw, dt);
    const spectralNovelty = this.channels.spectral.update(spectralRaw, dt);
    const highFrequencyNovelty = this.channels.high.update(highRaw, dt);
    const ordered = [lowEndNovelty, broadbandNovelty, spectralNovelty, highFrequencyNovelty]
      .sort((a, b) => b - a);
    const combinedNovelty = silent ? 0 : clamp01(
      lowEndNovelty * 0.30
      + broadbandNovelty * 0.30
      + spectralNovelty * 0.22
      + highFrequencyNovelty * 0.18
      + ordered[0] * 0.16
      + ordered[1] * 0.08,
    );
    const channelValues = Object.values(this.channels);
    const adaptiveBaseline = channelValues.reduce((sum, channel) => sum + channel.baseline, 0)
      / channelValues.length;
    const adaptiveThreshold = channelValues.reduce(
      (sum, channel) => sum + channel.baseline + channel.deviation,
      0,
    ) / channelValues.length;

    this.previous = {
      lowEnergy: values.lowEnergy,
      lowImpact: values.lowImpact,
      flux: values.flux,
      spectralChange: values.spectralChange,
      transient: values.transient,
      mid: values.mid,
      highMid: values.highMid,
      high: values.high,
    };
    this.lastTimestamp = now;
    this.lastSnapshot = freezeSample({
      timestamp: now,
      lowEndNovelty,
      broadbandNovelty,
      spectralNovelty,
      highFrequencyNovelty,
      combinedNovelty,
      adaptiveBaseline: clamp01(adaptiveBaseline),
      adaptiveThreshold: clamp01(adaptiveThreshold),
    });
    this.history.push(this.lastSnapshot);
    const cutoff = now - this.config.noveltyHistoryMs;
    while (this.history.length && this.history[0].timestamp < cutoff) this.history.shift();
    return this.lastSnapshot;
  }

  getHistory({ since = -Infinity } = {}) {
    return this.history.filter((sample) => sample.timestamp >= since);
  }
}
