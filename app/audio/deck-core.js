// Deck-DSP ohne Web-Audio-Abhängigkeiten (läuft im AudioWorklet und in Node-Tests).
//
// Positionsmodell:
//  - "virtuelle" Position v wächst immer linear mit der Zeit (v += rate pro Output-Sample).
//  - Segmente bilden v auf die "reale" Position im Track-Buffer ab. Ein Segment ist entweder
//    linear (len = 0) oder ein Loop (len > 0). Loops, Loop-Rolls und Sprünge sind damit nur
//    neue Segmente ab einer virtuellen Position – der Conductor kann sie sample-genau im
//    Voraus planen, weil v(t) unabhängig von Loops linear bleibt.
//  - Keylock: Time-Stretch (Tempo ändern ohne Tonhöhe). Ohne Keylock: Vinyl-Modus.

const SEAM = 480; // Crossfade-Länge an Loop-/Sprungnähten (~10 ms, gegen Klicks)
const DECLICK = 256; // Ein-/Ausblendlänge bei Start/Stop

export class DeckCore {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.L = new Float32Array(0);
    this.R = new Float32Array(0);
    this.length = 0;

    this.segments = [{ v0: 0, v1: Infinity, real0: 0, len: 0 }];
    this.segIdx = 0;

    this.playing = false;
    this.gain = 0; // Declick-Hüllkurve 0..1
    this.pendingStart = null; // { frame, real }
    this.pendingStop = null; // { frame }
    this.stopRequested = false;

    this.rateFrom = 1;
    this.rateTo = 1;
    this.rateStart = 0;
    this.rateEnd = 0;
    this.rateEvents = [];

    this.keylock = true;
    this.vinylPos = 0;

    // Time-Stretch nach dem SoundTouch-Prinzip: lange Abschnitte (SEQ) werden 1:1 übernommen,
    // nur an den Nahtstellen wird kurz (OV) überblendet – an der Stelle mit der besten
    // Übereinstimmung (Suche ±SEEK). Klingt deutlich sauberer als dauerhaft überlappende Grains.
    this.N = Math.round(sampleRate * 0.06); // Sequenzlänge
    this.OV = Math.round(sampleRate * 0.01); // Überblendlänge
    this.S = Math.round(sampleRate * 0.012) & ~3; // Suchbereich ±
    const cap = this.N * 4;
    this.fifoL = new Float32Array(cap);
    this.fifoR = new Float32Array(cap);
    this.fifoV = new Float64Array(cap);
    this.fifoCap = cap;
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.nominal = 0;
    this.prevActual = null;
    this.tailL = new Float32Array(this.OV);
    this.tailR = new Float32Array(this.OV);
    this.tailM = new Float32Array(this.OV);
    const scratch = this.N + 2 * this.S + 8;
    this.tmpL = new Float32Array(scratch);
    this.tmpR = new Float32Array(scratch);
    this.tmpM = new Float32Array(scratch);
  }

  load(L, R) {
    this.L = L;
    this.R = R || L;
    this.length = L.length;
    this.playing = false;
    this.gain = 0;
    this.pendingStart = null;
    this.pendingStop = null;
    this.rateEvents = [];
    this.rateFrom = this.rateTo = 1;
    this.rateStart = this.rateEnd = 0;
    this._resetTo(0);
  }

  // ---------- Segmente ----------

  _resetTo(real) {
    this.segments = [{ v0: real, v1: Infinity, real0: real, len: 0 }];
    this.segIdx = 0;
    this._resetStretch(real);
  }

  _resetStretch(v) {
    this.nominal = v;
    this.vinylPos = v;
    this.prevActual = null;
    this.fifoHead = 0;
    this.fifoCount = 0;
  }

  /** Ab virtueller Position v gilt: real = real0 (+ Fortschritt, bei len > 0 geloopt). */
  addSegment(v, real0, len) {
    v = Math.round(v);
    const segs = this.segments;
    while (segs.length > 1 && segs[segs.length - 1].v0 >= v) segs.pop();
    if (segs.length === 1 && segs[0].v0 >= v) {
      segs[0] = { v0: v, v1: Infinity, real0: Math.round(real0), len: Math.max(0, Math.round(len)) };
      this.segIdx = 0;
      return;
    }
    segs[segs.length - 1].v1 = v;
    segs.push({ v0: v, v1: Infinity, real0: Math.round(real0), len: Math.max(0, Math.round(len)) });
    this.segIdx = Math.min(this.segIdx, segs.length - 1);
  }

  /** Entfernt alle geplanten Segmente, die nach virtueller Position v beginnen. */
  cancelSegmentsAfter(v) {
    const segs = this.segments;
    while (segs.length > 1 && segs[segs.length - 1].v0 > v) segs.pop();
    segs[segs.length - 1].v1 = Infinity;
    this.segIdx = Math.min(this.segIdx, segs.length - 1);
  }

  _findSeg(v) {
    const segs = this.segments;
    let i = this.segIdx;
    if (i >= segs.length) i = segs.length - 1;
    while (i > 0 && v < segs[i].v0) i--;
    while (i < segs.length - 1 && v >= segs[i].v1) i++;
    this.segIdx = i;
    return i;
  }

  realAt(v) {
    const seg = this.segments[this._findSeg(v)];
    if (seg.len === 0 || v < seg.v0) return seg.real0 + (v - seg.v0);
    return seg.real0 + ((v - seg.v0) % seg.len);
  }

  _raw(buf, i) {
    return i >= 0 && i < this.length ? buf[i] : 0;
  }

  /** Liest n Samples ab virtueller Ganzzahl-Position v0 (inkl. Naht-Crossfades). */
  readBlock(v0, n, outL, outR) {
    const segs = this.segments;
    for (let k = 0; k < n; k++) {
      const v = v0 + k;
      const si = this._findSeg(v);
      const seg = segs[si];
      let real;
      let ph = 0;
      if (seg.len === 0 || v < seg.v0) {
        real = seg.real0 + (v - seg.v0);
      } else {
        ph = (v - seg.v0) % seg.len;
        real = seg.real0 + ph;
      }
      let l = this._raw(this.L, real);
      let r = this._raw(this.R, real);

      const dEnd = seg.v1 - v;
      if (dEnd <= SEAM && si < segs.length - 1) {
        const alt = segs[si + 1].real0 - dEnd;
        const w = 1 - dEnd / SEAM;
        l = l * (1 - w) + this._raw(this.L, alt) * w;
        r = r * (1 - w) + this._raw(this.R, alt) * w;
      } else if (seg.len > 0 && v >= seg.v0) {
        const dWrap = seg.len - ph;
        if (dWrap <= SEAM) {
          const alt = seg.real0 - dWrap;
          const w = 1 - dWrap / SEAM;
          l = l * (1 - w) + this._raw(this.L, alt) * w;
          r = r * (1 - w) + this._raw(this.R, alt) * w;
        }
      }
      outL[k] = l;
      outR[k] = r;
    }
  }

  _gc() {
    const keep = this.currentVirtual() - this.N * 4;
    while (this.segments.length > 1 && this.segments[0].v1 < keep) {
      this.segments.shift();
      this.segIdx = Math.max(0, this.segIdx - 1);
    }
  }

  // ---------- Tempo ----------

  scheduleRate(frame, value, rampFrames = 0) {
    this.rateEvents.push({ frame, value, ramp: Math.max(0, rampFrames) });
    this.rateEvents.sort((a, b) => a.frame - b.frame);
  }

  cancelRatesAfter(frame) {
    this.rateEvents = this.rateEvents.filter((e) => e.frame <= frame);
  }

  rateAt(frame) {
    while (this.rateEvents.length && this.rateEvents[0].frame <= frame) {
      const ev = this.rateEvents.shift();
      const cur = this._rateValue(ev.frame);
      this.rateFrom = cur;
      this.rateTo = ev.value;
      this.rateStart = ev.frame;
      this.rateEnd = ev.frame + ev.ramp;
    }
    return this._rateValue(frame);
  }

  _rateValue(frame) {
    if (frame >= this.rateEnd) return this.rateTo;
    if (frame <= this.rateStart) return this.rateFrom;
    return this.rateFrom + ((this.rateTo - this.rateFrom) * (frame - this.rateStart)) / (this.rateEnd - this.rateStart);
  }

  // ---------- Transport ----------

  /** Startet an Frame `frame`. real = Startposition (null = an aktueller Position weiter). */
  schedulePlay(frame, real = null) {
    if (real !== null && !this.playing) {
      // Segmente sofort setzen, damit danach geplante Loops (addSegment) erhalten bleiben
      this._resetTo(Math.round(real));
      this.pendingStart = { frame, real: null };
    } else {
      this.pendingStart = { frame, real };
    }
  }

  scheduleStop(frame) {
    this.pendingStop = { frame };
  }

  cancelTransport() {
    this.pendingStart = null;
    this.pendingStop = null;
  }

  /** Position ändern: gestoppt sofort, laufend als Sprung knapp hinter dem Lesekopf. */
  seek(real) {
    if (!this.playing) {
      this._resetTo(Math.round(real));
      return;
    }
    const v = Math.ceil(this.currentVirtual()) + this.N + this.S + 64;
    this.cancelSegmentsAfter(v - 1);
    this.addSegment(v, real, 0);
  }

  setKeylock(on) {
    if (on === this.keylock) return;
    const v = this.currentVirtual();
    this.keylock = on;
    this._resetStretch(Math.round(v));
  }

  currentVirtual() {
    if (this.keylock && this.fifoCount > 0) return this.fifoV[this.fifoHead];
    return this.keylock ? this.nominal : this.vinylPos;
  }

  // ---------- Time-Stretch ----------

  _generateGrain(emitFrame) {
    const { N, OV } = this;
    const rate = this.rateAt(emitFrame);
    const nom = Math.round(this.nominal);
    let actual = nom;
    const hasPrev = this.prevActual !== null;
    // natürliche Fortsetzung = kein Suchen nötig (Tempo 1, kein Versatz) -> bitgenau transparent
    if (hasPrev && this.prevActual + N - OV !== nom) actual = this._search(nom);

    this.readBlock(actual, N, this.tmpL, this.tmpR);
    const L = this.tmpL;
    const R = this.tmpR;
    const out = N - OV;
    const cap = this.fifoCap;
    let w = (this.fifoHead + this.fifoCount) % cap;
    for (let j = 0; j < out; j++) {
      let l = L[j];
      let r = R[j];
      if (j < OV && hasPrev) {
        const g = j / OV;
        l = this.tailL[j] * (1 - g) + l * g;
        r = this.tailR[j] * (1 - g) + r * g;
      }
      this.fifoL[w] = l;
      this.fifoR[w] = r;
      this.fifoV[w] = this.nominal + j * rate;
      w = w + 1 === cap ? 0 : w + 1;
    }
    this.fifoCount += out;
    // Ende der Sequenz = Überblend-Material für die nächste Naht
    for (let j = 0; j < OV; j++) {
      this.tailL[j] = L[out + j];
      this.tailR[j] = R[out + j];
      this.tailM[j] = L[out + j] + R[out + j];
    }
    this.prevActual = actual;
    this.nominal += out * rate;
  }

  /** Beste Anschlussstelle um `nom`: maximale normierte Korrelation mit dem Überblend-Material. */
  _search(nom) {
    const { OV, S } = this;
    const T = this.tailM;
    const span = OV + 2 * S;
    this.readBlock(nom - S, span, this.tmpL, this.tmpR);
    const M = this.tmpM;
    for (let i = 0; i < span; i++) M[i] = this.tmpL[i] + this.tmpR[i];

    const score = (off, step) => {
      let c = 0;
      let e = 1e-9;
      for (let i = 0; i < OV; i += step) {
        const x = M[off + i];
        c += T[i] * x;
        e += x * x;
      }
      const d = (off - S) / S;
      return (c / Math.sqrt(e)) * (1 - 0.2 * d * d); // leichte Bevorzugung der Mitte
    };

    let best = S;
    let bestScore = -Infinity;
    for (let off = 0; off <= 2 * S; off += 4) {
      const s = score(off, 2);
      if (s > bestScore) {
        bestScore = s;
        best = off;
      }
    }
    let fine = best;
    bestScore = -Infinity;
    for (let off = Math.max(0, best - 3); off <= Math.min(2 * S, best + 3); off++) {
      const s = score(off, 1);
      if (s > bestScore) {
        bestScore = s;
        fine = off;
      }
    }
    return nom - S + fine;
  }

  // ---------- Render ----------

  /** Rendert n Samples beginnend bei globalem Frame `frame0`. */
  process(outL, outR, frame0, n) {
    for (let i = 0; i < n; i++) {
      const f = frame0 + i;

      if (this.pendingStart && f >= this.pendingStart.frame) {
        const { real } = this.pendingStart;
        this.pendingStart = null;
        if (real !== null && real !== undefined) this._resetTo(Math.round(real));
        else this._resetStretch(Math.round(this.currentVirtual()));
        this.playing = true;
        this.stopRequested = false;
      }
      if (this.pendingStop && f >= this.pendingStop.frame) {
        this.pendingStop = null;
        this.stopRequested = true;
      }

      if (!this.playing) {
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      let l;
      let r;
      if (this.keylock) {
        if (this.fifoCount === 0) this._generateGrain(f);
        const h = this.fifoHead;
        l = this.fifoL[h];
        r = this.fifoR[h];
        this.fifoHead = h + 1 === this.fifoCap ? 0 : h + 1;
        this.fifoCount--;
      } else {
        const v = this.vinylPos;
        const vi = Math.floor(v);
        const fr = v - vi;
        this.readBlock(vi, 2, this.tmpL, this.tmpR);
        l = this.tmpL[0] + (this.tmpL[1] - this.tmpL[0]) * fr;
        r = this.tmpR[0] + (this.tmpR[1] - this.tmpR[0]) * fr;
        this.vinylPos = v + this.rateAt(f);
      }

      const target = this.stopRequested ? 0 : 1;
      if (this.gain !== target) {
        this.gain += target > this.gain ? 1 / DECLICK : -1 / DECLICK;
        if (this.gain < 0) this.gain = 0;
        if (this.gain > 1) this.gain = 1;
      }
      outL[i] = l * this.gain;
      outR[i] = r * this.gain;

      if (this.stopRequested && this.gain === 0) {
        const v = Math.round(this.currentVirtual());
        this.playing = false;
        this.stopRequested = false;
        this._resetStretch(v);
      }
    }
    if (this.playing) this._gc();
  }

  status(frame) {
    const v = this.currentVirtual();
    const seg = this.segments[this._findSeg(Math.floor(v))];
    return {
      frame,
      v,
      real: this.realAt(Math.floor(v)) + (v - Math.floor(v)),
      rate: this._rateValue(frame),
      playing: this.playing,
      loopLen: seg.len,
      loopStart: seg.len ? seg.real0 : 0,
    };
  }
}
