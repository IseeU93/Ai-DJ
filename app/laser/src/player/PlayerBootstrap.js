// ============================================================
// PlayerBootstrap.js
//
// War zuvor ein INLINES <script type="module"> in player.html.
// Tauris strikte CSP (script-src 'self', ohne 'unsafe-inline')
// blockiert Inline-Skripte grundsätzlich – das Player-Fenster
// blieb dadurch in der Desktop-App leer/funktionslos ("Fehler
// beim Player öffnen"). Fix: Logik in eine externe Datei
// ausgelagert und per <script type="module" src="..."> geladen,
// die strikte CSP bleibt dabei unangetastet erhalten.
//
// Funktional 1:1 identisch zum vorherigen Inline-Code.
// ============================================================

import { LaserRenderer }   from '../visuals/LaserRenderer.js';
import { BroadcastBridge } from '../shared/BroadcastBridge.js';
import { DEFAULT_CONFIG }  from '../shared/Config.js';
import {
  APP_VERSION, SCANNER_MODEL_VERSION, SCANNER_SNAPSHOT_SCHEMA_VERSION,
  SCANNER_RUNTIME_SCHEMA_VERSION,
} from '../shared/Version.js';
import { ScannerClock }    from '../visuals/scanner/ScannerClock.js';
import { ScannerEffectState } from '../visuals/scanner/ScannerEffectState.js';
import { SCANNER_TEST_MODES } from '../visuals/scanner/ScannerLoadTest.js';
import {
  createPlayerPerformanceResult,
  resolvePlayerCanvasSize,
} from '../visuals/scanner/PlayerPerformanceSession.js';

document.title = `Laser Show - Player v${APP_VERSION} / Scanner v${SCANNER_MODEL_VERSION}`;

// ── Canvas & Renderer ──────────────────────────────────────
const canvas   = document.getElementById('laser-canvas');
const overlay  = document.getElementById('waiting-overlay');
const statusBar = document.getElementById('status-bar');
const sbFps    = document.getElementById('sb-fps');
const fsHint   = document.getElementById('fs-hint');
const readyPanel = document.getElementById('player-ready-panel');
const performancePanel = document.getElementById('player-performance-panel');
const setReadyText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
};
const query = new URLSearchParams(window.location.search);
const performanceMode = query.get('performance') === '1';
readyPanel.classList.toggle('visible', query.get('diagnostics') === '1' || performanceMode);
performancePanel.classList.toggle('visible', performanceMode);
const playerInstanceId = globalThis.crypto?.randomUUID?.() ||
  `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
setReadyText('pr-instance', playerInstanceId);

const scannerClock = new ScannerClock();
const scannerEffectState = new ScannerEffectState({ selectedEffect: DEFAULT_CONFIG.effect });
const renderer = new LaserRenderer(canvas, { scannerClock, scannerEffectState });
const bridge   = new BroadcastBridge('slave');
let currentRenderMode = query.get('resolution') || 'native';
let lastPerformanceResult = null;
let playerPerformanceRunning = false;
const DEMO_FALLBACK = Object.freeze({ effect: 'scanner' });

scannerEffectState.subscribe((state) => {
  setReadyText('pr-effects', `${state.activeEffect} / ${state.selectedEffect}`);
  setReadyText('pr-source', `${state.source} / ${state.testPhase ?? '-'}`);
  setReadyText('pr-sequence', `${state.sequence} / ${state.generation}`);
});
setReadyText('pr-app-version', `v${APP_VERSION}`);
setReadyText('pr-scanner-version', `v${SCANNER_MODEL_VERSION}`);
setReadyText('pr-schema', `v${SCANNER_SNAPSHOT_SCHEMA_VERSION} / v${SCANNER_RUNTIME_SCHEMA_VERSION}`);

let started     = false;
let lastTime    = performance.now();
let frameCount  = 0;
let fps         = 0;


// ── Resize-Handler ─────────────────────────────────────────
function resize() {
  const size = resolvePlayerCanvasSize(currentRenderMode, {
    cssWidth: window.innerWidth,
    cssHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  });
  canvas.width = size.width;
  canvas.height = size.height;
  setReadyText('pr-resolution', `${canvas.width}×${canvas.height} / ${window.innerWidth}×${window.innerHeight} / ${window.devicePixelRatio.toFixed(2)}`);
}
resize();
window.addEventListener('resize', resize);

// ── FPS-Messung ────────────────────────────────────────────
function measureFps() {
  frameCount++;
  const now = performance.now();
  if (now - lastTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastTime = now;
    sbFps.textContent = fps + ' FPS';
  }
  requestAnimationFrame(measureFps);
}
measureFps();

function heartbeatPayload() {
  const state = scannerEffectState.snapshot();
  const diagnostics = started ? renderer.getDiagnostics() : {};
  return {
    timestamp: Date.now(),
    instanceId: playerInstanceId,
    runtimeSequence: state.sequence,
    generation: state.generation,
    activeEffect: state.activeEffect,
    selectedEffect: state.selectedEffect,
    source: state.source,
    quality: diagnostics.adaptiveQualityState?.name || 'unknown',
  };
}

function announceReady() {
  bridge.send('player-ready', {
    ...heartbeatPayload(),
    appVersion: APP_VERSION,
    scannerVersion: SCANNER_MODEL_VERSION,
    snapshotSchemaVersion: SCANNER_SNAPSHOT_SCHEMA_VERSION,
    runtimeSchemaVersion: SCANNER_RUNTIME_SCHEMA_VERSION,
    effectState: scannerEffectState.snapshot(),
  });
}

setInterval(() => {
  if (started) bridge.send('player-heartbeat', heartbeatPayload());
}, 500);
window.addEventListener('beforeunload', () => {
  bridge.send('player-closed', { instanceId: playerInstanceId, timestamp: Date.now() });
});

// ── Bridge-Events ──────────────────────────────────────────
bridge.on('config', (config) => {
  try {
    if (!config || !config.scannerPrototype) {
      throw new TypeError('Player config is missing scannerPrototype');
    }
    if (!started) {
      renderer.start(config);
      started = true;
    // Overlay ausblenden
    setReadyText('pr-status', 'CONNECTED');
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 900);

    // Status kurz zeigen
    statusBar.classList.add('show');
    setTimeout(() => { statusBar.classList.remove('show'); }, 4000);

    // Hinweis ausblenden
    setTimeout(() => { fsHint.style.opacity = '0'; }, 6000);

    // Control Panel über bereitschaft informieren
    announceReady();
    } else {
      renderer.updateConfig(config);
    }
  } catch (error) {
    console.error('[Player] Config initialization/update failed', {
      message: error?.message || String(error),
      stack: error?.stack || 'no stack',
      runtimeSequence: config?.scannerRuntimeState?.sequence ?? null,
      runtimeGeneration: config?.scannerRuntimeState?.generation ?? null,
    });
    throw error;
  }
});

bridge.on('audio', (audioData) => {
  if (started) {
    renderer.updateAudio(audioData);
    if (audioData.scannerSnapshot) renderer.updateScannerAudioSnapshot(audioData.scannerSnapshot);
  }
});

bridge.on('scanner-clock-probe', (probe) => {
  if (!started || probe?.targetInstanceId !== playerInstanceId) return;
  bridge.send('scanner-clock-report', {
    ...renderer.applyScannerClockProbe(probe),
    instanceId: playerInstanceId,
    probeSequence: probe.sequence,
  });
});

bridge.on('scanner-load-test', ({ action, options }) => {
  if (!started) return;
  if (action === 'start') renderer.startScannerLoadTest(options);
  if (action === 'stop') renderer.stopScannerLoadTest();
});

bridge.on('command', ({ cmd }) => {
  if (cmd === 'fullscreen') {
    requestFullscreen();
  }
});

// ── Vollbild ───────────────────────────────────────────────
function requestFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((e) => {
      console.warn('Vollbild nicht möglich:', e.message);
    });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) ||
      !event.target.closest('#player-performance-panel, #player-ready-panel')) requestFullscreen();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { /* ESC verlässt Vollbild automatisch */ }
  if (e.key === 'f' || e.key === 'F') requestFullscreen();
  if (e.key === 'd' || e.key === 'D') readyPanel.classList.toggle('visible');
});

setInterval(() => {
  if (!started) return;
  const diagnostics = renderer.getDiagnostics();
  setReadyText('pr-clock', Number.isFinite(diagnostics.clockDeltaMs)
    ? `${diagnostics.clockDeltaMs.toFixed(2)} ms`
    : 'nicht verfügbar');
  setReadyText('pr-snapshots', `${diagnostics.lateSnapshots || 0} spaet / ${diagnostics.droppedSnapshots || 0} verworfen`);
  setReadyText('pr-quality', diagnostics.adaptiveQualityState?.name || '-');
  setReadyText('pr-visibility', `${diagnostics.environment?.visibilityState || 'unknown'} / ${diagnostics.environment?.suspectedThrottling || 'unknown'}`);
  const catchUp = diagnostics.catchUpCumulative;
  setReadyText('pr-catch-up', catchUp
    ? `${(catchUp.droppedExposureScannerTime * 1000).toFixed(1)} ms / ${catchUp.droppedScannerPoints} Punkte / ${catchUp.droppedShowEvents} Events`
    : 'nicht verfügbar');
  if (playerPerformanceRunning && diagnostics.loadTest?.summary) {
    playerPerformanceRunning = false;
    const cssRect = canvas.getBoundingClientRect();
    lastPerformanceResult = createPlayerPerformanceResult({
      diagnostics,
      canvas,
      css: { width: cssRect.width, height: cssRect.height },
      devicePixelRatio: window.devicePixelRatio,
      durationSeconds: diagnostics.loadTest.summary.durationSeconds,
      renderMode: currentRenderMode,
      versions: {
        app: APP_VERSION,
        scanner: SCANNER_MODEL_VERSION,
        snapshotSchema: SCANNER_SNAPSHOT_SCHEMA_VERSION,
        runtimeSchema: SCANNER_RUNTIME_SCHEMA_VERSION,
      },
    });
    document.getElementById('pp-status').textContent =
      `Abgeschlossen: ${lastPerformanceResult.resultValidity}`;
    document.getElementById('pp-result').textContent = JSON.stringify(lastPerformanceResult, null, 2);
    document.getElementById('pp-start').disabled = false;
    document.getElementById('pp-export').disabled = false;
    localStorage.setItem('beamer-lasershow-player-performance-result', JSON.stringify(lastPerformanceResult));
    bridge.send('player-performance-result', lastPerformanceResult);
  }
}, 500);

function ensureDemoStarted() {
  if (started) return;
  const config = structuredClone(DEFAULT_CONFIG);
  config.effect = DEMO_FALLBACK.effect;
  config.scannerPrototype.enabled = true;
  renderer.setDemoMode(true);
  renderer.start(config);
  started = true;
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 900);
  document.getElementById('sb-text').textContent = 'DEMO MODUS';
  setReadyText('pr-status', 'DEMO');
  statusBar.classList.add('show');
  setTimeout(() => { statusBar.classList.remove('show'); }, 3500);
  announceReady();
}

const resolutionSelect = document.getElementById('pp-resolution');
if ([...resolutionSelect.options].some((option) => option.value === currentRenderMode)) {
  resolutionSelect.value = currentRenderMode;
} else {
  currentRenderMode = 'native';
}
resolutionSelect.addEventListener('change', () => {
  if (playerPerformanceRunning) return;
  currentRenderMode = resolutionSelect.value;
  resize();
});

document.getElementById('pp-start').addEventListener('click', () => {
  ensureDemoStarted();
  currentRenderMode = resolutionSelect.value;
  resize();
  const durationSeconds = Math.max(1, Number(document.getElementById('pp-duration').value) || 60);
  renderer.startScannerLoadTest({
    mode: SCANNER_TEST_MODES.REAL,
    durationSeconds,
    seed: 0x15a5e,
    startQuality: 'full',
    effectPhaseDurationSeconds: Math.max(1, durationSeconds / 2),
    expectedDisplayFps: Number(document.getElementById('pp-display-fps').value) || 60,
  });
  playerPerformanceRunning = true;
  lastPerformanceResult = null;
  document.getElementById('pp-start').disabled = true;
  document.getElementById('pp-export').disabled = true;
  document.getElementById('pp-status').textContent =
    `Läuft im Vordergrund: ${currentRenderMode}, ${canvas.width}×${canvas.height} Canvas-Pixel`;
  document.getElementById('pp-result').textContent = 'Messung läuft. Hintergrundwechsel macht das Ergebnis ungültig.';
});

document.getElementById('pp-export').addEventListener('click', () => {
  if (!lastPerformanceResult) return;
  const blob = new Blob([JSON.stringify(lastPerformanceResult, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `beamer-lasershow-player-performance-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

// Cursor nach Inaktivität ausblenden
let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.style.cursor = 'default';
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2000);
});

// ── Demo starten wenn kein Control Panel verbunden ─────────
// Nach 3 s ohne Verbindung → Demo-Modus anzeigen
setTimeout(ensureDemoStarted, performanceMode ? 0 : 3000);
