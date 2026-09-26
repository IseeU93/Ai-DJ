// ============================================================
// LaserRenderer.js - Scene Manager plus isolated scanner prototype
// ============================================================

import { Scanner }    from './effects/Scanner.js';
import { Tunnel }     from './effects/Tunnel.js';
import { LsdTunnel }  from './effects/LsdTunnel.js';
import { HotBeams }   from './effects/HotBeams.js';
import { LiquidSky }  from './effects/LiquidSky.js';
import { Lissajous }  from './effects/Lissajous.js';
import { Waveform }   from './effects/Waveform.js';
import { ChaosBlades } from './effects/ChaosBlades.js';
import { Spiral }     from './effects/Spiral.js';
import { Snake }      from './effects/Snake.js';
import { BeamSweep }  from './effects/BeamSweep.js';
import { RainbowRing } from './effects/RainbowRing.js';
import { perimeterPoint } from '../shared/Config.js';
import { SceneManager } from '../show/SceneManager.js';
import { ScannerClock } from './scanner/ScannerClock.js';
import { ScannerPrototype } from './scanner/ScannerPrototype.js';
import { AudioSnapshotBuffer } from './scanner/AudioSnapshotBuffer.js';
import { ScannerSyncController } from './scanner/ScannerSyncController.js';
import { ScannerLoadTest } from './scanner/ScannerLoadTest.js';
import { PerformanceTelemetry } from './scanner/PerformanceTelemetry.js';
import { AdaptiveQualityController } from './scanner/AdaptiveQualityController.js';
import { ScannerEffectState } from './scanner/ScannerEffectState.js';
import { ScannerFrameAccounting } from './scanner/ScannerFrameAccounting.js';
import { ScannerHealthWindow } from './scanner/ScannerHealthWindow.js';
import { RuntimeEnvironmentMonitor } from './scanner/RuntimeEnvironmentMonitor.js';

export class LaserRenderer {
  constructor(canvas, { scannerClock, scannerEffectState } = {}) {
    this.canvas = canvas;
    // alpha:false erspart dem Compositor pro Frame den Alpha-Kanal -
    // die Fläche wird ohnehin jeden Frame voll neu gezeichnet
    // (Blackout/Trail-Fade), Transparenz zum Fensterhintergrund
    // braucht niemand.
    this.ctx = canvas.getContext('2d', { alpha: false });

    this._effects = {
      scanner: new Scanner(),
      tunnel: new Tunnel(),
      lsdTunnel: new LsdTunnel(),
      hotBeams: new HotBeams(),
      liquidSky: new LiquidSky(),
      lissajous: new Lissajous(),
      waveform: new Waveform(),
      chaosBlades: new ChaosBlades(),
      spiral: new Spiral(),
      snake: new Snake(),
      beamSweep: new BeamSweep(),
      rainbowRing: new RainbowRing(),
    };

    this._sceneManager = new SceneManager();
    this._audioData = null;
    this._config = null;
    this._isRunning = false;
    this._animFrame = null;
    this._useDemoData = false;
    this._scannerClock = scannerClock || new ScannerClock();
    this._effectState = scannerEffectState || new ScannerEffectState();
    this._telemetry = new PerformanceTelemetry({ windowSize: 300 });
    this._adaptiveQuality = new AdaptiveQualityController();
    this._scannerClockDeviationMs = null;
    this._remoteScannerReport = null;
    this._audioSnapshots = new AudioSnapshotBuffer();
    this._scannerSync = new ScannerSyncController();
    this._scannerLoadTest = new ScannerLoadTest({
      memoryReader: () => performance?.memory?.usedJSHeapSize,
    });
    this._scannerPrototype = new ScannerPrototype({ telemetry: this._telemetry });
    this._prototypeActive = false;
    this._strobeGateOn = true;   // Blanking-Zustand des Strobe-Gates
    // Wandernder Effekt-Ursprung (normiert 0..1). Kein Effekt klebt an
    // der Bildmitte: in ruhigen Teilen driftet der Punkt auf einer
    // Lissajous-Bahn, im Drop springt er auf jedem Kick.
    this._origin = { x: 0.5, y: 0.5 };
    this._originTarget = { x: 0.5, y: 0.5 };
    this._originPhase = 0;
    this._originLastKick = false;
    // Beat-Pumpe: die ganze Szene rückt auf dem Kick nach vorn (größer)
    // und fällt federnd zurück. Im Raum wirkt das wie ein Lichtkegel,
    // der auf den Betrachter zukommt.
    this._pumpScale = 1;
    this._pumpVel = 0;
    this._pumpLastKick = false;
    this._breathPhase = 0;
    this._strobeFreePhase = 0;   // freie Phase, wenn kein Beat-Grid da ist
    this._lastFrameTime = null;
    this._renderFps = 0;
    this._frameAccounting = new ScannerFrameAccounting();
    const visibilityState = globalThis.document?.visibilityState || 'visible';
    this._healthWindow = new ScannerHealthWindow({ windowMs: 3000 });
    this._environment = new RuntimeEnvironmentMonitor({
      nowMs: globalThis.performance?.now?.() || 0,
      visibilityState,
      userAgent: globalThis.navigator?.userAgent || '',
      platform: globalThis.navigator?.platform || '',
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    });
    this._visibilityHandler = () => {
      const now = globalThis.performance?.now?.() || 0;
      this._environment.updateVisibility(globalThis.document?.visibilityState || 'visible', now);
      this._frameAccounting.markVisibilityChange(now);
      this._healthWindow.markReset(now);
    };
    globalThis.document?.addEventListener?.('visibilitychange', this._visibilityHandler);
    this._pendingDiagnosticsDomMs = 0;
    this._lastRenderedAtMs = null;
    this._lastRuntimeGeneration = null;
    this._lastLoadTestActive = false;
  }

  start(config) {
    this._config = { ...config };
    this._syncScannerClock(config);
    this._applyRuntimeState(config);
    const activeEffect = this._effectState.snapshot().activeEffect;
    this._isRunning = true;
    this._initEffect({ ...config, effect: activeEffect });
    this._sceneManager.setPrimaryEffect(activeEffect, true);
    this._lastFrameTime = null;
    this._lastRenderedAtMs = null;
    this._frameAccounting.reset();
    this._healthWindow.markReset(globalThis.performance?.now?.() || 0);
    this._loop(performance.now());
  }

  updateAudio(audioData) {
    this._audioData = audioData;
    this._useDemoData = false;
  }

  updateScannerAudioSnapshot(snapshot) {
    return this._audioSnapshots.push(snapshot);
  }

  updateConfig(config) {
    const previousEffect = this._effectState.snapshot().activeEffect;
    this._config = { ...config };
    this._syncScannerClock(config);
    this._applyRuntimeState(config);
    const activeEffect = this._effectState.snapshot().activeEffect;

    if (previousEffect !== activeEffect) {
      this._initEffect({ ...config, effect: activeEffect });
      const isClimax = config.show?.intensity === 'drop';
      this._sceneManager.setPrimaryEffect(activeEffect, isClimax);
    }

    // config._overlayEffects (Choreographer, mehrere Ebenen je nach
    // Eskalationsstufe) hat Vorrang vor dem älteren, einzelnen
    // config._overlayEffect (AutoPunctuation-Strobe im manuellen Modus).
    // Overlay immer voll deckend - keine Halbtransparenz mehr.
    const overlayKeys = config._overlayEffects?.length
      ? config._overlayEffects
      : (config._overlayEffect ? [config._overlayEffect] : []);
    this._sceneManager.setOverlays(overlayKeys, 1);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  stop() {
    this._isRunning = false;
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  setDemoMode(enabled) {
    this._useDemoData = enabled;
  }

  getScannerClockSample() {
    return this._scannerClock.sample();
  }

  getScannerClockProbe() {
    return this._scannerSync.createProbe(this._scannerClock);
  }

  applyScannerClockProbe(probe) {
    this._scannerSync.receiveProbe(probe, this._scannerClock);
    const sample = this._scannerClock.sample();
    return { ...sample, playerTime: sample.showTime, ...this._scannerSync.getDiagnostics() };
  }

  setRemoteScannerClockReport(report) {
    this._remoteScannerReport = report ? { ...report } : null;
    const deviation = Number(report?.clockDeltaMs);
    this._scannerClockDeviationMs = Number.isFinite(deviation) ? deviation : null;
  }

  clearRemoteScannerClockReport() {
    this._remoteScannerReport = null;
    this._scannerClockDeviationMs = null;
  }

  setScannerClockDeviation(deviationMs) {
    this._scannerClockDeviationMs = Number.isFinite(deviationMs) ? deviationMs : null;
  }

  startScannerLoadTest(options = {}) {
    const startShowTime = Number.isFinite(options.startShowTime)
      ? options.startShowTime
      : this._scannerClock.now();
    const now = performance.now();
    this._adaptiveQuality.reset(now, options.startQuality || 'full');
    this._telemetry.reset();
    this._frameAccounting.setExpectedDisplayFps(options.expectedDisplayFps || 60);
    this._scannerPrototype.resetRuntimeDiagnostics();
    this._healthWindow.markReset(now);
    this._pendingDiagnosticsDomMs = 0;
    const state = this._scannerLoadTest.start({ ...options, startShowTime });
    this._lastLoadTestActive = true;
    this._effectState.startTest(state.effect, state.testPhase);
    return state;
  }

  stopScannerLoadTest() {
    const summary = this._scannerLoadTest.finish(this._scannerClock.now());
    this._effectState.stopTest();
    this._healthWindow.markReset(performance.now());
    this._lastLoadTestActive = false;
    return summary;
  }

  recordDiagnosticsDomTime(durationMs) {
    this._pendingDiagnosticsDomMs += Math.max(0, Number(durationMs) || 0);
  }

  getDiagnostics() {
    const startedAt = performance.now();
    const runtimeState = this._effectState.snapshot();
    const prototypeEnabled = Boolean(
      runtimeState.prototypeEnabled &&
      this._config?.scannerPrototype?.enabled &&
      this._scannerPrototype.supports(runtimeState.activeEffect),
    );
    const scannerTime = this._scannerClock.now();
    const snapshotDiagnostics = this._audioSnapshots.getDiagnostics();
    const localSync = this._scannerSync.getDiagnostics();
    const remote = this._remoteScannerReport || {};
    const loadTestState = this._scannerLoadTest.getState(scannerTime);
    const environment = this._environment.snapshot(performance.now());
    const healthWindow = this._healthWindow.snapshot(performance.now());
    const remoteAvailable = this._remoteScannerReport !== null;
    const diagnostics = {
      ...this._scannerPrototype.getDiagnostics(),
      ...snapshotDiagnostics,
      effect: runtimeState.activeEffect,
      selectedEffect: runtimeState.selectedEffect,
      effectState: runtimeState,
      active: prototypeEnabled,
      mode: prototypeEnabled ? 'prototype' : 'legacy',
      renderFps: this._renderFps,
      scannerTime,
      previewScannerTime: scannerTime,
      playerScannerTime: Number.isFinite(remote.playerTime) ? remote.playerTime : null,
      scannerClockDeviationMs: this._scannerClockDeviationMs,
      clockDeltaMs: remoteAvailable && Number.isFinite(remote.clockDeltaMs) ? remote.clockDeltaMs : null,
      clockAverageDeltaMs: remoteAvailable && Number.isFinite(remote.clockAverageDeltaMs) ? remote.clockAverageDeltaMs : null,
      clockMaxDeltaMs: remoteAvailable && Number.isFinite(remote.clockMaxDeltaMs) ? remote.clockMaxDeltaMs : null,
      clockP95DeltaMs: remoteAvailable && Number.isFinite(remote.clockP95DeltaMs) ? remote.clockP95DeltaMs : null,
      lostClockProbes: remoteAvailable ? Number(remote.lostClockProbes) || 0 : null,
      hardResyncs: remoteAvailable ? Number(remote.hardResyncs) || 0 : null,
      adaptiveQualityState: this._adaptiveQuality.getState(),
      naturalSkippedFramesWindow: healthWindow.skippedIntervals,
      naturalSkippedFramesTotal: this._frameAccounting.snapshot().naturalSkippedFramesTotal,
      naturalSkipRateWindow: healthWindow.naturalSkipRateWindow,
      skippedFramesWindow: healthWindow.skippedIntervals,
      healthWindow,
      environment,
      frameAccounting: this._frameAccounting.snapshot(),
      moduleTimings: this._telemetry.snapshot(),
      loadTest: { ...loadTestState, summary: this._scannerLoadTest.getSummary() },
    };
    this._telemetry.record('diagnostics', performance.now() - startedAt);
    return diagnostics;
  }

  _applyRuntimeState(config) {
    if (config?.scannerRuntimeState) {
      const result = this._effectState.applySnapshot(config.scannerRuntimeState);
      if (!result.accepted && result.reason === 'schema-mismatch') {
        console.error('[ScannerRuntime] Incompatible effect-state schema', {
          received: config.scannerRuntimeState?.schemaVersion,
          state: result.state,
        });
      }
    } else {
      this._effectState.selectManual(config?.effect);
      this._effectState.setPrototypeEnabled(config?.scannerPrototype?.enabled);
    }
  }

  _syncScannerClock(config) {
    if (config?.scannerClock) this._scannerClock.sync(config.scannerClock);
  }

  _loop(timestamp) {
    if (!this._isRunning) return;
    const environment = this._environment.recordRaf(timestamp);
    const rawDeltaTime = this._lastFrameTime === null
      ? 1 / 60
      : Math.max(0, (timestamp - this._lastFrameTime) / 1000);
    this._lastFrameTime = timestamp;
    const scannerTime = this._scannerClock.now();
    const loadState = this._scannerLoadTest.nextFrame(scannerTime, timestamp);
    if (this._lastLoadTestActive && !loadState.active) {
      this._healthWindow.markReset(timestamp);
      this._lastLoadTestActive = false;
    } else if (loadState.active) {
      this._lastLoadTestActive = true;
    }
    if (loadState.active) {
      this._effectState.updateTest(loadState.effect, loadState.testPhase);
    } else if (this._effectState.snapshot().testActive) {
      this._effectState.stopTest();
    }

    let artificialDelayMs = 0;
    if (loadState.artificialLoadMs > 0) {
      const loadStartedAt = performance.now();
      const loadUntil = loadStartedAt + loadState.artificialLoadMs;
      while (performance.now() < loadUntil) { /* explicit synthetic browser load */ }
      artificialDelayMs = performance.now() - loadStartedAt;
    }

    // Kein FPS-Deckel: rendert mit voller Bildwiederholrate des
    // Monitors (per Nutzer-Feedback sichtbar flüssiger/besser). War
    // kurzzeitig auf 60fps gedeckelt, um CPU-Last zu senken - der
    // Verlust an Bewegungsschärfe auf schnellen Displays hat mehr
    // gestört, als die CPU-Ersparnis gebracht hat.
    const actuallyRendered = loadState.shouldRender;

    let renderMs = 0;
    if (actuallyRendered) {
      const renderedInterval = this._lastRenderedAtMs === null
        ? rawDeltaTime
        : Math.max(0, (timestamp - this._lastRenderedAtMs) / 1000);
      this._lastRenderedAtMs = timestamp;
      if (renderedInterval > 0) {
        const instantFps = 1 / renderedInterval;
        this._renderFps += (instantFps - this._renderFps) * Math.min(1, renderedInterval * 5);
      }
      const renderStartedAt = performance.now();
      this._render(rawDeltaTime, scannerTime, loadState);
      renderMs = performance.now() - renderStartedAt;
      this._telemetry.record('render', renderMs);
    }

    const prototypeDiagnostics = this._scannerPrototype.getDiagnostics();
    const frameTimings = actuallyRendered
      ? (prototypeDiagnostics.frameTimings || {})
      : {};
    const knownRenderMs = (Number(frameTimings.snapshotMs) || 0) +
      (Number(frameTimings.geometryMs) || 0) +
      (Number(frameTimings.planningMs) || 0) +
      (Number(frameTimings.pointVisitMs) || 0) +
      (Number(frameTimings.exposureCanvasMs) || 0);
    const accounting = this._frameAccounting.recordFrame({
      rafTimestampMs: timestamp,
      rendered: actuallyRendered,
      syntheticSuppressed: loadState.syntheticSuppressed,
      artificialTestDelayMs: artificialDelayMs,
      components: {
        snapshotMs: frameTimings.snapshotMs,
        geometryMs: frameTimings.geometryMs,
        planningMs: frameTimings.planningMs,
        pointVisitMs: frameTimings.pointVisitMs,
        exposureCanvasMs: frameTimings.exposureCanvasMs,
        diagnosticsDomMs: this._pendingDiagnosticsDomMs,
        renderOtherMs: Math.max(0, renderMs - knownRenderMs),
      },
      visibilityState: environment.visibilityState,
    });
    this._pendingDiagnosticsDomMs = 0;
    const healthWindow = this._healthWindow.record({
      timestampMs: timestamp,
      visibilityState: environment.visibilityState,
      rafIntervalMs: accounting.last.rafIntervalMs,
      skippedIntervals: accounting.last.naturalSkippedFrames || 0,
      renderMs,
      planningMs: frameTimings.planningMs,
    });

    this._adaptiveQuality.update({
      ...healthWindow,
      backgroundThrottled: environment.hidden,
      finalBudgetExceeded: Boolean(prototypeDiagnostics.finalBudgetExceeded),
      motionViolations: Number(prototypeDiagnostics.postBoundaryViolations) || 0,
      syntheticPressure: Boolean(loadState.syntheticLoadActive &&
        (loadState.targetFps < 60 || loadState.artificialLoadMs > 0)),
      syntheticLoadActive: Boolean(loadState.syntheticLoadActive),
    }, timestamp);
    this._scannerLoadTest.recordFrame(accounting, this.getDiagnostics(), environment);
    this._animFrame = requestAnimationFrame((nextTimestamp) => this._loop(nextTimestamp));
  }

  _render(deltaTime, scannerTime, loadState = {}) {
    const { canvas, ctx } = this;
    const baseConfig = this._config;
    if (!baseConfig) return;
    if (loadState.active) this._effectState.updateTest(loadState.effect, loadState.testPhase);
    const runtimeState = this._effectState.snapshot();
    const cfg = { ...baseConfig, effect: runtimeState.activeEffect };
    const W = canvas.width;
    const H = canvas.height;

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    const prototypeActive = Boolean(
      runtimeState.prototypeEnabled &&
      cfg.scannerPrototype?.enabled &&
      this._scannerPrototype.supports(cfg.effect),
    );

    if (cfg.blackout) {
      this._scannerPrototype.clear('blackout');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    if (cfg.freeze && !prototypeActive) return;

    let audioData = this._audioData;
    let snapshotMs = 0;
    if (!audioData || this._useDemoData) {
      audioData = this._buildDemoData(scannerTime);
    }
    if (prototypeActive) {
      const snapshotStartedAt = performance.now();
      audioData = this._audioSnapshots.sample(scannerTime, audioData);
      snapshotMs = performance.now() - snapshotStartedAt;
      this._telemetry.record('snapshot', snapshotMs);
    }

    const intensityMul = this._getIntensityMul(cfg, audioData);

    // ── Strobe-Gate ─────────────────────────────────────────
    // Echtes Laser-Blanking: in der Aus-Phase wird die Fläche hart
    // geschwärzt und KEIN Effekt gezeichnet. Dadurch flackert das
    // Bild selbst - im Gegensatz zu einem weißen Vollbild-Blitz, der
    // die Show nur überstrahlt.
    const gateOn = this._evaluateStrobeGate(cfg, audioData, deltaTime);
    if (!gateOn) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    const trailAlpha = 1 - Math.max(0, Math.min(0.98, cfg.trailLength));
    ctx.fillStyle = `rgba(0, 0, 0, ${trailAlpha})`;
    ctx.fillRect(0, 0, W, H);

    const origin = this._updateOrigin(cfg, audioData, deltaTime);
    const pump = this._updateBeatPump(cfg, audioData, deltaTime);

    const dynThick = audioData.isBeat ? 1.5 : 1.0;
    // Der Haupteffekt wird immer voll gezeichnet. Die Phase (Intro,
    // Break, Drop) steuert nur noch die Reaktivität, nicht mehr die
    // Helligkeit - ein halb durchsichtiger Laser ist kein Laser.
    const scaledCfg = {
      ...cfg,
      brightness: cfg.brightness,
      sensitivity: cfg.sensitivity * intensityMul,
      thicknessMul: dynThick,
      origin,
    };

    if (prototypeActive !== this._prototypeActive) {
      this._scannerPrototype.reset('a-b-mode-change');
      this._prototypeActive = prototypeActive;
    }
    if (prototypeActive) {
      this._scannerPrototype.render(
        ctx,
        W,
        H,
        audioData,
        scaledCfg,
        deltaTime,
        {
          showTime: scannerTime,
          seed: loadState.active ? loadState.seed : this._scannerClock.seed,
          freeze: Boolean(cfg.freeze),
          blackout: false,
          quality: this._adaptiveQuality.getState(),
          resetToken: runtimeState.resetToken,
          resetReason: runtimeState.source === 'load-test' ? 'test-phase-change' : 'runtime-state-change',
          snapshotMs,
        },
      );
      if (this._scannerPrototype.getDiagnostics().cycleBoundary) {
        this._scannerSync.commitCycleBoundary(this._scannerClock);
      }
      return;
    }

    // Kein Nebeldunst/LED-Punkt mehr am Ursprung: kostete pro Frame
    // einen weiteren Gradient (Performance) und wirkte optisch wie
    // ein kleiner beleuchteter Punkt in der Mitte - genau das, was
    // z.B. der Sog-Tunnel/Tunnel bewusst vermeiden ("kein
    // Mittelpunkt"). Jeder Effekt zeichnet seinen eigenen Ursprungs-
    // Look selbst, wenn er einen braucht.
    const originPx = { x: origin.x * W, y: origin.y * H };

    // ── Beat-Pumpe als Kameratransformation ─────────────────
    // Skaliert um den Ursprung: die Figur wird auf dem Kick größer und
    // fällt zurück, statt dass jeder Effekt das einzeln nachbauen muss.
    this._sceneManager.update();
    ctx.save();
    ctx.translate(originPx.x, originPx.y);
    ctx.scale(pump.scale, pump.scale * pump.squash);
    ctx.translate(-originPx.x, -originPx.y);
    this._sceneManager.render(ctx, W, H, audioData, scaledCfg, this._effects);
    ctx.restore();
  }

  /**
   * Beat-Pumpe: auf jedem Kick bekommt die Szene einen Schub nach
   * vorn (Maßstab > 1), der federnd zurückschwingt. Dazu ein langsames
   * Atmen im Takt, damit auch zwischen den Kicks Bewegung im Raum ist.
   *
   * Umgesetzt als gedämpfter Feder-Masse-Schwinger - eine lineare
   * Interpolation würde nur weich einschleichen statt zu pumpen.
   *
   * @returns {{scale:number, squash:number}}
   */
  _updateBeatPump(cfg, audioData, deltaTime = 1 / 60) {
    // Master-Schalter: die Beat-Pumpe skaliert die GESAMTE Szene um
    // den Ursprung, trifft also jeden Effekt gleichermaßen - bei
    // Effekten mit viel Fläche (z.B. die Schlange) sah der
    // Skalierungssprung auf jedem Beat schnell wie Wackeln statt wie
    // ein Puls aus. Standardmäßig deshalb aus.
    const enabled = cfg.beatPumpEnabled === true;
    const amount = enabled ? Math.max(0, Math.min(1, Number(cfg.beatPump ?? 0.5))) : 0;
    if (amount <= 0.001) {
      // Sanft auf 1 zurückfedern lassen statt hart zu springen, falls
      // der Schalter mitten in einem Ausschlag umgelegt wird.
      if (Math.abs(this._pumpScale - 1) > 0.001) {
        const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? Math.min(0.05, deltaTime) : 1 / 60;
        this._pumpScale += (1 - this._pumpScale) * Math.min(1, dt * 10);
        return { scale: this._pumpScale, squash: 1 - (this._pumpScale - 1) * 0.25 };
      }
      this._pumpScale = 1;
      this._pumpVel = 0;
      return { scale: 1, squash: 1 };
    }

    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? Math.min(0.05, deltaTime) : 1 / 60;
    const kick = Boolean(audioData?.transients?.kick?.hit) || Boolean(audioData?.isBeat);
    const velocity = Number(audioData?.transients?.kick?.velocity);
    const strength = Number.isFinite(velocity) && velocity > 0 ? velocity : 1;

    if (kick && !this._pumpLastKick) {
      this._pumpVel += amount * 2.6 * (0.5 + strength * 0.5);
    }
    this._pumpLastKick = kick;

    // Feder zurück auf 1 mit Dämpfung
    const stiffness = 140;
    const damping = 13;
    this._pumpVel += (1 - this._pumpScale) * stiffness * dt;
    this._pumpVel -= this._pumpVel * damping * dt;
    this._pumpScale += this._pumpVel * dt;
    this._pumpScale = Math.max(0.75, Math.min(1.6, this._pumpScale));

    // Langsames Atmen im Takt (ein Zyklus über zwei Takte)
    const bpm = Number(audioData?.bpm) > 0 ? Number(audioData.bpm) : 120;
    this._breathPhase = (this._breathPhase + dt * (bpm / 60) / 8) % 1;
    const breath = 1 + Math.sin(this._breathPhase * Math.PI * 2) * 0.04 * amount;

    return {
      scale: this._pumpScale * breath,
      // Leichte Stauchung in der Höhe: der Raum bekommt eine Bodenachse.
      squash: 1 - (this._pumpScale - 1) * 0.25,
    };
  }

  /**
   * Bewegt den Ursprung der zentrierten Effekte.
   *
   *  drift  – weiche Lissajous-Bahn, ein Umlauf über ~8 Takte
   *  snap   – auf jedem Kick an eine neue Position, federnd
   *  auto   – drift in ruhigen Teilen, snap im Drop
   *  static – Bildmitte
   *  edge   – wandert am Bildrand entlang (simuliert einen an der
   *           Wand/Decke montierten Projektor); teleportiert dabei
   *           gelegentlich zu einer neuen Randposition. Liefert
   *           zusätzlich `aim`, den Winkel, in den der Strahl von
   *           dort aus zeigen muss, um wieder auf den Bildschirm zu
   *           strahlen (siehe Scanner.js, orientation:'edge').
   *
   * @returns {{x:number,y:number,aim?:number}} normierter Ursprung (0..1)
   */
  _updateOrigin(cfg, audioData, deltaTime = 1 / 60) {
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? Math.min(0.1, deltaTime) : 1 / 60;
    const range = Math.max(0, Math.min(0.4, Number(cfg.originRange ?? 0.22)));
    let mode = cfg.originMotion || 'auto';

    if (mode === 'auto') {
      const phase = audioData?.energy?.phase;
      mode = phase === 'drop' ? 'snap' : 'drift';
    }

    if (mode === 'edge') {
      return this._updateEdgeOrigin(cfg, audioData, dt);
    }

    if (mode === 'static' || range <= 0) {
      this._origin = { x: 0.5, y: 0.5 };
      this._originTarget = { x: 0.5, y: 0.5 };
      return { ...this._origin };
    }

    const bpm = Number(audioData?.bpm) > 0 ? Number(audioData.bpm) : 120;
    const beatsPerSecond = bpm / 60;

    if (mode === 'snap') {
      const kick = Boolean(audioData?.transients?.kick?.hit) || Boolean(audioData?.isBeat);
      if (kick && !this._originLastKick) {
        // Neue Position: deutlich weg von der aktuellen, damit der
        // Sprung sichtbar ist - aber innerhalb des erlaubten Bereichs.
        const angle = Math.random() * Math.PI * 2;
        const dist = range * (0.55 + Math.random() * 0.45);
        this._originTarget = {
          x: 0.5 + Math.cos(angle) * dist,
          y: 0.5 + Math.sin(angle) * dist * 0.8,
        };
      }
      this._originLastKick = kick;
      // Federnd hin, damit es ein Sprung mit Nachziehen ist.
      const k = 1 - Math.exp(-dt * 22);
      this._origin.x += (this._originTarget.x - this._origin.x) * k;
      this._origin.y += (this._originTarget.y - this._origin.y) * k;
      return { ...this._origin };
    }

    // drift: läuft mit dem Tempo und bekommt auf jedem Kick einen
    // kleinen Schub - dadurch wandert der Ursprung im Takt statt
    // gleichmäßig durchzulaufen.
    const kickNow = Boolean(audioData?.transients?.kick?.hit) || Boolean(audioData?.isBeat);
    if (kickNow && !this._originLastKick) this._originPhase += 0.012;
    this._originLastKick = kickNow;
    this._originPhase += dt * (beatsPerSecond / 32);   // ein Umlauf ≈ 8 Takte
    const t = this._originPhase * Math.PI * 2;
    this._originTarget = {
      x: 0.5 + Math.sin(t) * range,
      y: 0.5 + Math.sin(t * 1.5 + 1.2) * range * 0.75,
    };
    const k = 1 - Math.exp(-dt * 6);
    this._origin.x += (this._originTarget.x - this._origin.x) * k;
    this._origin.y += (this._originTarget.y - this._origin.y) * k;
    return { ...this._origin };
  }

  /**
   * originMotion:'edge' – simuliert einen wand-/deckenmontierten
   * Projektor: der Ursprung wandert langsam am Bildrand entlang und
   * springt gelegentlich (Beat, verstärkt in Drops) zu einer neuen
   * Randposition, statt gleichmäßig zu kriechen. `aim` sagt den
   * konsumierenden Effekten (Scanner mit orientation:'edge'), in
   * welche Richtung sie "nach innen" strahlen müssen.
   */
  _updateEdgeOrigin(cfg, audioData, dt) {
    const bpm = Number(audioData?.bpm) > 0 ? Number(audioData.bpm) : 120;
    const beatsPerSecond = bpm / 60;

    if (this._edgePhase === undefined) this._edgePhase = 0;
    if (this._edgeTarget === undefined) this._edgeTarget = 0;

    // Langsames, stetiges Wandern - ein voller Umlauf über ~12 Takte
    // (bei 128 BPM gut 20 s). Mit den vorherigen 24 Takten brauchte
    // eine Runde 45 s: in einem normalen Songabschnitt schaffte der
    // Ursprung nicht mal eine Kante, das "Wandern" war unsichtbar.
    this._edgePhase += dt * (beatsPerSecond / 48);

    const kickNow = Boolean(audioData?.transients?.kick?.hit) || Boolean(audioData?.isBeat);
    const tension = Number(audioData?.energy?.tension ?? 0);
    const isDrop = audioData?.energy?.phase === 'drop';
    if (kickNow && !this._originLastKick) {
      // Gelegentlicher Teleport zu einer neuen Randposition - öfter,
      // je energiegeladener der Track (Aufbau/Drop), sonst selten,
      // damit der Effekt meist ruhig wandert statt zu hüpfen.
      const teleportChance = 0.05 + tension * 0.25 + (isDrop ? 0.15 : 0);
      if (Math.random() < teleportChance) {
        this._edgePhase += 0.15 + Math.random() * 0.6;
      }
    }
    this._originLastKick = kickNow;

    const p = perimeterPoint(this._edgePhase);
    this._origin = { x: p.x, y: p.y };
    return { x: p.x, y: p.y, aim: p.aim };
  }

  /**
   * Entscheidet pro Frame, ob der Laser gerade "an" ist.
   *
   * Das Gate läuft auf der Beat-Phase, damit das Flackern exakt im
   * Takt sitzt; ohne belastbares Beat-Grid auf einer freien Zeitbasis,
   * damit es nicht unregelmäßig zuckt. `duty` ist der Anteil des
   * Sub-Beats, in dem gezeichnet wird - je kleiner, desto härter.
   *
   * @returns {boolean} true = zeichnen, false = schwarz (Blanking)
   */
  _evaluateStrobeGate(cfg, audioData, deltaTime = 1 / 60) {
    const gate = cfg._strobeGate;
    if (!gate || !gate.active) { this._strobeGateOn = true; return true; }

    const div = Math.max(1, Math.min(32, Number(gate.div) || 4));
    const duty = Math.max(0.05, Math.min(1, Number(gate.duty) || 0.35));

    const hasGrid = Number(audioData?.bpm) > 0 && Number.isFinite(Number(audioData?.beatPhase));
    let phase;
    if (hasGrid) {
      phase = Math.max(0, Math.min(1, Number(audioData.beatPhase)));
    } else {
      // Ohne Beat-Grid läuft eine freie Phase mit, die pro Frame um
      // deltaTime weiterrückt - so flackert es gleichmäßig weiter.
      const bpm = Number(audioData?.bpm) > 0 ? Number(audioData.bpm) : 120;
      const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 1 / 60;
      this._strobeFreePhase = ((this._strobeFreePhase || 0) + dt / (60 / bpm)) % 1;
      phase = this._strobeFreePhase;
    }

    const subPhase = (phase * div) % 1;
    this._strobeGateOn = subPhase < duty;
    return this._strobeGateOn;
  }

  _initEffect(config) {
    const effect = this._effects[config.effect];
    if (effect?.init) effect.init(config);
  }

  _getIntensityMul(cfg, audioData) {
    switch (cfg.show?.intensity) {
      case 'break': return 0.35;
      case 'build': return 0.65;
      case 'drop': return 1.2;
      case 'auto':
      default: {
        if (audioData?.energy?.phase) {
          switch (audioData.energy.phase) {
            case 'intro':
            case 'outro': return 0.3;
            case 'break': return 0.4;
            case 'verse': return 0.7;
            case 'build': return 0.65 + (audioData.energy.tension || 0) * 0.35;
            case 'drop': return 1.2;
            default: break;
          }
        }

        if (audioData?.musicState === 'idle') return 0.3;
        const energy = (audioData.bass || 0) * 0.5 +
          (audioData.amplitude || 0) * 0.3 +
          (audioData.mid || 0) * 0.2;
        return 0.7 + energy * 0.6;
      }
    }
  }

  _buildDemoData(t) {
    const bass = 0.35 + 0.3 * Math.abs(Math.sin(t * 1.8));
    const mid = 0.25 + 0.2 * Math.abs(Math.sin(t * 2.7 + 1));
    const high = 0.12 + 0.12 * Math.abs(Math.sin(t * 5.1 + 2));
    const amplitude = 0.35 + 0.2 * Math.abs(Math.sin(t * 1.2));
    const isBeat = (t % 0.5) < 0.035;
    const timeDomainData = new Uint8Array(256);
    for (let i = 0; i < timeDomainData.length; i++) {
      timeDomainData[i] = 128 + Math.floor(50 * amplitude * Math.sin((i / 256) * Math.PI * 6 + t * 10));
    }

    const beatInterval = 500;
    const lastBeatTime = performance.now() - ((t % 0.5) / 0.5) * beatInterval;
    const beatPhase = (t % 0.5) / 0.5;
    const beatIndex = Math.floor(t / 0.5) % 4;

    return {
      bass, mid, high, amplitude, isBeat, bpm: 120,
      timeDomainData, frequencyData: new Uint8Array(64),
      lastBeatTime,
      beatPhase,
      beatIndex,
      measurePhase: (beatIndex + beatPhase) / 4.0,
      beatCount: Math.floor(t * 2),
      isVirtualBeat: beatPhase < 0.1,
      musicState: 'dance',
      energyTrend: 0.5,
      transients: {
        kick: { hit: isBeat && beatIndex % 2 === 0, velocity: 0.8, timeSinceLast: 250 },
        snare: { hit: isBeat && beatIndex % 2 === 1, velocity: 0.7, timeSinceLast: 250 },
        hihat: { hit: (t * 8) % 1 < 0.03, velocity: 0.5, timeSinceLast: 125 },
        clap: { hit: false, velocity: 0, timeSinceLast: 1000 },
      },
      bands: {
        sub: { energy: bass * 0.6, onset: false, envelope: bass * 0.5 },
        kick: { energy: bass * 0.8, onset: isBeat, envelope: bass * 0.7 },
        lowMid: { energy: mid * 0.5, onset: false, envelope: mid * 0.4 },
        mid: { energy: mid, onset: false, envelope: mid * 0.8 },
        upperMid: { energy: mid * 0.4, onset: false, envelope: mid * 0.3 },
        presence: { energy: high * 0.6, onset: false, envelope: high * 0.5 },
        brilliance: { energy: high * 0.4, onset: false, envelope: high * 0.3 },
        air: { energy: high * 0.2, onset: false, envelope: high * 0.1 },
      },
      energy: {
        level: amplitude * 0.8,
        trend: 'steady',
        tension: 0.3,
        phase: 'verse',
        dropImminent: false,
        musicState: 'dance',
      },
      harmony: {
        dominantNote: 'E',
        estimatedKey: 'E minor',
        suggestedPalette: ['#00ff41', '#00cc33', '#008822'],
        chordChanged: false,
        dissonance: 0.1,
      },
    };
  }
}
