const QUALITY_LEVELS = Object.freeze([
  Object.freeze({
    name: 'full', geometryScale: 1, fanPathScale: 1, exposureScale: 1,
    trailScale: 1, uiIntervalMs: 250,
  }),
  Object.freeze({
    name: 'balanced', geometryScale: 1, fanPathScale: 1, exposureScale: 0.85,
    trailScale: 0.88, uiIntervalMs: 333,
  }),
  Object.freeze({
    name: 'reduced', geometryScale: 0.65, fanPathScale: 0.75, exposureScale: 0.7,
    trailScale: 0.72, uiIntervalMs: 500,
  }),
  Object.freeze({
    name: 'survival', geometryScale: 0.45, fanPathScale: 0.5, exposureScale: 0.55,
    trailScale: 0.58, uiIntervalMs: 750,
  }),
]);

export class AdaptiveQualityController {
  constructor({ minimumHoldMs = 1500, recoveryHoldMs = 6000 } = {}) {
    this._minimumHoldMs = Math.max(0, Number(minimumHoldMs) || 0);
    this._recoveryHoldMs = Math.max(this._minimumHoldMs, Number(recoveryHoldMs) || 0);
    this.reset();
  }

  reset(nowMs = 0, startLevel = 'full') {
    const requestedIndex = QUALITY_LEVELS.findIndex((level) => level.name === startLevel);
    this._index = requestedIndex >= 0 ? requestedIndex : 0;
    this._lastSwitchAtMs = Number(nowMs) || 0;
    this._healthySinceMs = null;
    this._lastReason = 'initial';
    this._switches = 0;
    this._lastNowMs = Number(nowMs) || 0;
    this._lastPressureAtMs = null;
    this._currentPressureSources = [];
    this._recoveryConditions = {};
  }

  update(metrics = {}, nowMs = 0) {
    const now = Math.max(this._lastSwitchAtMs, Number(nowMs) || 0);
    this._lastNowMs = now;
    const pressureSources = this._pressureSources(metrics);
    const reason = pressureSources[0] || null;
    const heldFor = now - this._lastSwitchAtMs;
    this._currentPressureSources = pressureSources;
    this._recoveryConditions = this._recoveryState(metrics);

    if (reason) {
      this._healthySinceMs = null;
      this._lastPressureAtMs = now;
      this._lastReason = reason;
      if (this._index < QUALITY_LEVELS.length - 1 && heldFor >= this._minimumHoldMs) {
        this._index++;
        this._lastSwitchAtMs = now;
        this._switches++;
      }
    } else if (this._isHealthy(metrics)) {
      if (this._healthySinceMs === null) this._healthySinceMs = now;
      if (this._index > 0 && heldFor >= this._minimumHoldMs &&
          now - this._healthySinceMs >= this._recoveryHoldMs) {
        this._index--;
        this._lastSwitchAtMs = now;
        this._healthySinceMs = now;
        this._lastReason = 'stable-recovery';
        this._switches++;
      }
    } else {
      this._healthySinceMs = null;
    }

    return this.getState();
  }

  getState() {
    const now = this._lastNowMs;
    const heldForMs = Math.max(0, now - this._lastSwitchAtMs);
    const healthyForMs = this._healthySinceMs === null ? 0 : Math.max(0, now - this._healthySinceMs);
    const remainingMinimumHoldMs = Math.max(0, this._minimumHoldMs - heldForMs);
    const recoveryConditionsHealthy = Object.values(this._recoveryConditions).every(Boolean);
    const recoveryEligible = this._index > 0 && this._currentPressureSources.length === 0 &&
      recoveryConditionsHealthy;
    const remainingRecoveryMs = recoveryEligible ? Math.max(
      remainingMinimumHoldMs,
      this._recoveryHoldMs - healthyForMs,
    ) : null;
    const blockingRecoveryConditions = Object.entries(this._recoveryConditions)
      .filter(([, healthy]) => !healthy)
      .map(([condition]) => condition);
    return {
      index: this._index,
      ...QUALITY_LEVELS[this._index],
      lastReason: this._lastReason,
      lastSwitchAtMs: this._lastSwitchAtMs,
      switches: this._switches,
      pressureSources: [...this._currentPressureSources],
      lastPressureAtMs: this._lastPressureAtMs,
      timeSinceLastPressureMs: this._lastPressureAtMs === null ? null : Math.max(0, now - this._lastPressureAtMs),
      remainingMinimumHoldMs,
      recoveryConditions: { ...this._recoveryConditions },
      recoveryEligible,
      recoveryWindowHealthy: recoveryConditionsHealthy,
      blockingRecoveryConditions,
      recoveryBlockedReason: this._index === 0
        ? null
        : this._currentPressureSources[0] || blockingRecoveryConditions[0] || null,
      nextRecoveryAtMs: this._index === 0 || remainingRecoveryMs === null
        ? null
        : now + remainingRecoveryMs,
    };
  }

  _pressureSources(metrics) {
    const sources = [];
    if ((Number(metrics.motionViolations) || 0) > 0) sources.push('motion-violation');
    if (metrics.finalBudgetExceeded) sources.push('point-budget');
    if (metrics.syntheticPressure) sources.push('synthetic-test-load');
    if (!metrics.backgroundThrottled || metrics.includeBackgroundPressure) {
      const skipRate = typeof metrics.naturalSkipRateWindow === 'number'
        ? metrics.naturalSkipRateWindow
        : NaN;
      if (Number.isFinite(skipRate) && skipRate >= 0.15) sources.push('natural-skip-rate-window');
      if ((Number(metrics.rafP95Window) || 0) > 50) sources.push('raf-p95-window');
      if ((Number(metrics.renderP95Window ?? metrics.renderP95Ms) || 0) > 16) {
        sources.push('render-p95-window');
      }
      if ((Number(metrics.planningP95Window ?? metrics.planningP95Ms) || 0) > 6) {
        sources.push('planning-p95-window');
      }
    }
    return sources;
  }

  _isHealthy(metrics) {
    return Object.values(this._recoveryState(metrics)).every(Boolean);
  }

  _recoveryState(metrics) {
    const skipRate = typeof metrics.naturalSkipRateWindow === 'number'
      ? metrics.naturalSkipRateWindow
      : NaN;
    const hasExplicitWindow = Number.isFinite(skipRate) || metrics.foregroundSampleSufficient !== undefined;
    return {
      finalBudgetHealthy: !metrics.finalBudgetExceeded,
      motionHealthy: (Number(metrics.motionViolations) || 0) === 0,
      foregroundVisible: !metrics.backgroundThrottled,
      foregroundWindowAvailable: hasExplicitWindow
        ? Boolean(metrics.foregroundSampleSufficient)
        : true,
      naturalFramesHealthy: hasExplicitWindow
        ? Number.isFinite(skipRate) && skipRate <= 0.05
        : (Number(metrics.naturalSkippedFramesWindow) || 0) === 0,
      rafWindowHealthy: hasExplicitWindow
        ? (Number(metrics.rafP95Window) || Infinity) <= 34.4
        : true,
      renderHealthy: (Number(metrics.renderP95Window ?? metrics.renderP95Ms) || 0) < 10,
      planningHealthy: (Number(metrics.planningP95Window ?? metrics.planningP95Ms) || 0) < 3.5,
      syntheticLoadInactive: !metrics.syntheticLoadActive,
    };
  }
}

export { QUALITY_LEVELS };
