import { percentile } from './PerformanceTelemetry.js';

const normalizeVisibility = (value) => value === 'hidden' ? 'hidden' : 'visible';

export class RuntimeEnvironmentMonitor {
  constructor({ nowMs = 0, visibilityState = 'visible', windowMs = 3000,
    userAgent = '', platform = '', devicePixelRatio = 1 } = {}) {
    this._windowMs = Math.max(1000, Number(windowMs) || 3000);
    this._visibilityState = normalizeVisibility(visibilityState);
    this._stateStartedAtMs = Math.max(0, Number(nowMs) || 0);
    this._visibleTimeMs = 0;
    this._hiddenTimeMs = 0;
    this._visibilityChanges = 0;
    this._lastRafTimestampMs = null;
    this._rafSamples = [];
    this._browser = {
      userAgent: String(userAgent || ''),
      platform: String(platform || ''),
      devicePixelRatio: Number.isFinite(Number(devicePixelRatio)) ? Number(devicePixelRatio) : 1,
    };
  }

  updateVisibility(visibilityState, nowMs = 0) {
    const next = normalizeVisibility(visibilityState);
    const now = Math.max(this._stateStartedAtMs, Number(nowMs) || 0);
    if (next === this._visibilityState) return this.snapshot(now);
    this._commitDuration(now);
    this._visibilityState = next;
    this._stateStartedAtMs = now;
    this._visibilityChanges++;
    this._lastRafTimestampMs = null;
    return this.snapshot(now);
  }

  recordRaf(timestampMs = 0) {
    const timestamp = Math.max(0, Number(timestampMs) || 0);
    const intervalMs = this._lastRafTimestampMs === null
      ? 0
      : Math.max(0, timestamp - this._lastRafTimestampMs);
    this._lastRafTimestampMs = timestamp;
    this._rafSamples.push({ timestampMs: timestamp, visibilityState: this._visibilityState, intervalMs });
    this._trim(timestamp);
    return this.snapshot(timestamp);
  }

  snapshot(nowMs = 0) {
    const now = Math.max(this._stateStartedAtMs, Number(nowMs) || 0);
    this._trim(now);
    let visibleTimeMs = this._visibleTimeMs;
    let hiddenTimeMs = this._hiddenTimeMs;
    if (this._visibilityState === 'hidden') hiddenTimeMs += now - this._stateStartedAtMs;
    else visibleTimeMs += now - this._stateStartedAtMs;
    const visibleIntervals = this._rafSamples
      .filter((sample) => sample.visibilityState === 'visible' && sample.intervalMs > 0)
      .map((sample) => sample.intervalMs);
    const hiddenIntervals = this._rafSamples
      .filter((sample) => sample.visibilityState === 'hidden' && sample.intervalMs > 0)
      .map((sample) => sample.intervalMs);
    const averageFps = (intervals) => intervals.length
      ? 1000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length)
      : null;
    const hidden = this._visibilityState === 'hidden';
    return {
      visibilityState: this._visibilityState,
      hidden,
      visibleTimeMs,
      hiddenTimeMs,
      visibilityChanges: this._visibilityChanges,
      visibleRafFpsWindow: averageFps(visibleIntervals),
      hiddenRafFpsWindow: averageFps(hiddenIntervals),
      visibleRafP95Window: percentile(visibleIntervals, 0.95),
      hiddenRafP95Window: percentile(hiddenIntervals, 0.95),
      suspectedThrottling: hidden ? 'background-throttled' : 'none',
      representativeForeground: !hidden,
      browser: { ...this._browser },
    };
  }

  _commitDuration(nowMs) {
    const duration = Math.max(0, nowMs - this._stateStartedAtMs);
    if (this._visibilityState === 'hidden') this._hiddenTimeMs += duration;
    else this._visibleTimeMs += duration;
  }

  _trim(nowMs) {
    const cutoff = nowMs - this._windowMs;
    while (this._rafSamples.length && this._rafSamples[0].timestampMs < cutoff) {
      this._rafSamples.shift();
    }
  }
}
