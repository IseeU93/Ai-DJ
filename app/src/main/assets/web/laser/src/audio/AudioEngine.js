// ============================================================
// AudioEngine.js – Web Audio API Analysis Pipeline v2
//
// Complete rewrite: replaces the old 3-band + single-beat
// system with a multi-layer analysis pipeline:
//
//   1. SpectralDecomposer  → 8-band perceptual frequency analysis
//   2. TransientDetector   → Kick/snare/hihat/clap separation
//   3. RhythmAnalyzer      → BPM, beat grid, groove, downbeat
//   4. EnergyTracker       → Build/drop/break detection, drama arc
//   5. HarmonyAnalyzer     → Chromagram, key detection, color
//
// The output is a rich data contract that includes legacy
// fields (bass/mid/high/isBeat) for backward compatibility
// with existing effects, plus detailed analysis for new features.
// ============================================================

import { SpectralDecomposer } from './SpectralDecomposer.js';
import { TransientDetector }  from './TransientDetector.js';
import { RhythmAnalyzer }     from './RhythmAnalyzer.js';
import { EnergyTracker }      from './EnergyTracker.js';
import { HarmonyAnalyzer }    from './HarmonyAnalyzer.js';

export class AudioEngine {
  constructor() {
    this.context    = null;
    this.source     = null;
    this.stream     = null;

    // Dual-FFT setup: small for transients, large for harmony
    this.fftSizeSmall = 2048;   // Low latency for transient detection
    this.fftSizeLarge = 4096;   // High resolution for harmony/pitch

    this.analyserSmall = null;
    this.analyserLarge = null;

    // FFT data buffers
    this._freqDataSmall  = null;
    this._freqDataLarge  = null;
    this._timeDataSmall  = null;

    // ── Analysis Pipeline ────────────────────────────────
    this._spectral  = null;  // SpectralDecomposer
    this._transient = null;  // TransientDetector
    this._rhythm    = null;  // RhythmAnalyzer
    this._energy    = null;  // EnergyTracker
    this._harmony   = null;  // HarmonyAnalyzer

    // ── Legacy Public Fields (backward compat) ───────────
    this.bass      = 0;
    this.mid       = 0;
    this.high      = 0;
    this.amplitude = 0;
    this.isBeat    = false;
    this.bpm       = 0;
    this.lockedBpm = 0;
    this.spotifyBpm = 0;
    this.beatCount  = 0;
    this.beatIndex  = 0;
    this.beatPhase  = 0;
    this.measurePhase = 0;
    this.isVirtualBeat = false;
    this.musicState = 'chill';
    this.energyTrend = 0;

    this.isRunning  = false;
    this._animFrame = null;
    // EnergyTracker/RhythmAnalyzer/TransientDetector rechnen mit
    // Fenstern in Sample-ANZAHL (z.B. "60 Frames ≈ 1s"), nicht in
    // echter Zeit - abgeleitet, weil dieser Loop mal an requestAnimation
    // Frame hing (60Hz-Displays). Auf einem 144Hz/240Hz-Display lief
    // dieselbe Analyse entsprechend schneller, und die Fenster deckten
    // dann nur noch einen Bruchteil der angenommenen Zeitspanne ab -
    // kickDensity/hihatDensity/trend wurden systematisch zu niedrig
    // geschätzt, was u.a. die Drop-Erkennung (kickDensity > 0.10)
    // seltener auslösen liess. requestAnimationFrame bleibt fürs
    // Scheduling (pausiert im Hintergrundtab), die eigentliche Analyse
    // läuft aber hart auf ~60Hz gedeckelt.
    this._lastAnalyzeAt = null;
    this._analyzeIntervalMs = 1000 / 60;

    /** Callback: (audioData) => void */
    this.onAnalysis = null;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Initialize the engine with a MediaStream.
   * @param {MediaStream} stream
   */
  async init(stream) {
    this.destroy();

    this.stream  = stream;
    this.context = new AudioContext();

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    // ── Small analyser (transients, spectral bands) ──────
    this.analyserSmall = this.context.createAnalyser();
    this.analyserSmall.fftSize = this.fftSizeSmall;
    // 0.6 verschmierte jeden Kick über drei bis vier Frames - bei
    // schnellen Kicks blieb dann pro Frame kaum Flux übrig. 0.4 hält
    // die Attacks scharf; die Bänder glätten selbst nach.
    this.analyserSmall.smoothingTimeConstant = 0.4;

    // ── Large analyser (harmony, pitch) ──────────────────
    this.analyserLarge = this.context.createAnalyser();
    this.analyserLarge.fftSize = this.fftSizeLarge;
    this.analyserLarge.smoothingTimeConstant = 0.85; // More smoothing for stable pitch

    // Allocate data buffers
    this._freqDataSmall = new Uint8Array(this.analyserSmall.frequencyBinCount);
    this._freqDataLarge = new Uint8Array(this.analyserLarge.frequencyBinCount);
    this._timeDataSmall = new Uint8Array(this.fftSizeSmall);

    // Connect source to both analysers
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.analyserSmall);
    this.source.connect(this.analyserLarge);
    // NOT connected to destination – no audio feedback

    // ── Initialize pipeline modules ──────────────────────
    const sr = this.context.sampleRate;
    this._spectral  = new SpectralDecomposer(sr, this.fftSizeSmall);
    this._transient = new TransientDetector(sr, this.fftSizeSmall);
    this._rhythm    = new RhythmAnalyzer();
    this._energy    = new EnergyTracker();
    this._harmony   = new HarmonyAnalyzer(sr, this.fftSizeLarge);

    // Apply Spotify BPM if set
    if (this.spotifyBpm > 0) {
      this._rhythm.spotifyBpm = this.spotifyBpm;
    }

    this.isRunning = true;
    this._analyze();
  }

  /** Stop the engine and release all resources. */
  destroy() {
    this.isRunning = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);

    if (this.source)  this.source.disconnect();
    if (this.context) this.context.close();
    if (this.stream)  this.stream.getTracks().forEach((t) => t.stop());

    this.context       = null;
    this.analyserSmall = null;
    this.analyserLarge = null;
    this.source        = null;
    this.stream        = null;
    this._animFrame    = null;
    this._spectral     = null;
    this._transient    = null;
    this._rhythm       = null;
    this._energy       = null;
    this._harmony      = null;
  }

  // ------------------------------------------------------------------
  // Internal Analysis Pipeline
  // ------------------------------------------------------------------

  _analyze() {
    if (!this.isRunning || !this.analyserSmall) return;

    const now = performance.now();

    // Analyse hart auf ~60Hz deckeln, unabhängig davon, wie oft raf
    // auf diesem Display tickt (siehe Kommentar im Konstruktor).
    if (this._lastAnalyzeAt !== null && (now - this._lastAnalyzeAt) < (this._analyzeIntervalMs - 1)) {
      this._animFrame = requestAnimationFrame(() => this._analyze());
      return;
    }
    this._lastAnalyzeAt = now;

    // ── Fetch raw FFT data ──────────────────────────────
    this.analyserSmall.getByteFrequencyData(this._freqDataSmall);
    this.analyserSmall.getByteTimeDomainData(this._timeDataSmall);
    this.analyserLarge.getByteFrequencyData(this._freqDataLarge);

    // ── 1. Spectral Decomposition (8 bands) ─────────────
    this._spectral.analyze(this._freqDataSmall, this._timeDataSmall, now);

    // ── 2. Transient Detection (kick/snare/hihat/clap) ──
    this._transient.analyze(this._freqDataSmall, now);

    // ── 3. Rhythm Analysis (BPM, phase, groove) ─────────
    this._rhythm.analyze(
      this._transient, // Pass full transient state
      this._energy ? this._energy.level : 0,
      this._spectral.bass,
      now
    );

    // ── 4. Energy & Drama Tracking ──────────────────────
    this._energy.analyze(
      this._spectral.bands,
      this._transient,
      this._spectral.amplitude,
      this._spectral.spectralCentroid,
      this._rhythm.bpm,
      now
    );

    // ── 5. Harmony Analysis (chromagram, key) ───────────
    this._harmony.analyze(this._freqDataLarge, now);

    // ── Update legacy fields ────────────────────────────
    this.bass         = this._spectral.bass;
    this.mid          = this._spectral.mid;
    this.high         = this._spectral.high;
    this.amplitude    = this._spectral.amplitude;
    this.isBeat       = this._transient.isBeat;
    this.bpm          = this._rhythm.bpm;
    this.lockedBpm    = this._rhythm.lockedBpm;
    this.beatCount    = this._rhythm.beatCount;
    this.beatIndex    = this._rhythm.beatIndex;
    this.beatPhase    = this._rhythm.beatPhase;
    this.measurePhase = this._rhythm.measurePhase;
    this.isVirtualBeat = this._rhythm.isVirtualBeat;
    this.musicState   = this._energy.musicState;
    this.energyTrend  = this._energy.level;

    // ── Build rich output ───────────────────────────────
    if (this.onAnalysis) {
      this.onAnalysis({
        // ── Spectral (8 bands) ──────────────────────
        bands: this._spectral.getSnapshot(),

        // ── Legacy (backward compat) ────────────────
        bass:           this.bass,
        mid:            this.mid,
        high:           this.high,
        amplitude:      this.amplitude,
        frequencyData:  this._freqDataSmall,
        timeDomainData: this._timeDataSmall,

        // ── Transients ──────────────────────────────
        transients: this._transient.getSnapshot(),
        isBeat:     this.isBeat,

        // ── Rhythm ──────────────────────────────────
        bpm:           Math.round(this.spotifyBpm || this._rhythm.lockedBpm || this._rhythm.bpm),
        bpmConfidence: this._rhythm.bpmConfidence,
        beatPhase:     this.beatPhase,
        beatIndex:     this.beatIndex,
        measurePhase:  this.measurePhase,
        beatCount:     this.beatCount,
        downbeat:      this._rhythm.downbeat,
        // Musikalische Struktur aus dem Beat-Grid (siehe RhythmAnalyzer)
        gridBeat:        this._rhythm.gridBeat,
        barBoundary:     this._rhythm.barBoundary,
        phraseBoundary:  this._rhythm.phraseBoundary,
        sectionBoundary: this._rhythm.sectionBoundary,
        barCount:        this._rhythm.barCount,
        isVirtualBeat: this.isVirtualBeat,
        groove:        this._rhythm.groove,
        tempoChange:   this._rhythm.tempoChange,
        lastBeatTime:  this._rhythm._lastBeatTime,

        // ── Energy & Structure ──────────────────────
        energy:      this._energy.getSnapshot(),
        musicState:  this.musicState,
        energyTrend: this.energyTrend,

        // ── Harmony ─────────────────────────────────
        harmony: this._harmony.getSnapshot(),

        // ── Spectral features ───────────────────────
        spectralCentroid: this._spectral.spectralCentroid,
      });
    }

    this._animFrame = requestAnimationFrame(() => this._analyze());
  }

  // ------------------------------------------------------------------
  // Demo Mode (without real audio)
  // ------------------------------------------------------------------

  /**
   * Returns simulated audio data for preview without a microphone.
   * Now produces the full rich data contract for demo mode.
   * @param {number} t – time in seconds
   */
  static getDemoData(t) {
    const bass      = 0.4 + 0.3 * Math.abs(Math.sin(t * 1.8));
    const mid       = 0.3 + 0.2 * Math.abs(Math.sin(t * 2.7 + 1));
    const high      = 0.15 + 0.15 * Math.abs(Math.sin(t * 5.1 + 2));
    const amplitude = 0.4 + 0.25 * Math.abs(Math.sin(t * 1.2));

    // Simulated beat ~120 BPM
    const beatInterval = 0.5; // 120 BPM
    const beatPhase = (t % beatInterval) / beatInterval;
    const isBeat    = beatPhase < 0.04;
    const beatIndex = Math.floor((t / beatInterval) % 4);
    const measurePhase = (beatIndex + beatPhase) / 4.0;

    // Fake FFT
    const frequencyData  = new Uint8Array(1024);
    const timeDomainData = new Uint8Array(2048);

    for (let i = 0; i < frequencyData.length; i++) {
      const falloff = Math.exp(-i / 150);
      frequencyData[i] = Math.floor(
        falloff * 200 * (bass + 0.2 * Math.sin(t * 3 + i * 0.1)) +
        (1 - falloff) * 80 * mid * Math.random()
      );
    }
    for (let i = 0; i < timeDomainData.length; i++) {
      timeDomainData[i] = 128 + Math.floor(
        60 * amplitude * Math.sin((i / timeDomainData.length) * Math.PI * 6 + t * 10)
      );
    }

    // Simulated transients
    const isKick  = isBeat && beatIndex % 2 === 0;
    const isSnare = isBeat && beatIndex % 2 === 1;
    const isHihat = (t * 8) % 1 < 0.03; // 8th notes
    const kickVel = isKick ? 0.7 + Math.random() * 0.3 : 0;
    const snareVel = isSnare ? 0.6 + Math.random() * 0.3 : 0;

    // Simulated energy phase
    const cyclePos = (t % 32) / 32; // 32-second cycle
    let phase = 'verse';
    let tension = 0.3;
    if (cyclePos < 0.1)      { phase = 'intro'; tension = 0.1; }
    else if (cyclePos < 0.4) { phase = 'verse'; tension = 0.3; }
    else if (cyclePos < 0.6) { phase = 'build'; tension = 0.3 + (cyclePos - 0.4) / 0.2 * 0.7; }
    else if (cyclePos < 0.8) { phase = 'drop';  tension = 0.1; }
    else                     { phase = 'break'; tension = 0.2; }

    // Energy-based music state
    let musicState = 'dance';
    if (phase === 'intro' || phase === 'break') musicState = 'chill';
    if (phase === 'drop') musicState = 'hardcore';

    // lastBeatTime for HotBeams-Strobe
    const lastBeatTime = performance.now() - (beatPhase * beatInterval * 1000);

    return {
      // Spectral bands
      bands: {
        sub:        { energy: bass * 0.6, smoothed: bass * 0.5, onset: isKick, envelope: bass * 0.55 },
        kick:       { energy: bass * 0.8, smoothed: bass * 0.7, onset: isKick, envelope: bass * 0.75 },
        lowMid:     { energy: mid * 0.5, smoothed: mid * 0.45, onset: false, envelope: mid * 0.4 },
        mid:        { energy: mid * 0.7, smoothed: mid * 0.65, onset: false, envelope: mid * 0.6 },
        upperMid:   { energy: mid * 0.4, smoothed: mid * 0.35, onset: isSnare, envelope: mid * 0.3 },
        presence:   { energy: high * 0.6, smoothed: high * 0.55, onset: isSnare, envelope: high * 0.5 },
        brilliance: { energy: high * 0.4, smoothed: high * 0.35, onset: isHihat, envelope: high * 0.3 },
        air:        { energy: high * 0.2, smoothed: high * 0.15, onset: false, envelope: high * 0.1 },
      },

      // Legacy
      bass, mid, high, amplitude,
      frequencyData, timeDomainData,

      // Transients
      transients: {
        kick:  { hit: isKick,  velocity: kickVel,  timeSinceLast: isKick  ? 0 : 200 },
        snare: { hit: isSnare, velocity: snareVel, timeSinceLast: isSnare ? 0 : 300 },
        hihat: { hit: isHihat, velocity: isHihat ? 0.5 : 0, timeSinceLast: isHihat ? 0 : 100 },
        clap:  { hit: false,   velocity: 0, timeSinceLast: 1000 },
      },
      isBeat,

      // Rhythm
      bpm: 120,
      bpmConfidence: 0.9,
      beatPhase,
      beatIndex,
      measurePhase,
      beatCount: Math.floor(t * 2),
      downbeat: isBeat && beatIndex === 0,
      isVirtualBeat: beatPhase < 0.1,
      groove: new Float32Array([1,0,0.3,0, 0.8,0,0.3,0, 1,0,0.3,0, 0.8,0,0.5,0]),
      tempoChange: 'steady',
      lastBeatTime,

      // Energy
      energy: {
        level: amplitude * 0.8,
        trend: phase === 'build' ? 'rising' : (phase === 'break' ? 'falling' : 'steady'),
        tension,
        phase,
        dropImminent: phase === 'build' && tension > 0.8,
        timeSinceLastDrop: phase === 'drop' ? 500 : 10000,
        musicState,
      },
      musicState,
      energyTrend: amplitude * 0.8,

      // Harmony
      harmony: {
        chromagram: new Float32Array([0.2,0.05,0.1,0.05,0.8,0.1,0.05,0.6,0.05,0.3,0.05,0.1]),
        dominantNote: 'E',
        estimatedKey: 'E minor',
        keyConfidence: 0.7,
        suggestedPalette: ['#00ff41', '#00cc33', '#008822', '#39ff14'],
        chordChanged: Math.random() < 0.02,
        dissonance: 0.15,
      },

      // Spectral features
      spectralCentroid: 2400 + Math.sin(t * 0.5) * 800,
    };
  }
}
