import { percentile } from './PerformanceTelemetry.js';

export const SCANNER_TEST_MODES = Object.freeze({
  REAL: 'real-performance',
  STRESS: 'synthetic-stress',
});

const DEFAULT_TARGET_FPS = Object.freeze([60, 45, 30, 24, 10]);
const DEFAULT_DELAYS_MS = Object.freeze([0, 4, 8, 12, 16]);

export class ScannerLoadTest {
  constructor({ memoryReader = null } = {}) {
    this._memoryReader = memoryReader;
    this.reset();
  }

  start({
    startShowTime = 0,
    durationSeconds = 900,
    seed = 0x15a5e,
    mode = SCANNER_TEST_MODES.REAL,
    phaseDurationSeconds = 15,
    effectPhaseDurationSeconds = 30,
    targetFpsSchedule = DEFAULT_TARGET_FPS,
    artificialDelayScheduleMs = DEFAULT_DELAYS_MS,
  } = {}) {
    this.reset();
    this._active = true;
    this._mode = mode === SCANNER_TEST_MODES.STRESS
      ? SCANNER_TEST_MODES.STRESS
      : SCANNER_TEST_MODES.REAL;
    this._startShowTime = Number(startShowTime) || 0;
    this._durationSeconds = Math.max(1, Number(durationSeconds) || 900);
    this._phaseDurationSeconds = Math.max(1, Number(phaseDurationSeconds) || 15);
    this._effectPhaseDurationSeconds = Math.max(1, Number(effectPhaseDurationSeconds) || 30);
    this._seed = Number(seed) >>> 0;
    this._targetFpsSchedule = this._normalizeSchedule(targetFpsSchedule, DEFAULT_TARGET_FPS, 1);
    this._artificialDelayScheduleMs = this._normalizeSchedule(
      artificialDelayScheduleMs,
      DEFAULT_DELAYS_MS,
      0,
    );
    this._memoryStart = this._readMemory();
    return this.getState(this._startShowTime);
  }

  reset() {
    this._active = false;
    this._mode = SCANNER_TEST_MODES.REAL;
    this._startShowTime = 0;
    this._durationSeconds = 900;
    this._phaseDurationSeconds = 15;
    this._effectPhaseDurationSeconds = 30;
    this._seed = 0;
    this._targetFpsSchedule = [...DEFAULT_TARGET_FPS];
    this._artificialDelayScheduleMs = [...DEFAULT_DELAYS_MS];
    this._lastSyntheticRenderAtMs = null;
    this._lastDirective = null;
    this._frameDurationsMs = [];
    this._clockDeltas = [];
    this._rafCallbacks = 0;
    this._renderedFrames = 0;
    this._naturalSkippedFrames = 0;
    this._syntheticSuppressedFrames = 0;
    this._artificialDelayMs = 0;
    this._motionViolations = 0;
    this._motionViolationDetails = [];
    this._countedViolationCycles = new Set();
    this._countedBudgetCycles = new Set();
    this._budget = this._emptyBudget();
    this._lostSnapshots = 0;
    this._memoryStart = null;
    this._memoryEnd = null;
    this._summary = null;
    this._qualitySwitches = 0;
    this._lastQuality = null;
    this._effectSwitches = 0;
    this._lastEffect = null;
    this._latestDiagnostics = {};
    this._lastTestLoadActive = false;
    this._lastTestUsedSyntheticLoad = false;
    this._foregroundSamples = 0;
    this._hiddenSamples = 0;
    this._environmentStart = null;
    this._latestEnvironment = null;
    this._effectMeasurements = new Map();
  }

  getState(showTime, _epochMs = null) {
    const elapsed = Math.max(0, Number(showTime) - this._startShowTime);
    if (this._active && elapsed >= this._durationSeconds) this.finish(showTime);
    const phaseIndex = Math.floor(elapsed / this._phaseDurationSeconds);
    const testPhase = Math.floor(elapsed / this._effectPhaseDurationSeconds);
    const effect = testPhase % 2 === 0 ? 'scanner' : 'lissajous';
    const synthetic = this._active && this._mode === SCANNER_TEST_MODES.STRESS;
    const profileIndex = phaseIndex % this._targetFpsSchedule.length;
    const resultValidity = this._resultValidity();
    return {
      active: this._active,
      mode: this._mode,
      syntheticLoadActive: synthetic,
      lastTestLoadActive: this._lastTestLoadActive,
      lastTestUsedSyntheticLoad: this._lastTestUsedSyntheticLoad,
      elapsed,
      durationSeconds: this._durationSeconds,
      progress: Math.min(1, elapsed / this._durationSeconds),
      targetFps: synthetic ? this._targetFpsSchedule[profileIndex] : null,
      artificialLoadMs: synthetic ? this._artificialDelayScheduleMs[
        phaseIndex % this._artificialDelayScheduleMs.length
      ] : 0,
      effect,
      testPhase,
      stressPhase: synthetic ? phaseIndex : null,
      seed: this._seed,
      naturalSkippedFrames: this._naturalSkippedFrames,
      syntheticSuppressedFrames: this._syntheticSuppressedFrames,
      resultValidity,
      backgroundObserved: this._hiddenSamples > 0,
      visibilityState: this._latestEnvironment?.visibilityState || 'unknown',
    };
  }

  nextFrame(showTime, rafTimestampMs) {
    const state = this.getState(showTime, rafTimestampMs);
    let shouldRender = true;
    if (state.syntheticLoadActive) {
      const minimumIntervalMs = 1000 / Math.max(1, state.targetFps);
      const elapsedSinceRender = this._lastSyntheticRenderAtMs === null
        ? Infinity
        : Number(rafTimestampMs) - this._lastSyntheticRenderAtMs;
      shouldRender = elapsedSinceRender + 0.05 >= minimumIntervalMs;
      if (shouldRender) this._lastSyntheticRenderAtMs = Number(rafTimestampMs);
    } else {
      this._lastSyntheticRenderAtMs = null;
    }
    this._lastDirective = {
      ...state,
      shouldRender,
      syntheticSuppressed: state.syntheticLoadActive && !shouldRender,
      artificialLoadMs: shouldRender ? state.artificialLoadMs : 0,
    };
    return { ...this._lastDirective };
  }

  recordFrame(frameAccounting = {}, diagnostics = {}, environment = {}) {
    if (!this._active) return;
    const accounting = frameAccounting || {};
    const last = accounting.last || {};
    const intervalMs = Number(last.rafIntervalMs);
    if (last.visibilityState !== 'hidden' && Number.isFinite(intervalMs) && intervalMs > 0) {
      this._frameDurationsMs.push(intervalMs);
      if (this._frameDurationsMs.length > 60000) this._frameDurationsMs.shift();
    }
    this._rafCallbacks = Math.max(
      this._rafCallbacks,
      Number(accounting.foregroundRafCallbacks ?? accounting.rafCallbacks) || 0,
    );
    this._renderedFrames = Math.max(
      this._renderedFrames,
      Number(accounting.foregroundRenderedFrames ?? accounting.renderedFrames) || 0,
    );
    this._naturalSkippedFrames = Math.max(
      this._naturalSkippedFrames,
      Number(accounting.naturalSkippedFrames) || 0,
    );
    this._syntheticSuppressedFrames = Math.max(
      this._syntheticSuppressedFrames,
      Number(accounting.syntheticSuppressedFrames) || 0,
    );
    this._artificialDelayMs += Math.max(0, Number(last.artificialTestDelayMs) || 0);
    if (Number.isFinite(diagnostics.clockDeltaMs)) this._clockDeltas.push(diagnostics.clockDeltaMs);
    this._recordBudget(diagnostics);

    const cycleId = diagnostics.cycleId ?? `frame-${this._rafCallbacks}`;
    const violations = Number(diagnostics.postBoundaryViolations) || 0;
    if (violations > 0 && !this._countedViolationCycles.has(cycleId)) {
      this._countedViolationCycles.add(cycleId);
      this._motionViolations += violations;
      const details = Array.isArray(diagnostics.violationDetails) ? diagnostics.violationDetails : [];
      this._motionViolationDetails.push(...details.slice(0, 8));
      if (this._motionViolationDetails.length > 32) this._motionViolationDetails.length = 32;
    }
    this._lostSnapshots = Math.max(this._lostSnapshots, Number(diagnostics.droppedSnapshots) || 0);
    if (diagnostics.adaptiveQuality && diagnostics.adaptiveQuality !== this._lastQuality) {
      if (this._lastQuality !== null) this._qualitySwitches++;
      this._lastQuality = diagnostics.adaptiveQuality;
    }
    if (diagnostics.effect && diagnostics.effect !== this._lastEffect) {
      if (this._lastEffect !== null) this._effectSwitches++;
      this._lastEffect = diagnostics.effect;
    }
    this._latestDiagnostics = diagnostics;
    this._latestEnvironment = environment ? { ...environment } : null;
    if (!this._environmentStart && environment) this._environmentStart = { ...environment };
    if (environment?.hidden) this._hiddenSamples++;
    else this._foregroundSamples++;
    this._recordEffectMeasurement(accounting, diagnostics, environment);
  }

  finish(showTime) {
    if (!this._active && this._summary) return this._summary;
    this._lastTestLoadActive = false;
    this._lastTestUsedSyntheticLoad = this._mode === SCANNER_TEST_MODES.STRESS;
    this._active = false;
    this._lastSyntheticRenderAtMs = null;
    this._memoryEnd = this._readMemory();
    const absoluteDeltas = this._clockDeltas.map(Math.abs);
    const durationSeconds = Math.max(0, Number(showTime) - this._startShowTime);
    const averageFrameMs = this._frameDurationsMs.length
      ? this._frameDurationsMs.reduce((sum, value) => sum + value, 0) / this._frameDurationsMs.length
      : 0;
    const timings = this._latestDiagnostics.frameAccounting?.timings || {};
    const accounting = this._latestDiagnostics.frameAccounting || {};
    const catchUp = this._latestDiagnostics.catchUpCumulative || null;
    const resultValidity = this._resultValidity();
    const catchUpErrors = catchUp ? [] : ['catch-up-unavailable'];
    if (catchUp) {
      for (const key of [
        'droppedExposureScannerTime', 'droppedExposureIntervals', 'droppedScannerPoints',
        'droppedShowEvents', 'maxProcessedScannerTimePerFrame',
        'maxProcessedPointsPerFrame', 'catchUpLimitHits',
      ]) {
        if (!Number.isFinite(Number(catchUp[key]))) {
          catchUpErrors.push(`catch-up-metric-unavailable:${key}`);
        }
      }
      if ((Number(catchUp.maxProcessedScannerTimePerFrame) || 0) > 0.050001) {
        catchUpErrors.push('max-processed-scanner-time-exceeded');
      }
      if ((Number(catchUp.maxProcessedPointsPerFrame) || 0) > 1500) {
        catchUpErrors.push('max-processed-points-exceeded');
      }
      if ((Number(catchUp.droppedShowEvents) || 0) !== 0) {
        catchUpErrors.push('dropped-show-events');
      }
    }
    this._summary = {
      mode: this._mode,
      durationSeconds,
      rafCallbacks: this._rafCallbacks,
      renderedFrames: this._renderedFrames,
      naturalSkippedFrames: this._naturalSkippedFrames,
      syntheticSuppressedFrames: this._syntheticSuppressedFrames,
      artificialTestDelayMs: this._artificialDelayMs,
      averageRafFps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
      minRafFps: this._frameDurationsMs.length ? 1000 / Math.max(...this._frameDurationsMs) : 0,
      p95RafIntervalMs: percentile(this._frameDurationsMs, 0.95),
      resultValidity,
      environmentLimited: resultValidity !== 'valid-foreground',
      visibility: this._visibilitySummary(),
      skippedIntervals: Number(accounting.skippedIntervals) || this._naturalSkippedFrames,
      callbacksWithSkip: Number(accounting.callbacksWithSkip) || 0,
      totalRafCallbacks: Number(accounting.totalRafCallbacks) || this._rafCallbacks,
      skippedIntervalsPerCallback: Number(accounting.skippedIntervalsPerCallback) || 0,
      callbackSkipRate: Number(accounting.callbackSkipRate) || 0,
      assumedDisplayFps: Number(accounting.assumedDisplayFps) || 60,
      negativeUnaccountedFrames: Number(accounting.negativeUnaccountedFrames) || 0,
      maxClockDeltaMs: absoluteDeltas.length ? Math.max(...absoluteDeltas) : 0,
      p95ClockDeltaMs: percentile(absoluteDeltas, 0.95),
      lostSnapshots: this._lostSnapshots,
      budget: { ...this._budget },
      finalOverBudgetEvents: this._budget.finalOverBudgetEvents,
      motionBoundaryViolations: this._motionViolations,
      motionViolationDetails: [...this._motionViolationDetails],
      qualitySwitches: this._qualitySwitches,
      effectSwitches: this._effectSwitches,
      byEffect: this._effectMeasurementSummary(),
      finalQuality: this._lastQuality,
      timingBreakdown: timings,
      healthWindow: this._latestDiagnostics.healthWindow || null,
      catchUp,
      catchUpErrors,
      droppedExposureScannerTime: catchUp?.droppedExposureScannerTime ?? null,
      droppedExposureIntervals: catchUp?.droppedExposureIntervals ?? null,
      droppedScannerPoints: catchUp?.droppedScannerPoints ?? null,
      droppedShowEvents: catchUp?.droppedShowEvents ?? null,
      maxProcessedScannerTimePerFrame: catchUp?.maxProcessedScannerTimePerFrame ?? null,
      maxProcessedPointsPerFrame: catchUp?.maxProcessedPointsPerFrame ?? null,
      catchUpLimitHits: catchUp?.catchUpLimitHits ?? null,
      memoryTrendBytes: this._memoryStart !== null && this._memoryEnd !== null
        ? this._memoryEnd - this._memoryStart
        : null,
      syntheticLoadStopped: true,
      // Compatibility aliases remain explicit and use natural values only.
      frames: this._renderedFrames,
      runtimeSkippedFrames: this._naturalSkippedFrames,
      skippedFrames: this._naturalSkippedFrames,
      averageFps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
      minFps: this._frameDurationsMs.length ? 1000 / Math.max(...this._frameDurationsMs) : 0,
      p95FrameMs: percentile(this._frameDurationsMs, 0.95),
      budgetOverruns: this._budget.finalOverBudgetEvents,
    };
    return this._summary;
  }

  getSummary() { return this._summary ? structuredClone(this._summary) : null; }

  _recordBudget(diagnostics) {
    const cycleId = diagnostics.cycleId;
    if (cycleId === null || cycleId === undefined || this._countedBudgetCycles.has(cycleId)) return;
    this._countedBudgetCycles.add(cycleId);
    const current = diagnostics.budgetCurrent || {};
    for (const key of [
      'prePlanOverBudgetEvents', 'replanAttempts', 'successfulReplans',
      'failedReplans', 'finalOverBudgetEvents',
    ]) this._budget[key] += Number(current[key]) || 0;
    this._budget.requestedPointCount = Number(current.requestedPointCount) || 0;
    this._budget.configuredBudget = Number(current.configuredBudget) || 0;
    this._budget.finalPointCount = Number(current.finalPointCount) || 0;
  }

  _emptyBudget() {
    return {
      requestedPointCount: 0,
      configuredBudget: 0,
      prePlanOverBudgetEvents: 0,
      replanAttempts: 0,
      successfulReplans: 0,
      failedReplans: 0,
      finalOverBudgetEvents: 0,
      finalPointCount: 0,
    };
  }

  _normalizeSchedule(values, fallback, minimum) {
    const normalized = Array.isArray(values)
      ? values.map(Number).filter(Number.isFinite).map((value) => Math.max(minimum, value))
      : [];
    return normalized.length ? normalized : [...fallback];
  }

  _readMemory() {
    const value = this._memoryReader?.();
    return Number.isFinite(value) ? value : null;
  }

  _recordEffectMeasurement(accounting, diagnostics, environment) {
    const effect = diagnostics?.effect;
    if (!['scanner', 'lissajous'].includes(effect)) return;
    if (!this._effectMeasurements.has(effect)) {
      this._effectMeasurements.set(effect, {
        foregroundCallbacks: 0,
        hiddenCallbacks: 0,
        renderedFrames: 0,
        skippedIntervals: 0,
        callbacksWithSkip: 0,
        rafIntervalsMs: [],
        cpuFrameWorkMs: [],
        renderMs: [],
        planningMs: [],
        maximumFinalPointCount: 0,
        finalOverBudgetEvents: 0,
        motionBoundaryViolations: 0,
      });
    }
    const target = this._effectMeasurements.get(effect);
    const last = accounting?.last || {};
    const hidden = Boolean(environment?.hidden || last.visibilityState === 'hidden');
    if (hidden) {
      target.hiddenCallbacks++;
    } else {
      target.foregroundCallbacks++;
      if (last.rendered) target.renderedFrames++;
      const skippedIntervals = Math.max(0, Number(last.naturalSkippedFrames) || 0);
      target.skippedIntervals += skippedIntervals;
      if (skippedIntervals > 0) target.callbacksWithSkip++;
      for (const [source, destination] of [
        ['rafIntervalMs', 'rafIntervalsMs'],
        ['cpuFrameWorkMs', 'cpuFrameWorkMs'],
      ]) {
        const value = Number(last[source]);
        if (Number.isFinite(value) && value >= 0) target[destination].push(value);
      }
      const renderMs = Number(diagnostics?.moduleTimings?.render?.lastMs);
      const planningMs = Number(diagnostics?.moduleTimings?.planning?.lastMs);
      if (Number.isFinite(renderMs) && renderMs >= 0) target.renderMs.push(renderMs);
      if (Number.isFinite(planningMs) && planningMs >= 0) target.planningMs.push(planningMs);
    }
    target.maximumFinalPointCount = Math.max(
      target.maximumFinalPointCount,
      Number(diagnostics?.finalPointCount) || 0,
    );
    target.finalOverBudgetEvents = Math.max(
      target.finalOverBudgetEvents,
      Number(diagnostics?.finalOverBudgetEvents) || 0,
    );
    target.motionBoundaryViolations = Math.max(
      target.motionBoundaryViolations,
      Number(diagnostics?.postBoundaryViolations) || 0,
    );
  }

  _effectMeasurementSummary() {
    const summary = {};
    for (const [effect, values] of this._effectMeasurements) {
      summary[effect] = {
        foregroundCallbacks: values.foregroundCallbacks,
        hiddenCallbacks: values.hiddenCallbacks,
        renderedFrames: values.renderedFrames,
        skippedIntervals: values.skippedIntervals,
        callbacksWithSkip: values.callbacksWithSkip,
        callbackSkipRate: values.foregroundCallbacks > 0
          ? values.callbacksWithSkip / values.foregroundCallbacks
          : null,
        skippedIntervalsPerCallback: values.foregroundCallbacks > 0
          ? values.skippedIntervals / values.foregroundCallbacks
          : null,
        averageRafFps: values.rafIntervalsMs.length
          ? 1000 / (values.rafIntervalsMs.reduce((sum, value) => sum + value, 0) /
            values.rafIntervalsMs.length)
          : null,
        p95RafIntervalMs: percentile(values.rafIntervalsMs, 0.95),
        p95CpuFrameWorkMs: percentile(values.cpuFrameWorkMs, 0.95),
        p95RenderMs: percentile(values.renderMs, 0.95),
        p95PlanningMs: percentile(values.planningMs, 0.95),
        maximumFinalPointCount: values.maximumFinalPointCount,
        finalOverBudgetEvents: values.finalOverBudgetEvents,
        motionBoundaryViolations: values.motionBoundaryViolations,
      };
    }
    return summary;
  }

  _resultValidity() {
    if (this._foregroundSamples === 0 && this._hiddenSamples === 0) return 'invalid-no-samples';
    if (this._hiddenSamples === 0) return 'valid-foreground';
    if (this._foregroundSamples > 0) return 'partially-invalid';
    return 'invalid-background-throttled';
  }

  _visibilitySummary() {
    const start = this._environmentStart || {};
    const latest = this._latestEnvironment || {};
    return {
      foregroundSamples: this._foregroundSamples,
      hiddenSamples: this._hiddenSamples,
      visibilityState: latest.visibilityState || 'unknown',
      hidden: Boolean(latest.hidden),
      visibleTimeMs: Math.max(0, (Number(latest.visibleTimeMs) || 0) - (Number(start.visibleTimeMs) || 0)),
      hiddenTimeMs: Math.max(0, (Number(latest.hiddenTimeMs) || 0) - (Number(start.hiddenTimeMs) || 0)),
      visibilityChanges: Math.max(0, (Number(latest.visibilityChanges) || 0) - (Number(start.visibilityChanges) || 0)),
      visibleRafFpsWindow: latest.visibleRafFpsWindow ?? null,
      hiddenRafFpsWindow: latest.hiddenRafFpsWindow ?? null,
      suspectedThrottling: latest.suspectedThrottling || 'unknown',
    };
  }
}
