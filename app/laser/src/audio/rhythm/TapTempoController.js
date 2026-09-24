import { normalizeRhythmConfig } from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export class TapTempoController {
  constructor(config = {}) {
    this.config = normalizeRhythmConfig(config);
    this.reset();
  }

  reset() {
    this._taps = [];
    this.bpm = 0;
    this.confidence = 0;
    this.validIntervalCount = 0;
    return this.getSnapshot();
  }

  tap(timestamp = 0) {
    const now = Math.max(0, finite(timestamp));
    if (this._taps.length && now - this._taps.at(-1) > 2_500) this.reset();
    if (!this._taps.length || now > this._taps.at(-1)) this._taps.push(now);
    if (this._taps.length > 10) this._taps.shift();
    this._recalculate();
    return this.getSnapshot();
  }

  setManualBpm(bpm) {
    const value = finite(bpm, 120);
    this.bpm = Math.max(this.config.minBpm, Math.min(this.config.maxBpm, value));
    this.confidence = 1;
    this.validIntervalCount = 0;
    return this.getSnapshot();
  }

  getSnapshot() {
    return Object.freeze({
      tapCount: this._taps.length,
      bpm: Math.round(this.bpm * 100) / 100,
      confidence: clamp01(this.confidence),
      validIntervalCount: this.validIntervalCount,
      ready: this._taps.length >= 4 && this.bpm > 0,
    });
  }

  _recalculate() {
    if (this._taps.length < 4) {
      this.bpm = 0;
      this.confidence = 0;
      this.validIntervalCount = 0;
      return;
    }
    const minimumInterval = 60_000 / this.config.maxBpm;
    const maximumInterval = 60_000 / this.config.minBpm;
    const intervals = [];
    for (let index = 1; index < this._taps.length; index++) {
      const interval = this._taps[index] - this._taps[index - 1];
      if (interval >= minimumInterval && interval <= maximumInterval) intervals.push(interval);
    }
    if (intervals.length < 3) {
      this.bpm = 0;
      this.confidence = 0;
      this.validIntervalCount = intervals.length;
      return;
    }
    const center = median(intervals);
    const deviations = intervals.map((interval) => Math.abs(interval - center));
    const mad = median(deviations);
    const tolerance = Math.max(55, mad * 3.5);
    const filtered = intervals.filter((interval) => Math.abs(interval - center) <= tolerance);
    if (filtered.length < 2) return;
    const robustInterval = median(filtered);
    this.bpm = Math.max(this.config.minBpm, Math.min(this.config.maxBpm, 60_000 / robustInterval));
    this.validIntervalCount = filtered.length;
    const dispersion = median(filtered.map((interval) => Math.abs(interval - robustInterval))) / robustInterval;
    this.confidence = clamp01((filtered.length / intervals.length) * (1 - dispersion / 0.08));
  }
}
