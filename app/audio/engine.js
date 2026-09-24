// Web-Audio-Graph: zwei Decks (Worklet) -> DJ-Kanalzug -> Master mit Limiter.
//
// Kanalzug pro Deck:
//   Deck -> Trim -> EQ Low/Mid/High -> Vocal-Cut (Mitte/Seite) -> HP/LP-Filter -> Fader -> Crossfader -> Bus
//                                                                         \-> Echo-Send (pre-fader) -> Delay-Schleife -> Bus
//
// Alle Regler sind "logische" Parameter (EQ in dB, Filter -1..1, Vocal 0..1, ...), die auf
// AudioParams abgebildet und sample-genau automatisiert werden können.

export const PARAMS = ['fader', 'low', 'mid', 'high', 'filter', 'vocal', 'echo'];
export const NEUTRAL = { fader: 1, low: 0, mid: 0, high: 0, filter: 0, vocal: 0, echo: 0 };

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
    this.bus.connect(this.limiter).connect(this.master).connect(this.analyser).connect(ctx.destination);

    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.setCrossfader(0.5);
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

  setMasterVolume(v) {
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
    merge.connect(this.hp).connect(this.lp).connect(this.fader).connect(this.xfade).connect(engine.bus);
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

    this.params = {
      fader: [[this.fader.gain, (v) => v]],
      low: [[this.low.gain, (v) => v]],
      mid: [[this.mid.gain, (v) => v]],
      high: [[this.high.gain, (v) => v]],
      vocal: [[this.vocalA.gain, (v) => -20 * v], [this.vocalB.gain, (v) => -14 * v]],
      echo: [[this.echoSend.gain, (v) => v]],
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
    const gainDb = track.analysis?.loudness?.gainDb ?? 0;
    this.trim.gain.setValueAtTime(10 ** (gainDb / 20), this.engine.now);
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
    return name === 'vocal' ? -param.value / 20 : param.value;
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

  resetParams() {
    const t = this.engine.now;
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
