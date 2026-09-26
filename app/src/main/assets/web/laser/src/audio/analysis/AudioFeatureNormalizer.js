import { normalizeAudioAnalysisConfig } from './AudioAnalysisConfig.js';

export const NORMALIZED_AUDIO_FEATURES = Object.freeze([
  'rms', 'peak',
  'infraEnergy', 'subEnergy', 'lowBassEnergy', 'bassBodyEnergy', 'bassEnergy',
  'lowMidEnergy', 'midEnergy', 'highMidEnergy', 'highEnergy',
  'lowFrequencyEnergy', 'lowFrequencyImpact', 'lowEndSustained', 'lowEndTransient',
  'spectralFlux', 'spectralChange', 'transientStrength',
]);

const ABSOLUTE_FEATURES = new Set(['lowFrequencyImpact', 'lowEndTransient']);
const LOW_ENERGY_FEATURES = new Set([
  'infraEnergy', 'subEnergy', 'lowBassEnergy', 'bassBodyEnergy', 'bassEnergy',
  'lowFrequencyEnergy', 'lowEndSustained',
]);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const response = (deltaTime, seconds) => 1 - Math.exp(-Math.max(0, deltaTime) / Math.max(0.001, seconds));

const createState = () => ({
  initialized: false,
  noiseFloor: 0,
  typical: 0,
  peakReference: 0,
  smoothed: 0,
  observedSeconds: 0,
});

export class AudioFeatureNormalizer {
  constructor(config = {}) {
    this.config = normalizeAudioAnalysisConfig(config);
    this._states = new Map(NORMALIZED_AUDIO_FEATURES.map((key) => [key, createState()]));
    this._calibration = null;
  }

  reset() {
    this._states = new Map(NORMALIZED_AUDIO_FEATURES.map((key) => [key, createState()]));
    this._calibration = null;
  }

  resetCalibration() {
    this.reset();
    return this.getCalibrationStatus();
  }

  startCalibration(timestamp, durationMs = 10_000) {
    const startedAt = finite(timestamp);
    this._calibration = {
      active: true,
      startedAt,
      endsAt: startedAt + Math.max(1000, Math.min(60_000, finite(durationMs, 10_000))),
      features: Object.fromEntries(NORMALIZED_AUDIO_FEATURES.map((key) => [key, {
        count: 0, sum: 0, min: Infinity, max: 0,
      }])),
    };
    return this.getCalibrationStatus(startedAt);
  }

  getCalibrationStatus(timestamp = 0) {
    if (!this._calibration) return Object.freeze({ active: false, remainingMs: 0, values: Object.freeze({}) });
    const values = {};
    for (const [key, sample] of Object.entries(this._calibration.features)) {
      if (sample.count) values[key] = Object.freeze({
        noiseFloor: Number.isFinite(sample.min) ? sample.min : 0,
        typical: sample.sum / sample.count,
        peakReference: sample.max,
      });
    }
    return Object.freeze({
      active: this._calibration.active,
      remainingMs: this._calibration.active ? Math.max(0, this._calibration.endsAt - finite(timestamp)) : 0,
      values: Object.freeze(values),
    });
  }

  normalize(rawFeatures = {}, { deltaTime = 1 / this.config.updateHz, timestamp = 0, signalState = 'signal' } = {}) {
    const delta = Math.max(0, Math.min(1, finite(deltaTime, 1 / this.config.updateHz)));
    const output = {};
    const forcedDecay = ['no-source', 'stale', 'ended', 'error'].includes(signalState);
    for (const key of NORMALIZED_AUDIO_FEATURES) {
      const raw = Math.max(0, finite(Number(rawFeatures[key])));
      const state = this._states.get(key);
      if (!state.initialized) {
        state.initialized = true;
        state.noiseFloor = Math.min(raw * 0.1, this.config.silenceRms);
        state.typical = Math.max(raw, this.config.silenceRms * 8);
        state.peakReference = Math.max(raw * 1.5, state.typical * 2);
      }
      if (!forcedDecay) this._learn(state, raw, delta);
      state.observedSeconds += delta;
      const range = Math.max(
        state.typical * 1.8 - state.noiseFloor,
        state.peakReference * 0.72 - state.noiseFloor,
        this.config.silenceRms * 4,
      );
      const normalized = forcedDecay
        ? 0
        : ABSOLUTE_FEATURES.has(key)
          ? clamp01(raw)
          : clamp01((raw - state.noiseFloor) / range);
      const useImpactResponse = ABSOLUTE_FEATURES.has(key);
      const useLowEnergyResponse = LOW_ENERGY_FEATURES.has(key);
      const smoothingSeconds = normalized > state.smoothed
        ? useImpactResponse
          ? this.config.lowImpactAttackSeconds
          : useLowEnergyResponse ? this.config.lowEnergyAttackSeconds : this.config.attackSeconds
        : useImpactResponse
          ? this.config.lowImpactReleaseSeconds
          : useLowEnergyResponse ? this.config.lowEnergyReleaseSeconds : this.config.releaseSeconds;
      state.smoothed += (normalized - state.smoothed) * response(delta, smoothingSeconds);
      if (Math.abs(state.smoothed) < 1e-9) state.smoothed = 0;
      const confidence = clamp01(
        (state.observedSeconds / 3)
        * ((state.typical - state.noiseFloor) / Math.max(state.typical, this.config.silenceRms * 4)),
      );
      output[key] = Object.freeze({ raw, normalized, smoothed: clamp01(state.smoothed), confidence });
      this._collectCalibration(key, raw);
    }
    if (this._calibration?.active && finite(timestamp) >= this._calibration.endsAt) this._finishCalibration();
    return Object.freeze(output);
  }

  _learn(state, raw, delta) {
    const noiseTarget = raw < state.typical * 0.35 ? raw : state.noiseFloor;
    const noiseSeconds = noiseTarget < state.noiseFloor
      ? this.config.noiseFloorSeconds / 3
      : this.config.noiseFloorSeconds;
    state.noiseFloor += (noiseTarget - state.noiseFloor) * response(delta, noiseSeconds);

    if (raw > state.noiseFloor * 1.2) {
      state.typical += (raw - state.typical) * response(delta, this.config.typicalLevelSeconds);
    }
    const peakTarget = Math.max(state.typical * 1.8, raw);
    const peakSeconds = peakTarget > state.peakReference
      ? this.config.peakReferenceRiseSeconds
      : this.config.peakReferenceFallSeconds;
    state.peakReference += (peakTarget - state.peakReference) * response(delta, peakSeconds);
    state.peakReference = Math.max(state.peakReference, state.typical * 1.25, this.config.silenceRms * 8);
  }

  _collectCalibration(key, raw) {
    if (!this._calibration?.active) return;
    const sample = this._calibration.features[key];
    sample.count++;
    sample.sum += raw;
    sample.min = Math.min(sample.min, raw);
    sample.max = Math.max(sample.max, raw);
  }

  _finishCalibration() {
    for (const [key, sample] of Object.entries(this._calibration.features)) {
      if (!sample.count) continue;
      const state = this._states.get(key);
      const typical = sample.sum / sample.count;
      state.noiseFloor = Math.min(Number.isFinite(sample.min) ? sample.min : 0, typical * 0.35);
      state.typical = Math.max(typical, this.config.silenceRms * 4);
      state.peakReference = Math.max(state.typical * 1.5, Math.min(sample.max, state.typical * 4));
    }
    this._calibration.active = false;
  }
}
