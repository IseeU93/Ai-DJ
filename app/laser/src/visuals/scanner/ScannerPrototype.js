import { LissajousPathGenerator } from './LissajousPathGenerator.js';
import { ScannerFanPathGenerator } from './ScannerFanPathGenerator.js';
import { VirtualScanner } from './VirtualScanner.js';
import { ScannerTestRenderer } from './ScannerTestRenderer.js';
import { PerformanceTelemetry } from './PerformanceTelemetry.js';

const rounded = (value, digits = 3) => Number((Number(value) || 0).toFixed(digits));
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

export class ScannerPrototype {
  constructor({ telemetry = null } = {}) {
    this._generators = {
      lissajous: new LissajousPathGenerator(),
      scanner: new ScannerFanPathGenerator(),
    };
    this._scanner = new VirtualScanner();
    this._renderer = new ScannerTestRenderer();
    this._telemetry = telemetry || new PerformanceTelemetry();
    this._activeEffect = null;
    this._lastStream = null;
    this._lastCycleIndex = null;
    this._geometryKey = null;
    this._scannerKey = null;
    this._paths = null;
    this._cycleGeneration = 0;
    this._resetToken = 0;
    this._externalResetToken = null;
    this._qualityName = 'full';
    this._exposureSceneKey = null;
    this._loggedViolationCycles = new Set();
    this._plans = 0;
    this._cacheHits = 0;
    this._diagnostics = this._emptyDiagnostics();
  }

  supports(effectName) { return Boolean(this._generators[effectName]); }

  prepareFrame(audioData, config, scene = {}) {
    const generator = this._generators[config.effect];
    if (!generator) return null;
    const frameTimings = {
      snapshotMs: Math.max(0, Number(scene.snapshotMs) || 0),
      geometryMs: 0,
      planningMs: 0,
    };
    if (scene.blackout || config.blackout) {
      this._diagnostics = { ...this._diagnostics, blackout: true, frameTimings };
      return null;
    }

    const frozen = Boolean(scene.freeze ?? config.freeze);
    if (frozen && this._lastStream) {
      this._diagnostics = {
        ...this._diagnostics,
        active: true,
        frozen: true,
        blackout: false,
        cacheHit: true,
        frameTimings,
      };
      return this._lastStream;
    }

    const quality = scene.quality || {
      name: 'full', geometryScale: 1, fanPathScale: 1,
      exposureScale: 1, trailScale: 1,
    };
    const externalResetToken = scene.resetToken ?? 0;
    if (this._activeEffect !== config.effect) {
      this._activeEffect = config.effect;
      this._invalidate('effect-change');
    }
    if (this._externalResetToken !== null && externalResetToken !== this._externalResetToken) {
      this._invalidate(scene.resetReason || 'runtime-state-change');
    }
    this._externalResetToken = externalResetToken;
    if (quality.name !== this._qualityName) {
      this._qualityName = quality.name;
      this._invalidate('quality-change');
    }

    const deterministicScene = {
      showTime: Math.max(0, Number(scene.showTime) || 0),
      seed: Number(scene.seed) >>> 0,
    };
    const exposureSceneKey = this._makeExposureSceneKey(audioData, config);
    if (this._exposureSceneKey !== null && exposureSceneKey !== this._exposureSceneKey) {
      this._renderer.clear('deterministic-scene-cycle');
      this._resetToken++;
    }
    this._exposureSceneKey = exposureSceneKey;
    const geometryKey = this._makeGeometryKey(audioData, config, deterministicScene, quality);
    const scannerKey = this._makeScannerKey(config.scannerPrototype, quality);
    const geometryChanged = geometryKey !== this._geometryKey;
    const scannerChanged = scannerKey !== this._scannerKey;
    let replanReason = 'cache-hit';

    if (geometryChanged) {
      const startedAt = nowMs();
      this._paths = generator.generate(audioData, config, deterministicScene, quality);
      frameTimings.geometryMs = nowMs() - startedAt;
      this._telemetry.record('geometry', frameTimings.geometryMs);
      this._geometryKey = geometryKey;
      replanReason = this._lastStream ? 'meaningful-geometry-change' : 'initial-geometry';
    }

    if (!this._lastStream || geometryChanged || scannerChanged) {
      const startedAt = nowMs();
      this._cycleGeneration++;
      const cycleId = `${externalResetToken}:${this._cycleGeneration}:${config.effect}`;
      const stream = this._scanner.scan(this._paths, {
        ...config.scannerPrototype,
        effect: config.effect,
        showTime: deterministicScene.showTime,
        cycleId,
        replanReason: scannerChanged && !geometryChanged ? 'scanner-config-change' : replanReason,
        adaptiveQuality: quality.name,
      });
      frameTimings.planningMs = nowMs() - startedAt;
      this._telemetry.record('planning', frameTimings.planningMs);
      this._scannerKey = scannerKey;
      this._lastStream = stream;
      this._plans++;
      if (stream.stats.postBoundaryViolations > 0 &&
          !this._loggedViolationCycles.has(stream.stats.cycleId) &&
          this._loggedViolationCycles.size < 8) {
        this._loggedViolationCycles.add(stream.stats.cycleId);
        console.error('[VirtualScanner] Motion invariant violation', {
          effect: config.effect,
          showTime: deterministicScene.showTime,
          cycleId: stream.stats.cycleId,
          quality: quality.name,
          budget: stream.stats.finalBudget,
          replanReason: stream.stats.replanReason,
          details: stream.stats.violationDetails,
        });
      }
    } else {
      this._cacheHits++;
    }

    this._diagnostics = {
      active: true,
      effect: config.effect,
      frozen,
      blackout: false,
      ...this._lastStream.stats,
      cacheHit: !geometryChanged && !scannerChanged,
      cachedCycles: this._cacheHits,
      plannedCycles: this._plans,
      cycleGeneration: this._cycleGeneration,
      geometryKey,
      adaptiveQuality: quality.name,
      frameTimings,
      moduleTimings: this._telemetry.snapshot(),
    };
    return this._lastStream;
  }

  render(ctx, width, height, audioData, config, deltaTime, scene = {}) {
    const stream = this.prepareFrame(audioData, config, scene);
    if (!stream) return false;
    const quality = scene.quality || {};
    const rendererDiagnostics = this._renderer.render(
      ctx,
      width,
      height,
      stream,
      scene.showTime,
      deltaTime,
      {
        ...config.scannerPrototype,
        exposureScale: quality.exposureScale ?? 1,
        trailScale: quality.trailScale ?? 1,
        resetToken: this._resetToken,
        resetReason: scene.resetReason,
      },
    );
    this._telemetry.record('pointStream', rendererDiagnostics.pointStreamMs);
    this._telemetry.record('exposure', rendererDiagnostics.exposureMs);
    const cycleDuration = stream.stats.cycleDuration;
    const cycleIndex = cycleDuration > 0 ? Math.floor((Number(scene.showTime) || 0) / cycleDuration) : 0;
    const cycleBoundary = this._lastCycleIndex !== null && cycleIndex !== this._lastCycleIndex;
    this._lastCycleIndex = cycleIndex;
    this._diagnostics = {
      ...this._diagnostics,
      ...rendererDiagnostics,
      cycleBoundary,
      frameTimings: {
        ...(this._diagnostics.frameTimings || {}),
        pointVisitMs: rendererDiagnostics.pointStreamMs,
        exposureCanvasMs: rendererDiagnostics.exposureMs,
      },
      moduleTimings: this._telemetry.snapshot(),
    };
    return true;
  }

  clear(reason = 'explicit') { this._renderer.clear(reason); }

  resetRuntimeDiagnostics() { this._renderer.resetRuntimeDiagnostics(); }

  reset(reason = 'explicit') { this._invalidate(reason); }

  getDiagnostics() { return { ...this._diagnostics }; }

  _invalidate(reason) {
    this._renderer.clear(reason);
    this._lastStream = null;
    this._paths = null;
    this._geometryKey = null;
    this._scannerKey = null;
    this._lastCycleIndex = null;
    this._exposureSceneKey = null;
    this._resetToken++;
  }

  _makeExposureSceneKey(audioData, config) {
    const audio = audioData || {};
    const usesDiscreteCycle = config.effect === 'lissajous' && config.lissajous?.beatSnap ||
      config.effect === 'scanner' && config.scanner?.mode === 'snap';
    return JSON.stringify({
      effect: config.effect,
      discreteCycle: usesDiscreteCycle ? Math.floor(Number(audio.beatCount) || 0) : null,
      palette: config.palette,
      colorMode: config.show?.colorMode,
    });
  }

  _makeGeometryKey(audioData, config, scene, quality) {
    const audio = audioData || {};
    const geometryHz = quality.name === 'full' ? 20 :
      quality.name === 'balanced' ? 15 : quality.name === 'reduced' ? 10 : 8;
    const timeBucket = Math.floor(scene.showTime * geometryHz);
    const effectConfig = config[config.effect] || {};
    return JSON.stringify({
      effect: config.effect,
      timeBucket,
      seed: scene.seed,
      beatCount: Math.floor(Number(audio.beatCount) || 0),
      isBeat: Boolean(audio.isBeat),
      amplitude: rounded(audio.amplitude, 2),
      bass: rounded(audio.bass, 2),
      mid: rounded(audio.mid, 2),
      palette: config.palette,
      customColor: config.customColor,
      brightness: rounded(config.brightness, 3),
      sensitivity: rounded(config.sensitivity, 3),
      speed: rounded(config.speed, 3),
      show: config.show,
      effectConfig,
      geometryScale: quality.geometryScale ?? 1,
      fanPathScale: quality.fanPathScale ?? 1,
    });
  }

  _makeScannerKey(options = {}, quality = {}) {
    return JSON.stringify({
      scanRate: options.scanRate,
      maxVelocity: options.maxVelocity,
      maxAcceleration: options.maxAcceleration,
      pointSpacing: options.pointSpacing,
      cornerDwell: options.cornerDwell,
      endDwell: options.endDwell,
      preLightDelayMs: options.preLightDelayMs,
      postLightDelayMs: options.postLightDelayMs,
      pointBudget: options.pointBudget,
      quality: quality.name || 'full',
    });
  }

  _emptyDiagnostics() {
    return {
      active: false, effect: null, frozen: false, blackout: false,
      scanRate: 0, effectiveScanRate: 0, pointBudget: 0, pointsPerCycle: 0,
      visiblePoints: 0, blankedPoints: 0, transferPoints: 0,
      cornerDwellPoints: 0, endDwellPoints: 0, preLightDelayPoints: 0,
      postLightDelayPoints: 0, blankOnPoints: 0, blankOffPoints: 0,
      currentVelocity: 0, maxVelocity: 0, maxAcceleration: 0,
      accelerationLimitedPoints: 0, cycleDuration: 0, effectiveRepeatRate: 0,
      estimatedRepeatRate: 0, budgetExceeded: false, budgetOverruns: 0,
      budgetSatisfied: true, requestedPoints: 0, removedGeometryPoints: 0,
      removedMotionPoints: 0, replannedPaths: 0, qualityLevel: 0,
      preBoundaryViolations: 0, postBoundaryViolations: 0,
      violationDetails: [], duplicateTimestamps: 0, intervalSumError: 0,
      cycleBoundary: false, playedPoints: 0, effectivePlayedScanRate: 0,
      cycleScanRate: 0, playbackPointRate: 0, renderVisitRate: 0,
      repeatedCycles: 0, repeatedCycleRate: 0, duplicatePointVisits: 0,
      catchUpLimited: false, droppedExposureScannerTime: 0,
      droppedExposureIntervals: 0, droppedScannerPoints: 0, droppedShowEvents: 0,
      frameTimings: { geometryMs: 0, planningMs: 0, pointVisitMs: 0, exposureCanvasMs: 0 },
      plannedCycles: 0, cachedCycles: 0, adaptiveQuality: 'full',
      moduleTimings: {},
    };
  }
}
