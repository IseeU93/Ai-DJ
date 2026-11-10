// Web-Audio-Graph: zwei Decks (Worklet) -> DJ-Kanalzug -> Master mit Limiter.
//
// Kanalzug pro Deck:
//   Deck -> Trim -> EQ Low/Mid/High -> Vocal-Cut (Mitte/Seite) -> HP/LP-Filter -> Fader -> Crossfader -> Bus
//                                                                         \-> Echo-Send (pre-fader) -> Delay-Schleife -> Bus
//
// Alle Regler sind "logische" Parameter (EQ in dB, Filter -1..1, Vocal 0..1, ...), die auf
// AudioParams abgebildet und sample-genau automatisiert werden können.

export const PARAMS = ['fader', 'low', 'mid', 'high', 'filter', 'vocal', 'echo', 'reverb', 'flanger', 'trim'];
export const NEUTRAL = { fader: 1, low: 0, mid: 0, high: 0, filter: 0, vocal: 0, echo: 0, reverb: 0, flanger: 0, trim: 0 };

/** Künstlicher Hallraum (Impulsantwort aus abklingendem Rauschen, links/rechts verschieden). */
function makeImpulse(ctx, sec = 2.8, decay = 3.2) {
  const n = Math.round(ctx.sampleRate * sec);
  const ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const x = i / n;
      lp += 0.35 * (Math.random() * 2 - 1 - lp); // etwas dunkler als weißes Rauschen
      d[i] = lp * (1 - x) ** decay * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
    }
  }
  return ir;
}

const LP_OPEN = 22000;
const LP_MIN = 180;
const HP_OPEN = 20;
const HP_MAX = 5000;

function filterFreqs(f) {
  if (f < 0) return { lp: LP_OPEN * (LP_MIN / LP_OPEN) ** Math.min(1, -f), hp: HP_OPEN };
  return { lp: LP_OPEN, hp: HP_OPEN * (HP_MAX / HP_OPEN) ** Math.min(1, f) };
}

function filterValue(lp, hp) {
  if (lp < LP_OPEN * 0.97) return -Math.log(lp / LP_OPEN) / Math.log(LP_MIN / LP_OPEN);
  if (hp > HP_OPEN * 1.03) return Math.log(hp / HP_OPEN) / Math.log(HP_MAX / HP_OPEN);
  return 0;
}

export class Engine {
  async init() {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    await ctx.audioWorklet.addModule(new URL('./deck-processor.js', import.meta.url));
    this.ctx = ctx;
    this.sr = ctx.sampleRate;

    // Headroom: zwei überlappende Tracks summieren sich (Kicks im Takt bis +6 dB) –
    // der Bus sitzt deshalb tiefer, der Limiter fängt nur echte Spitzen ab statt dauernd zu pumpen.
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.bus.connect(this.limiter).connect(this.master).connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Kopfhörer-Cue (PFL): jedes Deck kann vor dem Fader auf den Cue-Bus geschickt werden. Im Kopfhörer
    // liegt Cue gemischt mit dem Master (headMix: 0 = nur Cue, 1 = nur Master).
    this.cueBus = ctx.createGain();
    this.headCue = ctx.createGain();
    this.headMaster = ctx.createGain();
    this.headVol = ctx.createGain();
    this.cueBus.connect(this.headCue).connect(this.headVol);
    this.master.connect(this.headMaster).connect(this.headVol);
    this.headMix = 0.5;
    this.headVolume = 0.8;
    this.cueMode = 'off';
    this._applyHeadMix();

    this.impulse = makeImpulse(ctx);
    // Rauschen für Riser/Downlifter (4 s, wird geloopt)
    const nn = this.sr * 4;
    this.noise = ctx.createBuffer(2, nn, this.sr);
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c);
      for (let i = 0; i < nn; i++) d[i] = Math.random() * 2 - 1;
    }
    this.fx = []; // geplante Riser/Downlifter (zum Abbrechen)

    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.setCrossfader(0.5);
  }

  /**
   * Noise-Riser (up) bzw. Downlifter (down): gefiltertes Rauschen, das von t0 bis t1 hochsteigt
   * (Build-up vor dem Drop) bzw. nach dem Drop abfällt und verklingt.
   */
  sweep(t0, t1, { dir = 'up', level = 0.12 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    const up = dir === 'up';
    bp.frequency.setValueAtTime(up ? 350 : 9000, t0);
    bp.frequency.exponentialRampToValueAtTime(up ? 9000 : 300, t1);
    g.gain.setValueAtTime(0.0001, t0);
    if (up) {
      g.gain.exponentialRampToValueAtTime(level, t1 - 0.02);
      g.gain.linearRampToValueAtTime(0, t1);
    } else {
      g.gain.linearRampToValueAtTime(level, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t1);
    }
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t0);
    src.stop(t1 + 0.05);
    const item = { src, t0 };
    this.fx.push(item);
    src.onended = () => (this.fx = this.fx.filter((x) => x !== item));
  }

  /** Geplante Riser/Downlifter verwerfen (Übergang abgebrochen/neu geplant). */
  cancelFx() {
    for (const { src } of this.fx) {
      try {
        src.stop();
      } catch {
        /* schon beendet */
      }
    }
    this.fx = [];
  }

  get now() {
    return this.ctx.currentTime;
  }

  resume() {
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
  }

  /** 0 = nur A, 0.5 = beide voll, 1 = nur B. */
  setCrossfader(x) {
    this.crossfader = x;
    const t = this.now;
    this.decks[0].xfade.gain.setTargetAtTime(Math.min(1, 2 * (1 - x)), t, 0.005);
    this.decks[1].xfade.gain.setTargetAtTime(Math.min(1, 2 * x), t, 0.005);
  }

  /**
   * Ausgabegerät wählen (z. B. ein bestimmter Voicemeeter-Eingang oder das DJ-Interface).
   * '' = Windows-Standardgerät. Liefert false, wenn der Browser das nicht kann.
   */
  async setOutputDevice(id) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    await this.ctx.setSinkId(id || '');
    this.outputDevice = id || '';
    return true;
  }

  _applyHeadMix() {
    const t = this.now;
    // gleichmäßig überblenden (Cue links = laut, Master rechts = laut)
    this.headCue.gain.setTargetAtTime(Math.cos(this.headMix * Math.PI / 2), t, 0.01);
    this.headMaster.gain.setTargetAtTime(Math.sin(this.headMix * Math.PI / 2), t, 0.01);
    this.headVol.gain.setTargetAtTime(this.headVolume, t, 0.01);
  }

  setHeadMix(x) {
    this.headMix = Math.max(0, Math.min(1, x));
    this._applyHeadMix();
  }

  setHeadVolume(v) {
    this.headVolume = Math.max(0, Math.min(1.5, v));
    this._applyHeadMix();
  }

  /**
   * Wohin der Kopfhörer-Ausgang geht:
   *  'off'    – nirgends (PFL stumm)
   *  'device' – auf ein zweites Ausgabegerät (z. B. der Kopfhörer-Ausgang der Soundkarte)
   *  'multi'  – Kanäle 3/4 des gewählten Geräts (Controller mit 4-Kanal-Soundkarte, Master = 1/2)
   * Liefert true, wenn es geklappt hat.
   */
  async setCueOutput(mode, deviceId = '') {
    this._teardownCue();
    this.cueMode = 'off';
    if (mode === 'device') {
      const dest = this.ctx.createMediaStreamDestination();
      this.headVol.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      if (typeof el.setSinkId !== 'function') return false;
      try {
        await el.setSinkId(deviceId || '');
        await el.play();
      } catch {
        return false;
      }
      this._cueParts = { dest, el };
      this.cueMode = 'device';
      return true;
    }
    if (mode === 'multi') {
      const max = this.ctx.destination.maxChannelCount || 2;
      if (max < 4) return false;
      const ctx = this.ctx;
      ctx.destination.channelCount = 4;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(4);
      const msplit = ctx.createChannelSplitter(2);
      const hsplit = ctx.createChannelSplitter(2);
      this.analyser.disconnect();
      this.analyser.connect(msplit);
      this.headVol.connect(hsplit);
      msplit.connect(merger, 0, 0);
      msplit.connect(merger, 1, 1);
      hsplit.connect(merger, 0, 2);
      hsplit.connect(merger, 1, 3);
      merger.connect(ctx.destination);
      this._cueParts = { merger, msplit, hsplit };
      this.cueMode = 'multi';
      return true;
    }
    return true;
  }

  _teardownCue() {
    const c = this._cueParts;
    if (!c) return;
    try {
      if (c.dest) {
        this.headVol.disconnect(c.dest);
        c.el.pause();
        c.el.srcObject = null;
      }
      if (c.merger) {
        this.analyser.disconnect();
        this.headVol.disconnect(c.hsplit);
        c.merger.disconnect();
        this.ctx.destination.channelCount = 2;
        this.ctx.destination.channelCountMode = 'max';
        this.ctx.destination.channelInterpretation = 'speakers';
        this.analyser.connect(this.ctx.destination);
      }
    } catch {
      /* schon getrennt */
    }
    this._cueParts = null;
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    this.master.gain.setTargetAtTime(v, this.now, 0.01);
  }

  async decode(bytes) {
    const buf = await this.ctx.decodeAudioData(bytes);
    const L = new Float32Array(buf.length);
    buf.copyFromChannel(L, 0);
    let R = L;
    if (buf.numberOfChannels > 1) {
      R = new Float32Array(buf.length);
      buf.copyFromChannel(R, 1);
    } else {
      R = L.slice();
    }
    return { L, R, duration: buf.duration };
  }
}

let loadSeq = 0;

export class Deck {
  constructor(engine, index) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;
    this.index = index;
    this.track = null;
    this.keylock = true;
    this.status = { frame: 0, v: 0, real: 0, rate: 1, playing: false, loopLen: 0, loopStart: 0, time: 0 };
    this.pending = new Map();

    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    // Keylock standardmäßig aus: Tempo-Anpassungen klingen wie am Plattenspieler (minimal höher/
    // tiefer, aber natürlich). Mit Keylock arbeitet der Time-Stretch hörbar und Key-Sync verschiebt
    // Stimmen um Halbtöne – das klang bei manchen Songs zu tief.
    this.setKeylock(false);

    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 180;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 3200;

    // Vocal-Cut: Stimmen sitzen meist in der Stereo-Mitte -> Mitte im Stimmbereich absenken,
    // Seitensignal (breite Instrumente, Hall) bleibt unangetastet.
    const split = ctx.createChannelSplitter(2);
    const mid = ctx.createGain();
    const side = ctx.createGain();
    const g = (v) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const lm = g(0.5), rm = g(0.5), ls = g(0.5), rs = g(-0.5);
    split.connect(lm, 0);
    split.connect(rm, 1);
    split.connect(ls, 0);
    split.connect(rs, 1);
    lm.connect(mid);
    rm.connect(mid);
    ls.connect(side);
    rs.connect(side);
    this.vocalA = ctx.createBiquadFilter();
    this.vocalA.type = 'peaking';
    this.vocalA.frequency.value = 1300;
    this.vocalA.Q.value = 0.8;
    this.vocalB = ctx.createBiquadFilter();
    this.vocalB.type = 'peaking';
    this.vocalB.frequency.value = 3200;
    this.vocalB.Q.value = 1.1;
    mid.connect(this.vocalA).connect(this.vocalB);
    const outL = ctx.createGain();
    const outR = ctx.createGain();
    const sideNeg = g(-1);
    this.vocalB.connect(outL);
    side.connect(outL);
    this.vocalB.connect(outR);
    side.connect(sideNeg).connect(outR);
    const merge = ctx.createChannelMerger(2);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = HP_OPEN;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = LP_OPEN;
    this.lp.Q.value = 0.9;

    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;

    this.node.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(split);
    // Gate (rhythmisches Zerhacken, "Stutter") und Flanger (Jet-Sweep) zwischen Filter und Fader
    this.gate = ctx.createGain();
    merge.connect(this.hp).connect(this.lp).connect(this.gate).connect(this.fader).connect(this.xfade).connect(engine.bus);
    this.flDelay = ctx.createDelay(0.05);
    this.flDelay.delayTime.value = 0.004;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.22;
    const lfoDepth = g(0.0032);
    lfo.connect(lfoDepth).connect(this.flDelay.delayTime);
    lfo.start();
    const flFb = g(0.6);
    this.flWet = g(0);
    this.gate.connect(this.flDelay);
    this.flDelay.connect(flFb).connect(this.flDelay);
    this.flDelay.connect(this.flWet).connect(this.fader);
    this.fader.connect(this.meter);

    // Echo (pre-fader Send, damit es nach dem Ausblenden weiterklingt)
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.delay = ctx.createDelay(4);
    this.delay.delayTime.value = 0.35;
    const fb = g(0.35);
    const eHp = ctx.createBiquadFilter();
    eHp.type = 'highpass';
    eHp.frequency.value = 300;
    const eLp = ctx.createBiquadFilter();
    eLp.type = 'lowpass';
    eLp.frequency.value = 3500;
    this.lp.connect(this.echoSend).connect(this.delay).connect(eHp).connect(eLp);
    eLp.connect(fb).connect(this.delay);
    eLp.connect(g(0.5)).connect(engine.bus);

    // Hall (pre-fader Send wie das Echo: die Hallfahne klingt nach dem Ausblenden weiter)
    this.reverbSend = g(0);
    const conv = ctx.createConvolver();
    conv.buffer = engine.impulse;
    const rHp = ctx.createBiquadFilter();
    rHp.type = 'highpass';
    rHp.frequency.value = 220;
    this.lp.connect(this.reverbSend).connect(rHp).connect(conv).connect(g(0.8)).connect(engine.bus);

    // Kopfhörer-Cue: vor dem Fader abgreifen (man hört den Track auch bei geschlossenem Fader)
    this.cueSend = g(0);
    this.lp.connect(this.cueSend).connect(engine.cueBus);
    this.cueOn = false;
    this.trimOffsetDb = 0;
    this.bend = 0;

    this.params = {
      fader: [[this.fader.gain, (v) => v]],
      low: [[this.low.gain, (v) => v]],
      mid: [[this.mid.gain, (v) => v]],
      high: [[this.high.gain, (v) => v]],
      vocal: [[this.vocalA.gain, (v) => -20 * v], [this.vocalB.gain, (v) => -14 * v]],
      echo: [[this.echoSend.gain, (v) => v]],
      reverb: [[this.reverbSend.gain, (v) => v]],
      flanger: [[this.flWet.gain, (v) => 0.8 * v]],
      // Pegel-Ausgleich des DJs in dB (zusätzlich zur Lautheits-Anpassung des Tracks)
      trim: [[this.trim.gain, (v) => 10 ** (((this.track?.analysis?.loudness?.gainDb ?? 0) + this.trimOffsetDb + v) / 20)]],
    };
  }

  // ---------------------------------------------------------------- Worklet-Kommunikation

  onMessage(msg) {
    if (msg.type === 'status') {
      this.status = { ...msg, time: msg.frame / this.engine.sr };
    } else if (msg.type === 'loaded') {
      this.pending.get(msg.id)?.();
      this.pending.delete(msg.id);
    }
  }

  post(msg, transfer) {
    this.node.port.postMessage(msg, transfer || []);
  }

  frameAt(t) {
    return Math.round(t * this.engine.sr);
  }

  async load(track, audio) {
    const id = ++loadSeq;
    const length = audio.L.length; // vor dem Transfer merken (Buffer wird danach detached)
    const done = new Promise((res) => this.pending.set(id, res));
    this.post({ type: 'load', id, L: audio.L, R: audio.R }, [audio.L.buffer, audio.R.buffer]);
    await done;
    this.track = track;
    this.length = length;
    this.status = { ...this.status, v: 0, real: 0, playing: false, loopLen: 0, rate: 1 };
    this.resetParams();
    this.setKeyShift(0);
    this.applyTrim();
  }

  /** Lautheits-Angleichung des Tracks plus der Trim-Regler (Offset in dB, ±12). */
  applyTrim() {
    const gainDb = this.track?.analysis?.loudness?.gainDb ?? 0;
    this.trim.gain.setTargetAtTime(10 ** ((gainDb + this.trimOffsetDb) / 20), this.engine.now, 0.01);
  }

  setTrimOffset(db) {
    this.trimOffsetDb = Math.max(-18, Math.min(12, db));
    this.applyTrim();
  }

  setCue(on) {
    this.cueOn = !!on;
    this.cueSend.gain.setTargetAtTime(on ? 1 : 0, this.engine.now, 0.01);
  }

  // Jog-Wheel: Tempo-Nudge, Scratch (Hand auf dem Plattenteller) und Suchlauf
  setBend(x) {
    if (Math.abs(x - this.bend) < 1e-4) return;
    this.bend = x;
    this.post({ type: 'bend', value: x });
  }

  scratch(on) {
    this.post({ type: 'scratch', on: !!on });
  }

  /** Hand bewegt sich um `seconds` Musikzeit (negativ = rückwärts). */
  scratchBy(seconds) {
    this.post({ type: 'jog', frames: seconds * this.engine.sr });
  }

  searchBy(seconds) {
    this.post({ type: 'search', frames: seconds * this.engine.sr });
  }

  playAt(t, real = null) {
    this.post({ type: 'play', frame: this.frameAt(t), real });
  }

  stopAt(t) {
    this.post({ type: 'stop', frame: this.frameAt(t) });
  }

  rateAt(t, value, rampSec = 0) {
    this.post({ type: 'rate', frame: this.frameAt(t), value, ramp: Math.round(rampSec * this.engine.sr) });
  }

  segment(v, real, len = 0) {
    this.post({ type: 'segment', v, real, len });
  }

  /** Key-Sync: Tonhöhe in Halbtönen verschieben (Tempo bleibt). */
  setKeyShift(semis) {
    this.keyShift = semis;
    this.post({ type: 'pitch', value: 2 ** (semis / 12) });
  }

  seek(real) {
    this.post({ type: 'seek', real });
  }

  setKeylock(on) {
    this.keylock = on;
    this.post({ type: 'keylock', on });
  }

  cancel({ transport = false, ratesAfter, segmentsAfter } = {}) {
    this.post({
      type: 'cancel',
      transport,
      ratesAfter: ratesAfter === undefined ? undefined : this.frameAt(ratesAfter),
      segmentsAfter,
    });
  }

  setEchoTime(sec) {
    this.delay.delayTime.setValueAtTime(Math.min(3.9, sec), this.engine.now);
  }

  // ---------------------------------------------------------------- Position

  /** Aktuelle reale Position in Frames (extrapoliert seit letztem Status). */
  realAt(t = this.engine.now) {
    const s = this.status;
    if (!s.playing) return s.real;
    const adv = (t - s.time) * s.rate * this.engine.sr;
    if (s.loopLen > 0) {
      const off = s.real - s.loopStart + adv;
      return s.loopStart + (((off % s.loopLen) + s.loopLen) % s.loopLen);
    }
    return s.real + adv;
  }

  /** Virtuelle Position zum Zeitpunkt t (gilt, solange keine Tempo-Rampe läuft). */
  virtualAt(t) {
    const s = this.status;
    return s.v + (s.playing ? (t - s.time) * s.rate * this.engine.sr : 0);
  }

  get seconds() {
    return this.realAt() / this.engine.sr;
  }

  // ---------------------------------------------------------------- Parameter

  get(name) {
    if (name === 'filter') return filterValue(this.lp.frequency.value, this.hp.frequency.value);
    const [param] = this.params[name][0];
    return name === 'vocal' ? -param.value / 20 : name === 'flanger' ? param.value / 0.8 : param.value;
  }

  values() {
    const out = {};
    for (const p of PARAMS) out[p] = this.get(p);
    return out;
  }

  _audioParams(name) {
    return name === 'filter' ? [this.lp.frequency, this.hp.frequency] : this.params[name].map((x) => x[0]);
  }

  cancelFrom(name, t) {
    for (const p of this._audioParams(name)) {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else p.cancelScheduledValues(t);
    }
  }

  /** Sofort setzen (manuelle Bedienung) – bricht laufende Automation dieses Reglers ab. */
  setNow(name, value) {
    const t = this.engine.now;
    this.cancelFrom(name, t);
    if (name === 'filter') {
      const f = filterFreqs(value);
      this.lp.frequency.setTargetAtTime(f.lp, t, 0.01);
      this.hp.frequency.setTargetAtTime(f.hp, t, 0.01);
      return;
    }
    for (const [param, map] of this.params[name]) param.setTargetAtTime(map(value), t, 0.008);
  }

  /** Automation: von v0 (bei t0) nach v1 (bei t1); t1 <= t0 = Sprung. */
  ramp(name, t0, v0, t1, v1) {
    if (name === 'filter') return this._rampFilter(t0, v0, t1, v1);
    // Weiche S-Kurve (smoothstep) aus kurzen linearen Stücken: kein abruptes Anfahren/Abstoppen
    const n = Math.max(2, Math.min(16, Math.round((t1 - t0) / 0.06)));
    for (const [param, map] of this.params[name]) {
      if (t1 <= t0 + 1e-4) {
        param.setValueAtTime(map(v1), t0);
        continue;
      }
      param.setValueAtTime(map(v0), t0);
      for (let k = 1; k <= n; k++) {
        const x = k / n;
        const e = x * x * (3 - 2 * x);
        // Fader: in der Leistung (Quadrat) überblenden statt in der Amplitude – laufen zwei Tracks
        // gegenläufig, bleibt die Gesamtlautheit konstant (kein Loch in der Mitte, wie am DJ-Mixer)
        const v = name === 'fader' ? Math.sqrt(Math.max(0, v0 * v0 + (v1 * v1 - v0 * v0) * e)) : v0 + (v1 - v0) * e;
        param.linearRampToValueAtTime(map(v), t0 + (t1 - t0) * x);
      }
    }
  }

  _rampFilter(t0, v0, t1, v1) {
    const set = (t, v) => {
      const f = filterFreqs(v);
      this.lp.frequency.setValueAtTime(f.lp, t);
      this.hp.frequency.setValueAtTime(f.hp, t);
    };
    const to = (t, v) => {
      const f = filterFreqs(v);
      this.lp.frequency.exponentialRampToValueAtTime(f.lp, t);
      this.hp.frequency.exponentialRampToValueAtTime(f.hp, t);
    };
    if (t1 <= t0 + 1e-4) return set(t0, v1);
    set(t0, v0);
    if (v0 * v1 < 0) {
      // durch die Mitte: erst auf neutral, dann in die andere Richtung
      const tz = t0 + ((t1 - t0) * Math.abs(v0)) / (Math.abs(v0) + Math.abs(v1));
      to(tz, 0);
    }
    to(t1, v1);
  }

  /**
   * Stutter-Gate: von t0 bis t1 im Raster step (Sekunden) an/aus, depth = wie tief es zumacht
   * (1 = ganz still). duty = Anteil "an" je Schritt.
   */
  gateAt(t0, t1, step, { depth = 1, duty = 0.5 } = {}) {
    const g = this.gate.gain;
    const low = Math.max(0, 1 - depth);
    const edge = Math.min(0.004, step * 0.1);
    for (let t = t0; t < t1 - 1e-4; t += step) {
      g.setValueAtTime(1, t);
      g.setValueAtTime(1, t + step * duty);
      g.linearRampToValueAtTime(low, t + step * duty + edge);
      g.setValueAtTime(low, t + step - edge);
      g.linearRampToValueAtTime(1, t + step);
    }
    g.setValueAtTime(1, t1);
  }

  resetGate(t = this.engine.now) {
    const g = this.gate.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    g.setTargetAtTime(1, t, 0.005);
  }

  resetParams() {
    const t = this.engine.now;
    this.resetGate(t);
    for (const name of PARAMS) {
      this.cancelFrom(name, t);
      this.ramp(name, t, NEUTRAL[name], t, NEUTRAL[name]);
    }
  }

  level() {
    const buf = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return peak;
  }
}
