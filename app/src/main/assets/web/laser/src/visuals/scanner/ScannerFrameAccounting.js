import { PerformanceTelemetry } from './PerformanceTelemetry.js';

const clampNonNegative = (value) => Number.isFinite(value) ? Math.max(0, value) : 0;

export class ScannerFrameAccounting {
  constructor({ expectedDisplayFps = 60, windowSize = 900 } = {}) {
    this._expectedDisplayFps = Math.max(1, Number(expectedDisplayFps) || 60);
    this._expectedDisplayIntervalMs = 1000 / this._expectedDisplayFps;
    this._windowSize = Math.max(16, Math.round(Number(windowSize) || 900));
    this.reset();
  }

  setExpectedDisplayFps(expectedDisplayFps = 60) {
    this._expectedDisplayFps = Math.max(1, Number(expectedDisplayFps) || 60);
    this._expectedDisplayIntervalMs = 1000 / this._expectedDisplayFps;
    this.reset();
  }

  reset() {
    this._telemetry = new PerformanceTelemetry({ windowSize: this._windowSize });
    this._backgroundTelemetry = new PerformanceTelemetry({ windowSize: this._windowSize });
    this._lastRafTimestampMs = null;
    this._pending = null;
    this._renderedFrames = 0;
    this._rafCallbacks = 0;
    this._naturalSkippedFrames = 0;
    this._callbacksWithSkip = 0;
    this._foregroundRafCallbacks = 0;
    this._hiddenRafCallbacks = 0;
    this._foregroundRenderedFrames = 0;
    this._hiddenRenderedFrames = 0;
    this._hiddenSkippedIntervals = 0;
    this._syntheticSuppressedFrames = 0;
    this._negativeUnaccountedFrames = 0;
    this._last = this._emptyLast();
  }

  recordFrame({ rafTimestampMs, rendered = true, syntheticSuppressed = false,
    artificialTestDelayMs = 0, components = {}, visibilityState = 'visible' } = {}) {
    const timestamp = Number(rafTimestampMs);
    const validTimestamp = Number.isFinite(timestamp) ? timestamp : (this._lastRafTimestampMs ?? 0);
    const rawIntervalMs = this._lastRafTimestampMs === null ? 0 : Math.max(0, validTimestamp - this._lastRafTimestampMs);
    if (this._pending && rawIntervalMs > 0) this._commitInterval(rawIntervalMs, this._pending);
    this._lastRafTimestampMs = validTimestamp;
    this._rafCallbacks++;
    if (rendered) this._renderedFrames++;
    if (syntheticSuppressed) this._syntheticSuppressedFrames++;
    this._pending = {
      rendered: Boolean(rendered), syntheticSuppressed: Boolean(syntheticSuppressed),
      artificialTestDelayMs: clampNonNegative(Number(artificialTestDelayMs)),
      components: this._normalizeComponents(components),
      visibilityState: visibilityState === 'hidden' ? 'hidden' : 'visible',
    };
    return this.snapshot();
  }

  markVisibilityChange(rafTimestampMs = null) {
    const timestamp = Number(rafTimestampMs);
    this._lastRafTimestampMs = Number.isFinite(timestamp) ? timestamp : null;
    this._pending = null;
  }

  snapshot() {
    const callbackSkipRate = this._foregroundRafCallbacks > 0
      ? this._callbacksWithSkip / this._foregroundRafCallbacks
      : 0;
    const skippedIntervalsPerCallback = this._foregroundRafCallbacks > 0
      ? this._naturalSkippedFrames / this._foregroundRafCallbacks
      : 0;
    return {
      expectedDisplayIntervalMs: this._expectedDisplayIntervalMs,
      assumedDisplayFps: this._expectedDisplayFps,
      rafCallbacks: this._rafCallbacks, renderedFrames: this._renderedFrames,
      naturalSkippedFrames: this._naturalSkippedFrames,
      naturalSkippedFramesTotal: this._naturalSkippedFrames,
      skippedIntervals: this._naturalSkippedFrames,
      callbacksWithSkip: this._callbacksWithSkip,
      totalRafCallbacks: this._foregroundRafCallbacks,
      allRafCallbacks: this._rafCallbacks,
      foregroundRafCallbacks: this._foregroundRafCallbacks,
      hiddenRafCallbacks: this._hiddenRafCallbacks,
      foregroundRenderedFrames: this._foregroundRenderedFrames,
      hiddenRenderedFrames: this._hiddenRenderedFrames,
      hiddenSkippedIntervals: this._hiddenSkippedIntervals,
      skippedIntervalsPerCallback,
      callbackSkipRate,
      syntheticSuppressedFrames: this._syntheticSuppressedFrames,
      negativeUnaccountedFrames: this._negativeUnaccountedFrames,
      last: { ...this._last },
      timings: this._telemetry.snapshot(),
      backgroundTimings: this._backgroundTelemetry.snapshot(),
    };
  }

  _commitInterval(rawIntervalMs, pending) {
    const artificialTestDelayMs = pending.artificialTestDelayMs;
    const components = pending.components;
    const cpuFrameWorkMs = Object.values(components).reduce((sum, value) => sum + value, 0);
    const adjustedDisplayIntervalMs = Math.max(0, rawIntervalMs - artificialTestDelayMs);
    const naturalSkippedFrames = pending.syntheticSuppressed ? 0 :
      Math.max(0, Math.round(adjustedDisplayIntervalMs / this._expectedDisplayIntervalMs) - 1);
    const rawUnaccountedTimeMs = rawIntervalMs - cpuFrameWorkMs - artificialTestDelayMs;
    const unaccountedTimeMs = Math.max(0, rawUnaccountedTimeMs);
    const foreground = pending.visibilityState !== 'hidden';
    const telemetry = foreground ? this._telemetry : this._backgroundTelemetry;
    if (foreground) {
      this._foregroundRafCallbacks++;
      if (pending.rendered) this._foregroundRenderedFrames++;
      this._naturalSkippedFrames += naturalSkippedFrames;
      if (naturalSkippedFrames > 0) this._callbacksWithSkip++;
      if (rawUnaccountedTimeMs < -0.01) this._negativeUnaccountedFrames++;
    } else {
      this._hiddenRafCallbacks++;
      if (pending.rendered) this._hiddenRenderedFrames++;
      this._hiddenSkippedIntervals += naturalSkippedFrames;
    }
    telemetry.record('rafInterval', rawIntervalMs);
    telemetry.record('artificialTestDelay', artificialTestDelayMs);
    telemetry.record('cpuFrameWork', cpuFrameWorkMs);
    telemetry.record('unaccountedTime', unaccountedTimeMs);
    Object.entries(components).forEach(([name, value]) => telemetry.record(name, value));
    this._last = {
      rafIntervalMs: rawIntervalMs, artificialTestDelayMs, cpuFrameWorkMs, unaccountedTimeMs,
      rawUnaccountedTimeMs, naturalSkippedFrames,
      syntheticSuppressed: pending.syntheticSuppressed, rendered: pending.rendered, ...components,
      visibilityState: pending.visibilityState,
    };
  }

  _normalizeComponents(components) {
    return {
      snapshotMs: clampNonNegative(Number(components.snapshotMs)),
      geometryMs: clampNonNegative(Number(components.geometryMs)),
      planningMs: clampNonNegative(Number(components.planningMs)),
      pointVisitMs: clampNonNegative(Number(components.pointVisitMs)),
      exposureCanvasMs: clampNonNegative(Number(components.exposureCanvasMs)),
      diagnosticsDomMs: clampNonNegative(Number(components.diagnosticsDomMs)),
      renderOtherMs: clampNonNegative(Number(components.renderOtherMs)),
    };
  }

  _emptyLast() {
    return {
      rafIntervalMs: 0, artificialTestDelayMs: 0, cpuFrameWorkMs: 0,
      unaccountedTimeMs: 0, rawUnaccountedTimeMs: 0, naturalSkippedFrames: 0,
      syntheticSuppressed: false, rendered: false, snapshotMs: 0, geometryMs: 0,
      planningMs: 0, pointVisitMs: 0, exposureCanvasMs: 0, diagnosticsDomMs: 0,
      renderOtherMs: 0, visibilityState: 'visible',
    };
  }
}
