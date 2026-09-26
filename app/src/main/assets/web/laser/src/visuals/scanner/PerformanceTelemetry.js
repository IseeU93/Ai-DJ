const clampSample = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

export function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export class PerformanceTelemetry {
  constructor({ windowSize = 240 } = {}) {
    this._windowSize = Math.max(8, Math.round(windowSize));
    this._series = new Map();
  }

  record(name, durationMs) {
    const samples = this._series.get(name) || [];
    samples.push(clampSample(Number(durationMs)));
    if (samples.length > this._windowSize) samples.splice(0, samples.length - this._windowSize);
    this._series.set(name, samples);
    return durationMs;
  }

  reset(name = null) {
    if (name === null) this._series.clear();
    else this._series.delete(name);
  }

  measure(name, callback, now = () => performance.now()) {
    const startedAt = now();
    const value = callback();
    this.record(name, now() - startedAt);
    return value;
  }

  get(name) {
    const samples = this._series.get(name) || [];
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
      count: samples.length,
      lastMs: samples.length ? samples[samples.length - 1] : 0,
      averageMs: samples.length ? total / samples.length : 0,
      p95Ms: percentile(samples, 0.95),
    };
  }

  snapshot() {
    const result = {};
    this._series.forEach((_samples, name) => { result[name] = this.get(name); });
    return result;
  }
}
