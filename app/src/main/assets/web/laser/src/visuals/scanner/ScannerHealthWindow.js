import { percentile } from './PerformanceTelemetry.js';

const finiteNonNegative = (value) => Number.isFinite(Number(value))
  ? Math.max(0, Number(value))
  : 0;

export class ScannerHealthWindow {
  constructor({ windowMs = 3000, minimumForegroundSamples = 8 } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 3000);
    this.minimumForegroundSamples = Math.max(1, Math.round(minimumForegroundSamples));
    this.resetWindow();
  }

  record({ timestampMs, visibilityState = 'visible', rafIntervalMs = 0,
    skippedIntervals = 0, renderMs = 0, planningMs = 0 } = {}) {
    const timestamp = finiteNonNegative(timestampMs);
    this._samples.push({
      timestampMs: timestamp,
      visibilityState: visibilityState === 'hidden' ? 'hidden' : 'visible',
      rafIntervalMs: finiteNonNegative(rafIntervalMs),
      skippedIntervals: Math.max(0, Math.round(Number(skippedIntervals) || 0)),
      renderMs: finiteNonNegative(renderMs),
      planningMs: finiteNonNegative(planningMs),
    });
    this._trim(timestamp);
    return this.snapshot(timestamp);
  }

  resetWindow() {
    this._samples = [];
    this._lastResetAtMs = null;
  }

  snapshot(nowMs = null) {
    const now = Number.isFinite(Number(nowMs))
      ? Math.max(0, Number(nowMs))
      : (this._samples.at(-1)?.timestampMs ?? 0);
    this._trim(now);
    const visible = this._samples.filter((sample) => sample.visibilityState === 'visible');
    const hidden = this._samples.filter((sample) => sample.visibilityState === 'hidden');
    const callbacksWithSkip = visible.filter((sample) => sample.skippedIntervals > 0).length;
    const skippedIntervals = visible.reduce((sum, sample) => sum + sample.skippedIntervals, 0);
    const totalRafCallbacks = visible.length;
    const callbackSkipRate = totalRafCallbacks > 0 ? callbacksWithSkip / totalRafCallbacks : null;
    const skippedIntervalsPerCallback = totalRafCallbacks > 0
      ? skippedIntervals / totalRafCallbacks
      : null;
    const values = (name) => visible.map((sample) => sample[name]).filter(Number.isFinite);
    const foregroundSampleSufficient = totalRafCallbacks >= this.minimumForegroundSamples;
    const backgroundThrottled = hidden.length > 0 && totalRafCallbacks === 0;
    const rafP95Window = percentile(values('rafIntervalMs'), 0.95);
    const renderP95Window = percentile(values('renderMs'), 0.95);
    const planningP95Window = percentile(values('planningMs'), 0.95);
    const recoveryWindowHealthy = foregroundSampleSufficient && !backgroundThrottled &&
      callbackSkipRate <= 0.05 && rafP95Window <= 34.4 &&
      renderP95Window < 10 && planningP95Window < 3.5;
    return {
      windowMs: this.windowMs,
      totalRafCallbacks,
      callbacksWithSkip,
      skippedIntervals,
      callbackSkipRate,
      skippedIntervalsPerCallback,
      naturalSkippedFramesWindow: skippedIntervals,
      naturalSkipRateWindow: callbackSkipRate,
      rafP95Window,
      renderP95Window,
      planningP95Window,
      visibleSamples: visible.length,
      hiddenSamples: hidden.length,
      foregroundSampleSufficient,
      backgroundThrottled,
      recoveryWindowHealthy,
      lastResetAtMs: this._lastResetAtMs,
    };
  }

  markReset(timestampMs = 0) {
    this.resetWindow();
    this._lastResetAtMs = finiteNonNegative(timestampMs);
  }

  _trim(nowMs) {
    const cutoff = nowMs - this.windowMs;
    while (this._samples.length && this._samples[0].timestampMs < cutoff) this._samples.shift();
  }
}
