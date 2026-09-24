// Lasershow im Mixer: hört direkt am Master-Ausgang mit (echte Transienten/Spektrum), bekommt die
// Struktur aber aus der MP3-Analyse der laufenden Tracks (Beatgrid, Phrasen, Builds, Drops,
// Tonart, Musikrichtung) und aus dem Mixer (welcher Track gerade trägt, wann der Übergang kippt).
// Rendert in eine Canvas im Mixer-Fenster und optional zusätzlich in ein eigenes Beamer-Fenster.
import { AudioEngine } from '../src/audio/AudioEngine.js';
import { SpectralDecomposer } from '../src/audio/SpectralDecomposer.js';
import { TransientDetector } from '../src/audio/TransientDetector.js';
import { RhythmAnalyzer } from '../src/audio/RhythmAnalyzer.js';
import { EnergyTracker } from '../src/audio/EnergyTracker.js';
import { HarmonyAnalyzer } from '../src/audio/HarmonyAnalyzer.js';
import { LaserRenderer } from '../src/visuals/LaserRenderer.js';
import { BroadcastBridge } from '../src/shared/BroadcastBridge.js';
import { DEFAULT_CONFIG } from '../src/shared/Config.js';
import { ScannerClock } from '../src/visuals/scanner/ScannerClock.js';
import { ScannerEffectState } from '../src/visuals/scanner/ScannerEffectState.js';
import { createScannerAudioSnapshot } from '../src/visuals/scanner/AudioSnapshotBuffer.js';
import { Choreographer } from '../src/show/Choreographer.js';
import { AutoPunctuation } from '../src/show/AutoPunctuation.js';
import { insightAt, boundariesBetween, keyPalette, GENRE_ESCALATION } from './insight.js';

const STORE = 'automix.laser';
const SLOW = new Set(['liquidSky', 'snake', 'lissajous', 'waveform']);
const AGGRESSIVE = new Set(['chaosBlades', 'hotBeams', 'spiral', 'scanner']);
const UPTEMPO_CALM = ['tunnel', 'lsdTunnel', 'spiral', 'hotBeams'];
const LOW_KILLED = -15; // dB: Bass dieses Decks ist rausgedreht -> der andere trägt den Groove

/** Die Analyse-Pipeline der Lasershow, aber an einem vorhandenen Knoten statt an einem Mikrofon. */
class MixTap extends AudioEngine {
  attach(ctx, node) {
    this.context = ctx;
    this.analyserSmall = ctx.createAnalyser();
    this.analyserSmall.fftSize = this.fftSizeSmall;
    this.analyserSmall.smoothingTimeConstant = 0.4;
    this.analyserLarge = ctx.createAnalyser();
    this.analyserLarge.fftSize = this.fftSizeLarge;
    this.analyserLarge.smoothingTimeConstant = 0.85;
    this._freqDataSmall = new Uint8Array(this.analyserSmall.frequencyBinCount);
    this._freqDataLarge = new Uint8Array(this.analyserLarge.frequencyBinCount);
    this._timeDataSmall = new Uint8Array(this.fftSizeSmall);
    this.source = node;
    node.connect(this.analyserSmall);
    node.connect(this.analyserLarge);
    const sr = ctx.sampleRate;
    this._spectral = new SpectralDecomposer(sr, this.fftSizeSmall);
    this._transient = new TransientDetector(sr, this.fftSizeSmall);
    this._rhythm = new RhythmAnalyzer();
    this._energy = new EnergyTracker();
    this._harmony = new HarmonyAnalyzer(sr, this.fftSizeLarge);
    this.isRunning = true;
    // Takt per Timer statt requestAnimationFrame: rAF steht still, sobald das Mixer-Fenster
    // minimiert ist – das Beamer-Fenster soll dann trotzdem weiterlaufen.
    this._timer = setInterval(() => {
      if (!this.isRunning) return;
      this._lastAnalyzeAt = null;
      super._analyze();
      cancelAnimationFrame(this._animFrame);
    }, 1000 / 60);
  }

  _analyze() {
    /* Takt kommt vom Timer in attach() */
  }

  destroy() {
    this.isRunning = false;
    clearInterval(this._timer);
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    try {
      this.source?.disconnect(this.analyserSmall);
      this.source?.disconnect(this.analyserLarge);
    } catch {
      /* schon getrennt */
    }
    this.source = null;
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

export class LaserStage extends EventTarget {
  constructor({ engine, conductor, canvas }) {
    super();
    this.engine = engine;
    this.conductor = conductor;
    this.canvas = canvas;
    const saved = loadSettings();
    this.settings = {
      autopilot: true, // Choreograph wählt Effekte/Farben
      trackSync: true, // Struktur aus der MP3-Analyse statt geraten
      keyColors: true, // Farben aus der Tonart des Tracks
      intensity: 'auto', // 'auto' = nach Musikrichtung, sonst 0..1
      strobe: true,
      effect: DEFAULT_CONFIG.effect,
      palette: DEFAULT_CONFIG.palette,
      ...saved,
    };
    this.config = structuredClone(DEFAULT_CONFIG);
    this.scannerClock = new ScannerClock();
    this.effectState = new ScannerEffectState({
      selectedEffect: this.settings.effect,
      prototypeEnabled: this.config.scannerPrototype.enabled,
    });
    this.choreo = new Choreographer();
    this.punct = new AutoPunctuation();
    // eigener Effekt-Zustand für die Vorschau (wie im Beamer-Player): teilt sie sich den mit der
    // Steuerung, sieht der Renderer nie eine Änderung und bleibt beim ersten Effekt hängen
    this.renderer = new LaserRenderer(canvas, { scannerClock: this.scannerClock, scannerEffectState: new ScannerEffectState({ selectedEffect: this.settings.effect }) });
    this.bridge = new BroadcastBridge('master');
    this.tap = new MixTap();
    this.visible = false;
    this.manualBlackout = false;
    this.beamerSeenAt = -Infinity;
    this.prev = null; // letzter Track-Zustand
    this.carrier = -1; // Deck, das gerade den Groove trägt
    this.beatCount = 0;
    this.seq = 0;
    this.discrete = { effect: null, blackout: false, freeze: false };
    this.sig = null;
    this.appliedAt = 0;
    this.lastConfigSent = 0;
    this.status = { deck: -1, phase: '-', beatsToDrop: Infinity, bpm: 0, key: null, mixing: false };
    this.applySettings();

    this.bridge.on('player-ready', () => {
      this.beamerSeenAt = performance.now();
      this.sendConfig();
    });
    this.bridge.on('player-heartbeat', () => (this.beamerSeenAt = performance.now()));
    this.bridge.on('player-closed', () => (this.beamerSeenAt = -Infinity));

    new ResizeObserver(() => this.fit()).observe(canvas);
  }

  /** Startet das Mithören am Master. Muss nach dem ersten Nutzer-Klick passieren (AudioContext). */
  async ensureRunning() {
    if (this.tap.isRunning) return;
    this.tap.isRunning = true; // sofort belegen: zwei gleichzeitige Aufrufe dürfen nicht doppelt starten
    if (this.engine.ctx.state === 'suspended') await this.engine.ctx.resume().catch(() => {});
    this.tap.onAnalysis = (d) => this.onFrame(d);
    // vor dem Master-Regler abgreifen: leiser drehen soll die Show nicht dimmen
    this.tap.attach(this.engine.ctx, this.engine.limiter || this.engine.master);
  }

  get beamerOpen() {
    return performance.now() - this.beamerSeenAt < 3000;
  }

  // ---------------------------------------------------------------- Anzeige

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) {
      this.fit();
      this.renderer.start(this.runtimeConfig());
      this.ensureRunning();
    } else {
      this.renderer.stop();
    }
  }

  fit() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(dpr, 1920 / r.width); // Vorschau nicht größer als Full HD rendern
    this.renderer.resize(Math.round(r.width * scale), Math.round(r.height * scale));
  }

  async openBeamer() {
    await this.ensureRunning();
    this.beamerSeenAt = performance.now(); // ab jetzt Daten schicken, das Fenster meldet sich gleich
    const tauri = window.__TAURI__?.core;
    if (tauri) await tauri.invoke('show_laser_window');
    else window.open('laser/player.html', 'automix-laser', 'width=1280,height=720');
    this.sendConfig();
  }

  // ---------------------------------------------------------------- Einstellungen

  set(name, value) {
    this.settings[name] = value;
    try {
      localStorage.setItem(STORE, JSON.stringify(this.settings));
    } catch {
      /* egal */
    }
    this.applySettings();
    this.emitStatus();
  }

  toggleBlackout() {
    this.manualBlackout = !this.manualBlackout;
    this.config.blackout = this.manualBlackout;
    this.apply();
    this.emitStatus();
  }

  applySettings() {
    const s = this.settings;
    this.config.autopilot = false;
    this.config.choreographer.enabled = s.autopilot;
    this.config.autoStrobe.enabled = s.strobe;
    if (!s.autopilot) {
      this.config.effect = s.effect;
      this.config.palette = s.palette;
      this.config._overlayEffect = null;
      this.config._overlayEffects = [];
      this.config._strobeGate = null;
    }
    this.apply();
  }

  runtimeConfig() {
    this.effectState.selectManual(this.config.effect);
    this.effectState.setPrototypeEnabled(this.config.scannerPrototype.enabled);
    return { ...this.config, scannerRuntimeState: this.effectState.snapshot() };
  }

  apply() {
    if (this.manualBlackout) this.config.blackout = true;
    const cfg = this.runtimeConfig();
    if (this.visible) this.renderer.updateConfig(cfg);
    this.sendConfig(cfg);
  }

  sendConfig(cfg = null) {
    if (!this.beamerOpen) return;
    cfg = cfg || this.runtimeConfig();
    this.lastConfigSent = performance.now();
    this.bridge.send('config', { ...cfg, scannerClock: this.scannerClock.snapshot() });
  }

  // ---------------------------------------------------------------- Mixer -> Musikzustand

  /** Welches Deck trägt gerade (lautester Kanal, Bass zählt doppelt)? */
  carrierDeck() {
    let best = -1;
    let bestW = 0.05;
    this.engine.decks.forEach((d, i) => {
      if (!d.status.playing || !d.track?.analysis) return;
      let w = d.fader.gain.value * d.xfade.gain.value;
      if (d.get('low') < LOW_KILLED) w *= 0.4;
      if (i === this.carrier) w *= 1.15; // kein Flattern bei Gleichstand
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    });
    return best;
  }

  trackState() {
    const i = this.carrierDeck();
    if (i < 0) return null;
    const d = this.engine.decks[i];
    const ctx = this.engine.ctx;
    // was gerade aus den Boxen kommt, nicht was der Worklet schon rechnet
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const sec = d.realAt(this.engine.now - latency) / this.engine.sr;
    const t = d.track;
    const ins = insightAt(t.analysis, sec, t.genre);
    if (!ins) return null;
    return { deck: i, track: t, ins, rate: d.status.rate || 1 };
  }

  // ---------------------------------------------------------------- Pro Analyse-Frame

  onFrame(data) {
    const st = this.settings.trackSync ? this.trackState() : null;
    if (st) this.enrich(data, st);
    else {
      this.prev = null;
      this.carrier = -1;
    }
    this.status = {
      deck: st?.deck ?? -1,
      phase: st?.ins.phase ?? data.energy?.phase ?? '-',
      beatsToDrop: st?.ins.beatsToDrop ?? Infinity,
      bpm: data.bpm,
      key: st?.track.analysis.key?.camelot ?? null,
      genre: st?.track.genre ?? null,
      mixing: !!this.conductor.plan?.committed,
      title: st?.track.title || st?.track.name || '',
    };

    if (this.settings.autopilot) this.showIntelligence(data, st);
    else this.punctuate(data);

    if (this.visible) this.renderer.updateAudio(data);
    this.sendAudio(data);
    if (this.beamerOpen && performance.now() - this.lastConfigSent > 1000) this.sendConfig();
    if (++this.seq % 6 === 0) this.emitStatus();
  }

  emitStatus() {
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  /** Live-Daten mit dem exakten Wissen aus der Track-Analyse überschreiben. */
  enrich(data, st) {
    const { ins, track, rate } = st;
    const a = track.analysis;
    const swapped = st.deck !== this.carrier;
    const b = swapped ? { beat: false, bar: false, phrase: false, section: true } : boundariesBetween(this.prev, ins);
    this.carrier = st.deck;
    this.prev = ins;

    const beatSec = a.beatInterval / rate;
    if (b.beat) this.beatCount++;
    const drumsNow = ins.drums >= 0.25;
    data.bpm = Math.round(a.bpm * rate);
    data.bpmConfidence = 1;
    data.beatPhase = ins.beatPhase;
    data.beatIndex = ins.beatIndex;
    data.measurePhase = ins.measurePhase;
    data.beatCount = this.beatCount;
    data.barCount = ins.bar;
    data.gridBeat = b.beat;
    data.isVirtualBeat = b.beat;
    data.downbeat = b.bar;
    data.barBoundary = b.bar;
    data.phraseBoundary = b.phrase || swapped;
    data.sectionBoundary = b.section;
    // Beat-Blitze exakt im Grid – aber nur, wenn da auch Drums spielen (im Break nicht ins Leere)
    data.isBeat = drumsNow ? b.beat : data.isBeat && ins.drums > 0.1;
    data.lastBeatTime = performance.now() - ins.beatPhase * beatSec * 1000;

    const live = data.energy || {};
    const musicState = ins.phase === 'drop' ? 'hardcore' : ins.phase === 'verse' || ins.phase === 'build' ? 'dance' : 'chill';
    data.energy = {
      ...live,
      phase: ins.phase,
      trend: ins.trend,
      tension: ins.tension,
      dropImminent: ins.dropImminent,
      level: 0.5 * (live.level ?? ins.level) + 0.5 * ins.level,
      vocalness: Math.max(live.vocalness ?? 0, ins.vocal),
      vocalOnly: ins.vocalOnly,
      musicState,
    };
    data.musicState = musicState;
    data.energyTrend = data.energy.level;

    const pal = this.settings.keyColors ? keyPalette(a.key) : null;
    if (pal) {
      data.harmony = {
        ...(data.harmony || {}),
        estimatedKey: a.key?.name,
        keyConfidence: 1,
        suggestedPalette: pal,
        chordChanged: swapped || b.section,
      };
    }
  }

  // ---------------------------------------------------------------- Show-Logik (aus dem Control Panel)

  escalation(st) {
    if (this.settings.intensity !== 'auto') return Number(this.settings.intensity);
    return GENRE_ESCALATION[st?.track.genre] ?? 0.5;
  }

  showIntelligence(data, st) {
    const cfg = this.config;
    this.choreo.escalation = cfg.escalation = this.escalation(st);
    this.choreo.strobeAllowed = cfg.autoStrobe.enabled !== false;
    const d = this.choreo.update(
      {
        energy: data.energy || { level: data.energyTrend || 0, trend: 'steady', phase: 'verse' },
        rhythm: {
          bpm: data.bpm,
          beatCount: data.beatCount,
          downbeat: data.downbeat,
          beatPhase: data.beatPhase,
          barBoundary: data.barBoundary,
          phraseBoundary: data.phraseBoundary,
          sectionBoundary: data.sectionBoundary,
        },
        transients: data.transients || { kick: { hit: data.isBeat }, snare: { hit: false }, hihat: { hit: false }, clap: { hit: false } },
        harmony: data.harmony || { suggestedPalette: null, chordChanged: false },
      },
      performance.now(),
    );
    cfg.effect = d.primaryEffect;
    cfg.palette = d.palette;
    cfg.speed = d.speed;
    cfg.trailLength = d.trailLength;
    cfg.show.mirror = d.mirror;
    cfg.autoRotate = d.autoRotate;
    cfg.show.colorMode = d.colorMode;
    cfg.show.intensity = 'auto';
    if (d.effectConfig && cfg[d.primaryEffect]) Object.assign(cfg[d.primaryEffect], d.effectConfig);
    for (const [k, preset] of Object.entries(d.overlayEffectConfigs || {})) if (cfg[k]) Object.assign(cfg[k], preset);
    const strobe = cfg.autoStrobe.enabled !== false;
    if (strobe && d.hotBeamsConfig) Object.assign(cfg.hotBeams, d.hotBeamsConfig);
    cfg._strobeGate = strobe ? d.strobeGate || null : null;
    cfg.blackout = this.manualBlackout || (cfg.autoBlackout.enabled !== false && Boolean(d.blackout));
    cfg._overlayEffect = d.overlayEffect;
    cfg._overlayEffects = d.overlayEffects || (d.overlayEffect ? [d.overlayEffect] : []);
    cfg._overlayOpacity = d.overlayOpacity;
    cfg._aggression = d.aggression;
    this.hardPassage(cfg, d, data, st);
    // Tonart-Farben: Grundfarbe aus der Tonart des Tracks, pro Phrase eine Nuance weiter. Im Drop
    // behält der Choreograph seine Kontrastfarben (Weiß/Regenbogen), damit der Drop knallt.
    const pal = this.settings.keyColors && st ? keyPalette(st.track.analysis.key) : null;
    if (pal && (d.palette === 'custom' || d.state !== 'climax')) {
      cfg.palette = 'custom';
      cfg.customColor = pal[Math.max(0, st.ins.phraseIndex) % pal.length];
    }

    const sig = [cfg.effect, cfg.palette, cfg.customColor, cfg._overlayEffects.join(','), d.state, cfg.blackout ? 'bo' : '-'].join('|');
    const now = performance.now();
    if (sig !== this.sig || now - this.appliedAt > 40) {
      this.sig = sig;
      this.appliedAt = now;
      this.apply();
    }
  }

  /**
   * Harte Passagen (Hardstyle/Uptempo-Kicks, knallende Drops): der aggressive Balken (Beam Sweep)
   * übernimmt und peitscht im Takt über den Schirm. Langsame, schwebende Effekte (Liquid Sky,
   * Snake, Lissajous, Wellenform) passen zu harten Kicks nicht und fliegen raus – bei Uptempo auch
   * außerhalb der Drops.
   */
  hardPassage(cfg, d, data, st) {
    const genre = st?.track.genre;
    const hardGenre = genre === 'uptempo' || genre === 'hardstyle';
    const ins = st?.ins;
    const kicks = (ins?.drums ?? 0) >= 0.6;
    // nur im echten Drop/Hauptteil mit kräftigen Kicks – nicht jede Strophe
    const loud = ins ? ins.phase === 'drop' : data.energy?.phase === 'drop';
    // Nur harte Musik bekommt den harten Modus: Hardstyle/Uptempo, bei House/EDM nur ganz laute
    // Drops. Pop und Rap nie – dort wirkt das hektisch.
    const hard = loud && kicks && (hardGenre || (genre === 'edm' && (ins?.level ?? 0) > 0.9));
    const bs = cfg.beamSweep;
    if (hard) {
      // höchstens eine Zusatzebene, und nichts Schwebendes
      cfg._overlayEffects = cfg._overlayEffects.filter((e) => e !== 'beamSweep' && !SLOW.has(e)).slice(0, 1);
      cfg._overlayEffect = cfg._overlayEffects[0] || null;
      cfg.effect = 'beamSweep';
      // Tempo nach Zeit statt nach Schlägen: ein Balken quert den Schirm in ~1,1 s (Uptempo ~0,9 s),
      // egal ob 150 oder 250 BPM – sonst wird es bei Uptempo hektisch
      const beatSec = 60 / Math.max(60, data.bpm || 128);
      const perBeat = beatSec / (genre === 'uptempo' ? 0.9 : 1.1);
      bs.speed = Math.max(1, Math.min(8, perBeat <= 0.18 ? (perBeat - 0.045) / 0.045 : 3 + (perBeat - 0.18) / 0.06));
      bs.count = 1;
      bs.maxConcurrent = 1; // ein Balken nach dem anderen, kein Gewimmel
      bs.thickness = 3;
      bs.orientation = 'auto';
      cfg.speed = Math.max(cfg.speed, 1.2);
      cfg.trailLength = Math.min(cfg.trailLength, 0.2);
      this.hard = true;
      return;
    }
    if (this.hard) {
      bs.speed = DEFAULT_CONFIG.beamSweep.speed;
      bs.count = DEFAULT_CONFIG.beamSweep.count;
      bs.thickness = DEFAULT_CONFIG.beamSweep.thickness;
      delete bs.maxConcurrent;
      this.hard = false;
    }
    if (genre === 'pop' || genre === 'rap') {
      // ruhiger Grundcharakter: nicht schneller als normal, keine Trails-Hektik
      cfg.speed = Math.min(cfg.speed, 1);
    }
    if (genre === 'uptempo') {
      // auch in ruhigeren Teilen: nichts Schwebendes, dafür schneller
      if (SLOW.has(cfg.effect)) cfg.effect = UPTEMPO_CALM[Math.max(0, ins?.phraseIndex ?? 0) % UPTEMPO_CALM.length];
      cfg._overlayEffects = cfg._overlayEffects.filter((e) => !SLOW.has(e));
      cfg._overlayEffect = cfg._overlayEffects[0] || null;
      cfg.speed = Math.max(cfg.speed, 1.15);
    }
  }

  punctuate(data) {
    const cfg = this.config;
    const r = this.punct.evaluate(data, cfg, performance.now());
    let changed = false;
    if (r.strobeTriggered) {
      cfg._overlayEffect = r.strobeOverlayEffect || 'chaosBlades';
      this.autoOverlay = cfg._overlayEffect;
      changed = true;
    } else if (r.strobeReleased && cfg._overlayEffect === this.autoOverlay) {
      cfg._overlayEffect = null;
      changed = true;
    }
    if (r.blackoutTriggered) {
      cfg.blackout = true;
      changed = true;
    } else if (r.blackoutReleased) {
      cfg.blackout = this.manualBlackout;
      changed = true;
    }
    if (changed) this.apply();
  }

  // ---------------------------------------------------------------- Daten an Renderer/Beamer

  sendAudio(data) {
    const cap = performance.timeOrigin + performance.now();
    const next = { effect: this.config.effect, blackout: !!this.config.blackout, freeze: !!this.config.freeze };
    const prev = this.discrete;
    const snap = createScannerAudioSnapshot(
      { ...data, movementSpeed: this.config.speed, movementIntensity: this.config.brightness },
      {
        sequence: this.seq,
        capturedAtMs: cap,
        analyzedAtMs: cap,
        showTime: this.scannerClock.now(),
        valid: [data.amplitude, data.bass, data.mid, data.high].every(Number.isFinite),
        confidence: data.bpmConfidence ?? null,
        events: {
          sceneSwitch: next.effect !== prev.effect ? { value: next.effect } : false,
          blackout: next.blackout !== prev.blackout ? { value: next.blackout } : false,
          freeze: next.freeze !== prev.freeze ? { value: next.freeze } : false,
        },
      },
    );
    this.discrete = next;
    if (this.visible) this.renderer.updateScannerAudioSnapshot(snap);
    if (!this.beamerOpen) return;
    const payload = {
      bass: data.bass,
      mid: data.mid,
      high: data.high,
      amplitude: data.amplitude,
      isBeat: data.isBeat,
      bpm: data.bpm,
      lastBeatTime: data.lastBeatTime,
      beatPhase: data.beatPhase,
      beatIndex: data.beatIndex,
      measurePhase: data.measurePhase,
      beatCount: data.beatCount,
      barCount: data.barCount,
      downbeat: data.downbeat,
      gridBeat: data.gridBeat,
      barBoundary: data.barBoundary,
      phraseBoundary: data.phraseBoundary,
      sectionBoundary: data.sectionBoundary,
      isVirtualBeat: data.isVirtualBeat,
      musicState: data.musicState,
      energyTrend: data.energyTrend,
      scannerTime: snap.showTime,
      scannerSnapshot: snap,
      timeDomainData: downsample(data.timeDomainData, 256),
      frequencyData: downsample(data.frequencyData, 64),
    };
    if (data.transients) {
      payload.transients = {};
      for (const k of ['kick', 'snare', 'hihat', 'clap']) {
        const x = data.transients[k] || {};
        payload.transients[k] = { hit: x.hit, velocity: x.velocity };
      }
    }
    if (data.energy) {
      const e = data.energy;
      payload.energy = { level: e.level, trend: e.trend, tension: e.tension, phase: e.phase, dropImminent: e.dropImminent };
    }
    if (data.bands) {
      payload.bands = {};
      for (const [n, band] of Object.entries(data.bands)) payload.bands[n] = { energy: band.energy, onset: band.onset };
    }
    this.bridge.send('audio', payload);
  }
}

function downsample(arr, target) {
  const r = new Uint8Array(target);
  if (!arr) return r;
  const s = arr.length / target;
  for (let i = 0; i < target; i++) r[i] = arr[Math.floor(i * s)];
  return r;
}
