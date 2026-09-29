// Beobachtet, wie du von Hand mixt, und macht daraus Lernmaterial für den Automix.
//
// Ein Übergang beginnt, wenn ein Deck hörbar wird, während das andere schon eine Weile läuft, und
// endet, wenn das alte Deck verschwunden ist. Aus dem Verlauf (Pegel, Bass-EQ, Filter, Echo, Loop,
// Position in beiden Songs) wird eine Zusammenfassung gebildet: Technik, Länge, Ausstiegs-Stelle,
// Bass-Tausch auf dem Takt, Tempo-Angleichung. Der Planer liest sie über feedback.js (kind: 'manual')
// und bevorzugt künftig, was du selbst gern machst.
import { secondsToBar } from '../mix/planner.js';
import { camelotDistance } from '../mix/order.js';

const AUDIBLE = 0.02; // Spitzenpegel hinter dem Fader, ab dem ein Deck als hörbar gilt
const RUNNING_MIN = 12; // s: so lange muss ein Deck schon gelaufen sein, damit es "der laufende Track" ist
const GONE_AFTER = 1.2; // s Stille, bis das alte Deck als weg gilt
const MAX_SEC = 300;

export class ManualObserver extends EventTarget {
  /**
   * @param decks   die beiden Decks der Engine
   * @param active  () => boolean – nur beobachten, solange du mixt (Automix aus)
   * @param clock   () => Sekunden (für Tests austauschbar)
   */
  constructor({ decks, active = () => true, clock = () => performance.now() / 1000, intervalMs = 200 }) {
    super();
    this.decks = decks;
    this.active = active;
    this.clock = clock;
    this.onSince = [null, null];
    this.lastAudible = [-Infinity, -Infinity];
    this.cand = null;
    this.timer = intervalMs > 0 ? setInterval(() => this.tick(), intervalMs) : null;
    this.timer?.unref?.();
  }

  destroy() {
    clearInterval(this.timer);
  }

  audible(d) {
    return !!d.track && !!d.status.playing && d.level() > AUDIBLE;
  }

  tick() {
    const now = this.clock();
    if (!this.active()) {
      this.cand = null;
      this.onSince = [null, null];
      return;
    }
    const aud = this.decks.map((d) => this.audible(d));
    for (const i of [0, 1]) {
      if (aud[i]) {
        if (this.onSince[i] === null) this.onSince[i] = now;
        this.lastAudible[i] = now;
      } else if (now - this.lastAudible[i] > GONE_AFTER) {
        this.onSince[i] = null;
      }
    }

    if (!this.cand) {
      for (const inn of [0, 1]) {
        const out = 1 - inn;
        // neu hörbar geworden, während der andere (schon länger laufende) noch da ist oder gerade erst ging
        const fresh = aud[inn] && this.onSince[inn] !== null && now - this.onSince[inn] < 0.5;
        const runningLong = this.onSince[out] !== null && now - this.onSince[out] >= RUNNING_MIN;
        const outRecent = now - this.lastAudible[out] < 2;
        if (fresh && runningLong && outRecent && this.decks[inn].track && this.decks[out].track) {
          this.begin(out, inn, now);
          break;
        }
      }
    }
    if (this.cand) this.sample(aud, now);
  }

  begin(out, inn, now) {
    const dOut = this.decks[out];
    const dIn = this.decks[inn];
    const sr = dOut.engine.sr;
    this.cand = {
      out,
      inn,
      t0: now,
      outPos0: dOut.realAt() / sr,
      inPos0: dIn.realAt() / sr,
      outTrack: dOut.track,
      inTrack: dIn.track,
      outRate0: dOut.status.rate || 1,
      inRate0: dIn.status.rate || 1,
      samples: [],
      outGoneAt: null,
      quietSince: null,
    };
  }

  sample(aud, now) {
    const c = this.cand;
    const dOut = this.decks[c.out];
    const dIn = this.decks[c.inn];
    // Track gewechselt (neu geladen) oder Ausgangsdeck geladen → verwerfen
    if (dOut.track !== c.outTrack || dIn.track !== c.inTrack) {
      this.cand = null;
      return;
    }
    const sr = dOut.engine.sr;
    const outA = aud[c.out];
    const inA = aud[c.inn];
    c.samples.push({
      t: now - c.t0,
      outAud: outA,
      inAud: inA,
      outLevel: dOut.level(),
      inLevel: dIn.level(),
      outLow: dOut.get('low'),
      inLow: dIn.get('low'),
      outFilter: dOut.get('filter'),
      inFilter: dIn.get('filter'),
      outEcho: Math.max(dOut.get('echo'), dOut.get('reverb')),
      outLoop: dOut.status.loopLen > 0,
      outSec: dOut.realAt() / sr,
      inSec: dIn.realAt() / sr,
    });
    if (!outA) {
      c.quietSince ??= now;
      c.outGoneAt ??= now - c.t0;
    } else {
      c.quietSince = null;
      c.outGoneAt = null;
    }
    if (!dOut.status.playing && c.outGoneAt === null) c.outGoneAt = now - c.t0;

    const dur = now - c.t0;
    if (c.quietSince !== null && (now - c.quietSince >= GONE_AFTER || !dOut.status.playing)) {
      if (inA) this.finish(c);
      this.cand = null;
    } else if (!inA && now - this.lastAudible[c.inn] > 3) {
      this.cand = null; // der neue Track ist wieder verstummt – kein Übergang
    } else if (dur > MAX_SEC) {
      this.cand = null;
    }
  }

  finish(c) {
    const a = c.outTrack.analysis;
    const b = c.inTrack.analysis;
    if (!a || !b) return;
    const S = c.samples;
    const overlapSec = Math.max(0, (c.outGoneAt ?? S[S.length - 1].t) - 0);
    const barSec = 240 / (a.bpm * c.outRate0);
    const overlapBars = overlapSec / barSec;
    const max = (f) => Math.max(0, ...S.map(f));
    const filterUsed = max((s) => Math.max(Math.abs(s.outFilter), Math.abs(s.inFilter))) > 0.35;
    const echoUsed = max((s) => s.outEcho) > 0.25;
    const loopUsed = S.some((s) => s.outLoop);
    // Bass-Tausch: der alte Bass wird weggedreht, während der neue schon da ist
    const swapAt = S.find((s) => s.outLow < -12 && s.inLow > -6);
    const bassSwap = !!swapAt;
    let swapAligned = null;
    if (swapAt) {
      const bar = secondsToBar(a, swapAt.outSec);
      const frac = bar - Math.floor(bar);
      swapAligned = Math.min(frac, 1 - frac) < 0.2;
    }
    let type;
    if (overlapBars < 1.5) type = echoUsed ? 'echo' : 'cut';
    else if (loopUsed) type = 'loop';
    else if (filterUsed) type = 'filter';
    else if (echoUsed && overlapBars < 4) type = 'echo';
    else type = 'blend';

    const outBar0 = secondsToBar(a, c.outPos0);
    const inBar0 = secondsToBar(b, c.inPos0);
    const lastBar = a.points?.lastBar ?? secondsToBar(a, a.duration);
    const inKind = Math.abs(inBar0 - (b.points?.startBar ?? 0)) < 1.5 ? 'start' : Math.abs(inBar0 - (b.points?.dropBar ?? -99)) < 2 ? 'drop' : 'mid';
    const bpmA = a.bpm * c.outRate0;
    const bpmB = b.bpm * c.inRate0;
    const ratio = bpmA / bpmB;
    const beatmatched = [1, 2, 0.5].some((m) => Math.abs(ratio * m - 1) < 0.02);
    let keyDist = null;
    try {
      keyDist = camelotDistance(a.key.camelot, b.key.camelot);
    } catch {
      /* ohne Tonart */
    }
    const entry = {
      kind: 'manual',
      type,
      genres: [c.outTrack.genre, c.inTrack.genre],
      outId: c.outTrack.id,
      inId: c.inTrack.id,
      out: `${c.outTrack.artist || ''} – ${c.outTrack.title || ''}`,
      in: `${c.inTrack.artist || ''} – ${c.inTrack.title || ''}`,
      overlapSec: Math.round(overlapSec * 10) / 10,
      overlapBars: Math.round(overlapBars * 10) / 10,
      exitFrac: Math.round((outBar0 / Math.max(1, lastBar)) * 100) / 100,
      bassSwap,
      swapAligned,
      filter: filterUsed,
      echo: echoUsed,
      loop: loopUsed,
      beatmatched,
      keyDist,
      inKind,
      barSec: Math.round(barSec * 100) / 100,
    };
    this.dispatchEvent(new CustomEvent('transition', { detail: entry }));
  }
}
