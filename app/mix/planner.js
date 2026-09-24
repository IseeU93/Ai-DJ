// Übergangs-Composer: baut für jedes Track-Paar einen eigenen Übergang aus der Struktur beider
// Songs (Phrasen, Drums, Bass, Gesang, Wiederholungen, Energie) – wie ein DJ, der die Tracks kennt.
// Ergebnis ist eine deklarative Schrittliste (Takte relativ zu T0), die der Conductor sample-genau
// ausführt, plus Notizen, warum der Übergang so gebaut wurde.
import { BEATMATCH_LIMIT, camelotDistance, keySync, shiftCamelot, tempoRelation } from './order.js';
import { GENRES, combineProfiles, detectGenre } from './genre.js';

export const TRANSITIONS = {
  blend: 'Blend',
  wordplay: 'Wortspiel',
  handoff: 'Vocal-Übergabe',
  loop: 'Loop-Mix',
  vocal: 'Lyrics-Wechsel',
  filter: 'Filter-Blend',
  cut: 'Drop-Cut',
  echo: 'Echo-Out',
};

export const KILL = -26; // dB, EQ-"Kill"
const VOCAL_ON = 0.5;
const FORCED_LIMIT = 0.16; // max. Tempoangleichung, wenn der Nutzer eine Technik erzwingt

// ------------------------------------------------------------------ Takt-Umrechnung

export function barToSeconds(a, bar) {
  return a.firstBeat + (a.downbeat + 4 * bar) * a.beatInterval;
}

export function secondsToBar(a, t) {
  return ((t - a.firstBeat) / a.beatInterval - a.downbeat) / 4;
}

// ------------------------------------------------------------------ Track-Ansicht

/** Lesehilfen auf die Analyse eines Tracks (pro Takt). */
class TrackView {
  constructor(a) {
    this.a = a;
    this.end = a.points.lastBar + 1;
    // Ausklingen (Fade-out) am Ende ist kein nutzbares Material: Übergänge enden davor
    if (a.barEnergy) {
      let e = this.end;
      while (e > (a.barCount || this.end) * 0.6 && a.barEnergy[e - 1] < -9) e--;
      if (e < this.end) {
        this.fadeFrom = e;
        this.end = e;
      }
    }
  }

  _at(arr, bar, def) {
    const v = arr?.[Math.floor(bar)];
    return v === undefined ? def : v;
  }

  vocal(bar) { return this._at(this.a.vocals, bar, 0); }
  drums(bar) { return this._at(this.a.barDrums, bar, 0.5); }
  bass(bar) { return this._at(this.a.barBass, bar, -6); }
  energy(bar) { return this._at(this.a.barEnergy, bar, -6); }
  repeat(bar) { return this._at(this.a.barRepeat, bar, 0.5); }

  mean(fn, b0, b1) {
    let s = 0;
    let n = 0;
    for (let b = Math.max(0, Math.floor(b0)); b < Math.min(this.end, Math.ceil(b1)); b++) {
      s += fn.call(this, b);
      n++;
    }
    return n ? s / n : 0;
  }

  /** Auf das Phrasenraster (Vielfache von `step` ab phraseOffset) runden. */
  grid(bar, step = 4, dir = 'ceil') {
    const o = this.a.phraseOffset || 0;
    const f = dir === 'ceil' ? Math.ceil : dir === 'floor' ? Math.floor : Math.round;
    return f((bar - o) / step - 1e-9 * (dir === 'ceil' ? 1 : 0)) * step + o;
  }

  isPhraseStart(bar) {
    return (((bar - (this.a.phraseOffset || 0)) % 8) + 8) % 8 === 0;
  }

  /** Gesang geglättet über Nachbartakte (einzelne Takte schwanken, Gesangsteile nicht). */
  vocalSmooth(bar) {
    return (this.vocal(bar - 1) + 2 * this.vocal(bar) + this.vocal(bar + 1)) / 4;
  }

  /** Zusammenhängende Gesangsabschnitte [{from, to}] mit mind. `min` Takten. */
  vocalRuns(min = 8) {
    const runs = [];
    let start = null;
    let gap = 0;
    for (let b = 0; b <= this.end; b++) {
      const on = b < this.end && this.vocalSmooth(b) >= 0.35;
      if (on) {
        if (start === null) start = b;
        gap = 0;
      } else if (start !== null && b < this.end && gap === 0) {
        gap = 1; // ein schwächerer Takt unterbricht keine Gesangspassage
      } else if (start !== null) {
        const to = b - gap;
        if (to - start >= min) runs.push({ from: start, to });
        start = null;
        gap = 0;
      }
    }
    return runs;
  }

  /** Sektions-Label (intro/main/break/build/outro) des Takts. */
  label(bar) {
    let lab = this.a.phrases[0]?.label || 'main';
    for (const ph of this.a.phrases) {
      if (ph.bar > bar) break;
      lab = ph.label;
    }
    return bar >= this.end ? 'end' : lab;
  }

  /** Erster Takt im Bereich, ab dem der Bass voll da ist (oder null). */
  bassEntry(b0, b1) {
    for (let b = Math.max(0, b0); b < Math.min(this.end, b1); b++) if (this.bass(b) > -7) return b;
    return null;
  }
}

/**
 * Beste Loop-Stelle im Bereich [from, to): viele Drums, kein Gesang, wiederholendes Muster,
 * möglichst auf einem Phrasenanfang. Liefert { bar, len, score } oder null.
 */
function bestLoop(v, from, to, len) {
  const step = len >= 4 ? 4 : len;
  let best = null;
  for (let bar = v.grid(from, step); bar + len <= to; bar += step) {
    const score =
      v.mean(v.drums, bar, bar + len) -
      2 * v.mean(v.vocal, bar, bar + len) +
      0.8 * v.mean(v.repeat, bar, bar + len) +
      (v.isPhraseStart(bar) ? 0.25 : 0) +
      (v.mean(v.bass, bar, bar + len) > -8 ? 0.15 : 0) +
      0.1 * (bar / v.end);
    if (!best || score > best.score) best = { bar, len, score };
  }
  return best;
}

/**
 * Klingt ein Loop an dieser Stelle natürlich? Drums, kein Gesang, starke Wiederholung und
 * gleichmäßige Lautstärke (sonst springt es bei jedem Durchlauf laut/leise).
 * `joinBar`: Takt, an dem der Loop einsetzt – dort muss die Lautstärke zum Loop-Anfang passen.
 */
function loopable(v, loop, joinBar = null) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = loop.bar; b < loop.bar + loop.len; b++) {
    lo = Math.min(lo, v.energy(b));
    hi = Math.max(hi, v.energy(b));
  }
  const steady = hi - lo <= 2.5 && lo > -8;
  const joins = joinBar === null || Math.abs(v.energy(joinBar) - v.energy(loop.bar)) <= 2.5;
  return steady && joins
    && v.mean(v.repeat, loop.bar, loop.bar + loop.len) >= 0.6
    && v.mean(v.drums, loop.bar, loop.bar + loop.len) >= 0.4
    && v.mean(v.vocal, loop.bar, loop.bar + loop.len) < 0.3;
}

// ------------------------------------------------------------------ Schritt-Helfer

const p = (at, deck, param, to, dur = 0) => ({ at, deck, param, to, dur });
const act = (at, deck, action, extra = {}) => ({ at, deck, action, ...extra });
const r4 = (x) => Math.max(4, Math.round(x / 4) * 4);

/** Takt im alten Track, der zum Übergangs-Takt t gehört (berücksichtigt einen Loop). */
function outBarAt(ctx, t) {
  const L = ctx.loopExt;
  const bar = ctx.outBar + t;
  if (!L) return bar;
  const loopStart = L.bar;
  if (bar < loopStart + L.len) return bar;
  return loopStart + ((bar - loopStart) % L.len);
}

/**
 * Verhindert, dass zwei Stimmen gleichzeitig laufen: vor dem Bass-Swap wird der Gesang des
 * neuen Tracks abgesenkt, danach der des alten.
 */
function vocalGuard(ctx, steps, L, sw) {
  const { va, vb, m } = ctx;
  let lastBefore = -1;
  let clashAfter = false;
  for (let t = 0; t < L; t++) {
    const ov = va.vocalSmooth(outBarAt(ctx, t));
    let iv = 0;
    for (let k = 0; k < Math.max(1, m); k++) iv = Math.max(iv, vb.vocalSmooth(ctx.inBar + t * m + k));
    if (ov >= 0.45 && iv >= 0.45) {
      if (t < sw) lastBefore = t;
      else clashAfter = true;
    }
  }
  // Der alte Track darf seine Zeilen zu Ende singen – abgesenkt wird immer der neue.
  let last = lastBefore;
  if (clashAfter) {
    for (let t = L - 1; t >= 0; t--) {
      const ov = va.vocalSmooth(outBarAt(ctx, t));
      let iv = 0;
      for (let k = 0; k < Math.max(1, m); k++) iv = Math.max(iv, vb.vocalSmooth(ctx.inBar + t * m + k));
      if (ov >= 0.45 && iv >= 0.45) {
        last = Math.max(last, t);
        break;
      }
    }
  }
  if (last >= 0) {
    const until = Math.min(L, last + 1);
    steps.push(p(0, 'in', 'vocal', 1), p(until, 'in', 'vocal', 0, 0.5));
    ctx.notes.push(`Stimme des neuen Tracks bis Takt ${until} zurückgenommen – der alte singt seine Zeile zu Ende`);
  }
}

/** Ausstiegs-Takt: Übergangsende = Trackende, sonst frühester erlaubter Takt ("Jetzt mixen"). */
function exitBar(ctx, L) {
  const { va } = ctx;
  if (ctx.earliestBar !== null) {
    const bar = va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
    // läuft gerade ein voller Drop: bis zu seinem Ende warten statt mitten hineinzuschneiden
    const after = afterFullEnergy(va, bar);
    if (after !== bar) ctx.notes.push(`wartet bis Takt ${after}: der alte Track ist gerade voll im Drop`);
    return after;
  }
  const outro = ctx.a.points.outroBar;
  let bar = va.grid(va.end - L, 4, 'floor');
  // lieber zum Outro-Beginn raus, wenn das Outro lang genug ist
  if (outro !== null && outro !== undefined && outro < bar && outro + L <= va.end && bar - outro <= 8) bar = outro;
  // Nicht mitten in den Gesang des alten Tracks reinmixen: erst danach einsteigen und das
  // (kurze) Outro notfalls per Loop verlängern – so macht es ein DJ.
  const vocalEnd = ctx.a.points.vocalLast;
  if (vocalEnd !== null && vocalEnd !== undefined && vocalEnd >= bar) {
    const clean = va.grid(vocalEnd + 1, 4);
    if (clean <= va.end - 4) bar = clean;
  }
  return Math.max(0, bar);
}

/** Verlängert den alten Track per Loop, wenn er vor dem Übergangsende aufhören würde. */
function extendWithLoop(ctx, steps, L) {
  const { va, outBar } = ctx;
  const avail = va.end - outBar;
  if (avail >= L) return L;
  const lo = Math.max(outBar, va.end - 16);
  const loop = bestLoop(va, lo, va.end, avail >= 12 ? 8 : 4);
  // nur loopen, wenn sich die Stelle wirklich wiederholt und gleich laut bleibt
  if (!loop || !loopable(va, loop, loop.bar + loop.len - 1)) {
    ctx.notes.push('altes Outro zu kurz – Übergang verkürzt');
    return Math.max(2, Math.floor(avail / 2) * 2);
  }
  ctx.loopExt = loop;
  steps.push(act(loop.bar - outBar, 'out', 'loop', { bars: loop.len, anchor: loop.bar - outBar }));
  ctx.notes.push(`Loop über ${loop.len} Takte (ab Takt ${loop.bar - outBar}) verlängert das Ende des alten Tracks`);
  return L;
}

/** Läuft im Bereich [b0, b1) ein voller Hauptteil (Drop mit Drums und Energie)? */
function fullEnergyInside(v, b0, b1) {
  for (let b = Math.max(0, b0); b < b1; b++) {
    if (v.label(b) === 'main' && v.drums(b) >= 0.55 && v.energy(b) > -4) return true;
  }
  return false;
}

/** Erster Takt ab `bar` (auf dem 4er-Raster), an dem kein voller Drop mehr läuft. */
function afterFullEnergy(v, bar) {
  let b = bar;
  while (b < v.end - 2 && fullEnergyInside(v, b, b + 1)) b++;
  return b === bar ? bar : v.grid(b, 4);
}

// ------------------------------------------------------------------ Mix-Punkt-Suche

/**
 * Sucht die musikalisch beste Stelle für den Übergang – nicht stur am Ende:
 * alle Phrasengrenzen im alten Track × alle "Ankünfte" (Drops) im neuen Track × Übergangslängen.
 * Bewertet Sektionswechsel, Drop-Swap, Drums im Überlappungsbereich, Gesangskonflikte,
 * Energieverlauf und wie viel vom alten Track übersprungen würde.
 */
function choosePoints(ctx, lengths, allowFull = false) {
  const { va, vb, a, b, m } = ctx;
  const E = va.end;
  const drops = a.points.drops?.length ? a.points.drops : [a.points.dropBar];
  const arrivals = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).slice(0, 2);
  const earliest = ctx.earliestBar !== null ? ctx.earliestBar : 0;
  const minOut = Math.max(va.grid(earliest, 4), va.grid(E * 0.45, 4));
  let lastMainEnd = 0;
  for (let bar = 0; bar < E; bar++) if (va.label(bar) === 'main') lastMainEnd = bar + 1;
  const quietFrom = Math.max(lastMainEnd, (a.points.vocalLast ?? -1) + 1);
  let best = null;

  for (const arrival of arrivals) {
    const leadMax = (arrival - b.points.startBar) / m;
    const Ls = [...new Set([...lengths.filter((L) => L <= leadMax), Math.floor(leadMax / 4) * 4])]
      .filter((L) => L >= 4 && L <= Math.max(...lengths));
    for (const L of Ls) {
      const inBar = Math.round(arrival - L * m);
      for (let outBar = minOut; outBar <= E - 4; outBar += 4) {
        const why = [];
        let sc = 0;
        const outEnd = outBar + L;
        const labStart = va.label(outBar);
        // Sektionswechsel im alten Track: hier "atmet" der Song – natürlicher Mix-Punkt
        if (va.isPhraseStart(outBar)) sc += 0.25;
        // Niemals, während der alte Track noch voll im Drop ist (harte Kicks, volle Energie)
        if (fullEnergyInside(va, outBar, Math.min(outEnd, E))) {
          if (!allowFull) continue;
          sc -= 3; // nur als allerletzte Möglichkeit
        }
        if (va.label(outBar - 1) !== labStart) {
          sc += 0.35;
          if (labStart === 'break' || labStart === 'outro' || labStart === 'build') {
            sc += 0.35;
            why.push(labStart === 'outro' ? 'Einstieg mit dem Outro des alten Tracks' : `Einstieg, wenn der alte Track in den ${labStart === 'build' ? 'Build-up' : 'Break'} geht`);
          }
        }
        // Drop-Swap: der Drop des neuen Tracks ersetzt einen Drop des alten
        const swapDrop = drops.find((d) => d === outEnd);
        if (swapDrop !== undefined && swapDrop > outBar) {
          sc += 0.7;
          why.push('Drop-Swap: der neue Drop kommt genau dort, wo der alte seinen hätte');
        } else if (drops.some((d) => d > outBar && d < Math.min(outEnd, E) - 1)) {
          sc -= 0.7; // alter Drop mitten im Übergang
        }
        // übersprungene Hauptteile des alten Tracks
        let skippedMain = 0;
        for (let bar = outEnd; bar < E; bar++) if (va.label(bar) === 'main') skippedMain++;
        if (swapDrop === undefined) sc -= skippedMain * 0.035;
        else sc -= Math.max(0, skippedMain - 16) * 0.035; // beim Drop-Swap ersetzt der neue Drop den alten
        sc -= Math.max(0, E - outEnd) * 0.001;
        // Nicht ein langes, ereignisloses Ende ausspielen: nach dem letzten Hauptteil/Gesang
        // höchstens ein paar Takte warten, dann mixen
        const idle = Math.max(0, outBar - quietFrom);
        sc -= Math.max(0, idle - 4) * 0.06;
        if (outEnd > E) sc -= 0.25 + (outEnd - E) * 0.03; // bräuchte Loop-Verlängerung
        // neuer Track: lieber zum ersten Drop ankommen
        if (arrival !== arrivals[0]) sc -= 0.35;
        // während des Überlappens soll der neue Track noch "aufbauen" (kein Hauptteil)
        let inMain = 0;
        for (let t = 0; t < L; t++) if (vb.label(inBar + t * m) === 'main') inMain++;
        sc -= (inMain / L) * 0.6;
        // Drums in beiden Tracks -> Beatmatch hörbar und tragend
        const outDr = va.mean(va.drums, outBar, Math.min(outEnd, E));
        const inDr = vb.mean(vb.drums, inBar, inBar + L * m);
        sc += 0.3 * Math.min(outDr, inDr);
        // zwei Stimmen gleichzeitig
        let clash = 0;
        for (let t = 0; t < L; t++) {
          if (va.vocalSmooth(outBar + t) >= 0.45 && vb.vocalSmooth(inBar + t * m) >= 0.45) clash++;
        }
        sc -= clash * 0.05 * (ctx.profile?.vocal ?? 1);
        // Gesangszeilen des alten Tracks nicht abschneiden: Zeile läuft über das Ende hinaus
        // oder fällt in die Ausblendphase (zweite Hälfte) -> stark bestrafen
        if (va.vocalSmooth(outEnd - 1) >= 0.55 && va.vocalSmooth(outEnd) >= 0.55) sc -= 0.8;
        let lateVocal = 0;
        for (let t = Math.floor(L / 2); t < L; t++) if (va.vocalSmooth(outBar + t) >= 0.55) lateVocal++;
        sc -= lateVocal * 0.08;
        // Gesang direkt vor einem Drop des alten Tracks (Pre-Drop-Zeile) nie mitten drin kappen
        if (drops.some((d) => d > outBar && d <= outEnd + 1) && va.mean(va.vocalSmooth, outEnd - 2, outEnd) >= 0.6) sc -= 0.5;
        // Energie: Ende des alten Teils vs. Ankunft des neuen – passend zum gewünschten Verlauf
        const eOut = va.mean(va.energy, Math.max(outBar, outEnd - 4), Math.min(outEnd, E));
        const eIn = vb.mean(vb.energy, arrival, arrival + 4);
        sc -= Math.abs(eIn - eOut - (ctx.energyUp > 0.1 ? 3 : 0)) * 0.02;
        // längeres Verweben ist schöner – solange die Tonarten passen
        sc += (ctx.keyDist <= 0.15 ? 0.012 : ctx.keyDist <= 0.35 ? 0.004 : -0.01) * L;
        if (!best || sc > best.score) best = { score: sc, outBar, inBar, L, arrival, why };
      }
    }
  }
  if (!best && !allowFull) return choosePoints(ctx, lengths, true);
  return best;
}

// ------------------------------------------------------------------ Bausteine

export const ENTRY_FLAVORS = { eq: 'EQ-Einstieg', lpOpen: 'Tiefpass öffnet sich', hpIn: 'dünner Hochpass-Einstieg' };
export const EXIT_FLAVORS = { fade: 'Ausblenden', lpOut: 'Tiefpass-Ausstieg', hpOut: 'Hochpass-Ausstieg', echoOut: 'Echo-Wurf', loopOut: 'Loop-Out' };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Wählt Ein- und Ausstiegs-Baustein passend zu den Tracks (Energie, Helligkeit, Tonart,
 * Loopbarkeit) mit etwas Abwechslung, und baut sie in den Übergang ein.
 */
function applyFlavors(ctx, steps, { L, sw, q, fadeFrom }) {
  const { va, vb, a, b } = ctx;
  const roll = hash(`${ctx.outId}|${ctx.inId}`); // stabil pro Paar, verschieden zwischen Paaren
  const recent = ctx.flavorHistory || [];

  // --- Einstieg
  const entry = { eq: 1 };
  const inDark = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 4) < 0.35; // atmosphärisches Intro
  entry.lpOpen = 0.8 + (inDark ? 0.4 : 0) + (ctx.keyDist >= 0.3 ? 0.3 : 0);
  entry.hpIn = 0.7 + ((b.brightness ?? -10) > -8 ? 0.2 : 0) + (ctx.energyUp > 0.1 ? 0.2 : 0);
  // --- Ausstieg
  const exit = { fade: 0.9 };
  exit.lpOut = 0.8 + (ctx.energyUp < -0.05 ? 0.5 : 0);
  exit.hpOut = 0.8 + (ctx.energyUp > 0.05 ? 0.4 : 0);
  if (ctx.energyUp > 0.25) exit.echoOut = 0.45;
  const tailLoop = bestLoop(va, Math.max(0, ctx.outBar + Math.floor(fadeFrom) - 4), ctx.outBar + Math.floor(fadeFrom), 1);
  if (!ctx.loopExt && tailLoop && loopable(va, { bar: tailLoop.bar, len: 1 }, tailLoop.bar) && L - fadeFrom >= 1) exit.loopOut = 0.5;

  const pick = (opts, key) => {
    let best = null;
    let bestS = -Infinity;
    Object.entries(opts).forEach(([k, v], i) => {
      const sc = v - (recent.includes(`${key}:${k}`) ? 0.45 : 0) + 0.35 * hash(`${roll}|${key}|${i}`);
      if (sc > bestS) {
        bestS = sc;
        best = k;
      }
    });
    return best;
  };
  const en = pick(entry, 'in');
  const ex = pick(exit, 'out');
  ctx.flavors = { entry: en, exit: ex };

  if (en === 'lpOpen') {
    steps.push(p(0, 'in', 'filter', -0.7), p(q * 0.5, 'in', 'filter', 0, Math.max(1, sw - q * 0.5)));
    ctx.notes.push('neuer Track öffnet sich langsam aus dem Tiefpass');
  } else if (en === 'hpIn') {
    steps.push(p(0, 'in', 'filter', 0.45), p(q, 'in', 'filter', 0, Math.max(1, sw - q)));
    ctx.notes.push('neuer Track kommt erst dünn (Hochpass) und bekommt dann Körper');
  }
  const fl = Math.max(0.5, L - fadeFrom + 0.5);
  if (ex === 'lpOut') {
    steps.push(p(fadeFrom - 0.5, 'out', 'filter', -0.6, fl));
    ctx.notes.push('alter Track verschwindet im Tiefpass');
  } else if (ex === 'hpOut') {
    steps.push(p(fadeFrom - 0.5, 'out', 'filter', 0.6, fl));
    ctx.notes.push('alter Track wird per Hochpass ausgedünnt');
  } else if (ex === 'echoOut') {
    steps.push(p(Math.max(fadeFrom, L - 0.75), 'out', 'echo', 0.35, 0.25), p(L - 0.25, 'out', 'echo', 0, 0.25));
    ctx.notes.push('Echo-Wurf auf dem letzten Beat des alten Tracks');
  } else if (ex === 'loopOut') {
    const at = Math.max(Math.ceil(fadeFrom), L - 2);
    const bar = va.grid(ctx.outBar + at - 1, 1, 'floor');
    steps.push(act(at, 'out', 'loop', { bars: 1, anchor: bar - ctx.outBar }));
    ctx.notes.push('alter Track läuft auf einem 1-Takt-Loop aus');
  }
}

// ------------------------------------------------------------------ Composer je Technik

function composeBlend(ctx) {
  const { va, vb, b, m } = ctx;
  const inStart = b.points.startBar;
  const inDrop = b.points.dropBar;
  const inLead = (inDrop - inStart) / m;
  const steps = [];
  const lengths = (ctx.keyDist <= 0.15 ? [32, 16, 8, 4] : ctx.keyDist <= 0.35 ? [16, 8, 4] : [8, 4])
    .filter((x) => x <= ctx.maxL && ctx.profile.lengths.includes(x));

  let L;
  const pt = ctx.instant ? null : choosePoints(ctx, lengths);
  if (pt) {
    ctx.outBar = pt.outBar;
    ctx.inBar = pt.inBar;
    L = pt.L;
    ctx.notes.push(...pt.why);
    if (ctx.keyDist >= 0.5) ctx.notes.push('kurz gehalten wegen Tonart-Clash');
  } else {
    L = inLead >= 16 && !ctx.instant ? 16 : inLead >= 8 || ctx.instant ? 8 : 4;
    ctx.outBar = exitBar(ctx, L);
    ctx.inBar = Math.max(inStart, Math.round(inDrop - L * m));
  }
  L = extendWithLoop(ctx, steps, L);

  // Bass-Swap dort, wo der Bass des neuen Tracks einsetzt – sonst auf der Phrasenmitte
  const entry = vb.bassEntry(ctx.inBar, ctx.inBar + L * m);
  const entryT = entry === null ? null : (entry - ctx.inBar) / m;
  let sw = L / 2;
  if (entryT !== null && entryT >= L * 0.25 && entryT <= L * 0.75) sw = L >= 8 ? r4(entryT) : entryT;
  sw = Math.min(L, sw);
  const inDrums = vb.mean(vb.drums, ctx.inBar, ctx.inBar + L * m);
  const outHasBass = va.mean(va.bass, outBarAt(ctx, sw), outBarAt(ctx, sw) + 4) > -14
    || va.mean(va.drums, outBarAt(ctx, sw), outBarAt(ctx, sw) + 4) > 0.3;
  const clash = ctx.keyDist >= 0.35;
  const q = L / 4;

  // Verweben in Stufen: erst Höhen (Hi-Hats), dann Mitten, dann Bass – der alte Track gibt
  // in umgekehrter Reihenfolge ab. Lautstärke- und EQ-Fahrten laufen in weichen Kurven.
  steps.push(p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'mid', clash ? -12 : -8), p(0, 'in', 'high', -12));
  steps.push(act(0, 'in', 'play'));
  steps.push(p(0, 'in', 'fader', inDrums > 0.4 ? 0.75 : 0.85, Math.max(1, q)));
  steps.push(p(q * 0.5, 'in', 'high', -2, q));
  steps.push(p(q, 'out', 'high', -4, q));
  const midStart = Math.max(q * 1.5, sw - q);
  steps.push(p(midStart, 'in', 'mid', clash ? -4 : -1, Math.max(0.5, sw - midStart)));
  // Bass-Swap: kurz (1 Beat bis ½ Takt), damit sich die Bässe nicht vermatschen
  const swapDur = inDrums > 0.4 ? ctx.profile.swap : Math.max(0.5, ctx.profile.swap);
  if (outHasBass) steps.push(p(sw, 'out', 'low', KILL, swapDur));
  steps.push(p(sw, 'in', 'low', 0, swapDur));
  steps.push(p(sw, 'in', 'fader', 1, Math.max(0.5, Math.min(2, q / 2))));
  steps.push(p(sw + 0.5, 'in', 'high', 0, Math.max(0.5, q / 2)));
  // Singt der alte Track noch, bleiben Mitten/Lautstärke bis zum Ende seiner Zeile stehen
  let vEnd = -1;
  for (let t = 0; t < L; t++) if (va.vocalSmooth(outBarAt(ctx, t)) >= 0.45) vEnd = t;
  const holdUntil = Math.min(L - 0.5, Math.max(sw + 0.5, vEnd + 1));
  if (vEnd >= sw) ctx.notes.push(`alter Track singt seine Zeile bis Takt ${vEnd + 1} zu Ende, erst dann raus`);
  steps.push(p(holdUntil, 'out', 'mid', clash ? -14 : -9, Math.max(0.5, (L - holdUntil) * 0.6)));
  steps.push(p(sw + Math.max(1, q / 2), 'in', 'mid', 0, Math.max(0.5, q / 2)));
  steps.push(p(Math.max(holdUntil, L - q * 1.5), 'out', 'high', -14, Math.max(0.5, Math.min(q, L - Math.max(holdUntil, L - q * 1.5)))));
  const fadeFrom = Math.max(holdUntil, sw + 1, L - q * 1.25);
  applyFlavors(ctx, steps, { L, sw, q, fadeFrom });
  steps.push(p(fadeFrom, 'out', 'fader', 0, Math.max(0.25, L - fadeFrom)));
  steps.push(act(L, 'out', 'stop'));
  vocalGuard(ctx, steps, L, sw);

  ctx.notes.unshift(
    `${L} Takte ineinander verwoben – erst Höhen, dann Mitten, Bass-Swap bei Takt ${sw}${entryT !== null && Math.abs(entryT - sw) < 2 ? ' (wenn der neue Bass einsetzt)' : ''}`,
  );
  return { L, steps };
}

function composeLoop(ctx) {
  const { va, vb, b, m } = ctx;
  const inStart = b.points.startBar;
  const inDrop = b.points.dropBar;
  const inLead = (inDrop - inStart) / m;
  const steps = [];

  // Loop-Stelle: im Endbereich des alten Tracks die groovigste, gesangsfreie Stelle
  let loop;
  if (ctx.earliestBar !== null) {
    const bar = afterFullEnergy(va, va.grid(ctx.earliestBar, ctx.instant ? 1 : 4));
    const len = va.mean(va.repeat, bar, bar + 8) > 0.6 && bar + 8 <= va.end ? 8 : 4;
    loop = { bar, len };
  } else {
    const from = Math.max(0, va.end - 32);
    const l8 = bestLoop(va, from, va.end, 8);
    const l4 = bestLoop(va, from, va.end, 4);
    loop = [l8, l4].filter((l) => l && loopable(va, l)).sort((x, y) => y.score + (y.len === 8 ? 0.1 : 0) - x.score - (x.len === 8 ? 0.1 : 0))[0];
    if (!loop) return null; // keine saubere Loop-Stelle -> Composer fällt auf Blend zurück
  }
  ctx.outBar = loop.bar;
  ctx.loopExt = loop;
  let L = inLead >= 16 && !ctx.instant && ctx.maxL >= 16 ? 16 : 8;
  ctx.inBar = Math.max(inStart, Math.round(inDrop - L * m));
  const build = ctx.energyUp > 0.08 && inLead >= 8;

  steps.push(act(0, 'out', 'loop', { bars: loop.len, anchor: 0 }));
  steps.push(p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'filter', -0.7));
  steps.push(act(0, 'in', 'play'));
  steps.push(p(0, 'in', 'fader', 0.85, L * 0.5));
  steps.push(p(L * 0.25, 'in', 'filter', 0, L * 0.5));

  if (build) {
    // Groove halten, dann Loop-Roll als Build-up – der Bass kommt erst mit dem Drop
    steps.push(p(L - 4, 'out', 'filter', 0.6, 3.75));
    steps.push(p(L - 2, 'out', 'low', KILL, 0.25));
    steps.push(act(L - 2, 'out', 'loop', { bars: 1, anchor: 0 }));
    steps.push(act(L - 1, 'out', 'loop', { bars: 0.5, anchor: 0 }));
    steps.push(act(L - 0.5, 'out', 'loop', { bars: 0.25, anchor: 0 }));
    steps.push(p(L - 0.75, 'out', 'echo', 0.25, 0.5));
    steps.push(p(L - 0.5, 'out', 'fader', 0, 0.5), p(L, 'in', 'low', 0, 0.125), p(L - 1, 'in', 'fader', 1, 1));
    steps.push(p(L, 'out', 'echo', 0));
    steps.push(act(L, 'out', 'stop'));
    ctx.notes.unshift(
      `Loop ${loop.len} Takte auf dem Groove des alten Tracks, neuer Track kommt gefiltert darüber`,
      'am Ende Loop-Roll als Build-up, Bass erst mit dem Drop',
    );
    vocalGuard(ctx, steps, L, L);
  } else {
    const entry = vb.bassEntry(ctx.inBar, ctx.inBar + L * m);
    const entryT = entry === null ? null : (entry - ctx.inBar) / m;
    const sw = entryT !== null && entryT >= L * 0.25 && entryT <= L * 0.75 ? r4(entryT) : L / 2;
    steps.push(p(sw, 'out', 'low', KILL, 0.25), p(sw, 'in', 'low', 0, 0.25));
    steps.push(p(sw, 'out', 'filter', -0.55, L - sw));
    steps.push(p(L * 0.5 + 0.01, 'in', 'fader', 1, 2));
    steps.push(p(L * 0.75, 'out', 'fader', 0, L * 0.25));
    steps.push(act(L, 'out', 'stop'));
    ctx.notes.unshift(
      `Loop ${loop.len} Takte hält den Groove des alten Tracks`,
      `Bass-Swap bei Takt ${sw}, danach wird der Loop weggefiltert`,
    );
    vocalGuard(ctx, steps, L, sw);
  }
  return { L, steps };
}

function composeVocal(ctx) {
  const { va, vb, b, m } = ctx;
  const u = 4;
  const pre = 4;
  // Alter Track: ein später Gesangsabschnitt (letzter Refrain), neuer: der erste
  let outFrom;
  if (ctx.earliestBar !== null) {
    outFrom = afterFullEnergy(va, va.grid(ctx.earliestBar, ctx.instant ? 1 : 4));
    if (va.mean(va.vocal, outFrom, outFrom + 8) < 0.4) return null;
  } else {
    const runs = va.vocalRuns(8).filter((r) => r.from >= va.end * 0.35);
    const run = runs[runs.length - 1];
    if (!run) return null;
    outFrom = va.grid(run.from, 4);
    if (outFrom + 8 > run.to) outFrom = va.grid(run.from, 4, 'floor');
  }
  const inRun = vb.vocalRuns(8)[0];
  if (!inRun) return null;
  const vIn = vb.grid(inRun.from, 4, 'floor');
  ctx.outBar = outFrom;
  ctx.inBar = Math.max(b.points.startBar, Math.round(vIn - pre * m));

  // Wechsel so oft, wie beide Stimmen haben (max. 4), Ende immer beim neuen Track
  const singers = [];
  // Wechsel nur vor dem ersten Drop des neuen Tracks (danach laufen nie zwei Tracks im Drop)
  const inNextDrop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > ctx.inBar);
  const limit = inNextDrop === undefined ? Infinity : (inNextDrop - ctx.inBar) / m;
  for (let j = 0; j < 4; j++) {
    const t = pre + j * u;
    if (t + u > limit) break;
    const who = j % 2 === 0 ? 'in' : 'out';
    const has = who === 'in'
      ? vb.mean(vb.vocal, ctx.inBar + t * m, ctx.inBar + (t + u) * m) >= 0.3
      : va.mean(va.vocal, outFrom + t, outFrom + t + u) >= 0.3;
    if (!has) break;
    singers.push(who);
  }
  while (singers.length && singers[singers.length - 1] === 'out') singers.pop();
  if (!singers.length) return null;
  const L = pre + singers.length * u;
  const steps = [];
  steps.push(p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'vocal', 1));
  steps.push(act(0, 'in', 'play'));
  steps.push(p(0, 'in', 'fader', 0.8, pre / 2));
  singers.forEach((who, j) => {
    const t = pre + j * u;
    steps.push(p(t, who === 'in' ? 'in' : 'out', 'vocal', 0, 0.25));
    steps.push(p(t, who === 'in' ? 'out' : 'in', 'vocal', 1, 0.25));
  });
  const sw = singers.length > 2 ? pre + 2 * u : pre;
  steps.push(p(sw, 'out', 'low', KILL, 0.25), p(sw, 'in', 'low', 0, 0.25), p(sw, 'in', 'fader', 1, 0.25));
  steps.push(p(L - u, 'out', 'high', -8, u - 1));
  steps.push(p(L - u, 'out', 'fader', 0, u));
  steps.push(act(L, 'out', 'stop'));
  ctx.notes.unshift(
    `Gesang wechselt ${singers.length}× im ${u}-Takt-Rhythmus zwischen beiden Tracks`,
    `Bass geht bei Takt ${sw} an den neuen Track`,
  );
  return { L, steps };
}

function composeFilter(ctx) {
  const { vb, b, m } = ctx;
  const inLead = (b.points.dropBar - b.points.startBar) / m;
  const steps = [];
  let L = inLead >= 16 && !ctx.instant ? 16 : 8;
  const pt = ctx.instant ? null : choosePoints(ctx, [16, 8, 4].filter((x) => x <= ctx.maxL && ctx.profile.lengths.includes(x)));
  if (pt) {
    ctx.outBar = pt.outBar;
    ctx.inBar = pt.inBar;
    L = pt.L;
    ctx.notes.push(...pt.why);
  } else {
    ctx.outBar = exitBar(ctx, L);
    ctx.inBar = Math.max(b.points.startBar, Math.round(b.points.dropBar - L * m));
  }
  L = extendWithLoop(ctx, steps, L);
  const down = ctx.energyUp < -0.05;
  const depth = down ? -0.7 : 0.55 + Math.min(0.25, Math.max(0, (ctx.a.brightness ?? 0) + 12) / 48);
  const sw = r4(L * 0.75) > L ? L / 2 : Math.min(L - 1, r4(L * 0.75));

  steps.push(p(0, 'in', 'fader', 0), p(0, 'in', 'filter', -0.85), p(0, 'in', 'low', KILL));
  steps.push(act(0, 'in', 'play'));
  steps.push(p(0, 'in', 'fader', 1, L * 0.3));
  steps.push(p(0, 'out', 'filter', depth, L * 0.85));
  steps.push(p(L * 0.1, 'in', 'filter', 0, L * 0.65));
  steps.push(p(sw, 'out', 'low', KILL, 0.25), p(sw, 'in', 'low', 0, 0.25));
  steps.push(p(L * 0.8, 'out', 'fader', 0, L * 0.2));
  steps.push(act(L, 'out', 'stop'));
  vocalGuard(ctx, steps, L, sw);
  ctx.notes.unshift(
    down ? 'alter Track wird per Tiefpass abgedunkelt' : 'alter Track wird per Hochpass ausgedünnt',
    'neuer Track öffnet sich aus dem Tiefpass',
    `Bass-Swap bei Takt ${sw}`,
  );
  return { L, steps };
}

function composeCut(ctx) {
  const { va, a, b } = ctx;
  if (ctx.earliestBar !== null) ctx.outBar = afterFullEnergy(va, va.grid(ctx.earliestBar, ctx.instant ? 1 : 4));
  else ctx.outBar = a.points.outroBar ?? va.grid(va.end - 8, 8, 'floor');
  ctx.outBar = Math.min(ctx.outBar, va.end - 1);
  ctx.inBar = b.points.dropBar;
  const steps = [p(0, 'in', 'fader', 0), act(0, 'in', 'play'), p(0, 'in', 'fader', 1, 0.125), p(0, 'out', 'fader', 0, 0.125)];
  const loud = va.mean(va.energy, ctx.outBar - 2, ctx.outBar) > -5;
  if (!ctx.instant && loud) {
    steps.push(p(-2, 'out', 'filter', 0.5, 1.75), p(-0.25, 'out', 'echo', 0.3, 0.25));
    ctx.notes.unshift('2 Takte Hochpass-Aufbau, dann harter Schnitt direkt in den Drop');
  } else if (!ctx.instant) {
    steps.push(p(-1, 'out', 'filter', 0.35, 0.9));
    ctx.notes.unshift('kurzer Hochpass, dann auf dem Takt direkt in den Drop');
  } else {
    ctx.notes.unshift('sofortiger Schnitt auf dem Takt in den Drop');
  }
  steps.push(p(0.25, 'out', 'echo', 0), act(1, 'out', 'stop'));
  return { L: 1, steps };
}

function composeEcho(ctx) {
  const { va, vb, a, b } = ctx;
  if (ctx.earliestBar !== null) ctx.outBar = afterFullEnergy(va, va.grid(ctx.earliestBar, ctx.instant ? 1 : 4));
  else ctx.outBar = a.points.outroBar ?? va.grid(va.end - 8, 8, 'floor');
  ctx.outBar = Math.min(ctx.outBar, va.end - 1);
  ctx.inBar = b.points.startBar;
  const beatless = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 4) < 0.3;
  const start = beatless ? 0.5 : 1;
  const steps = [p(0, 'in', 'fader', 1)];
  if (ctx.instant) {
    steps.push(p(0, 'out', 'echo', 0.5), p(0.25, 'out', 'fader', 0, 0.25));
  } else {
    steps.push(p(-1, 'out', 'filter', 0.45, 1), p(-0.5, 'out', 'echo', 0.5, 0.5), p(0, 'out', 'fader', 0, 0.25));
  }
  steps.push(p(0.5, 'out', 'echo', 0), act(start, 'in', 'play'), act(1, 'out', 'stop'));
  ctx.notes.unshift(
    'alter Track verhallt im Echo',
    beatless ? 'neuer Track startet mit seinem ruhigen Intro schon unter der Echo-Fahne' : 'neuer Track startet einen Takt später in seinem eigenen Tempo',
  );
  return { L: 2, steps };
}

/**
 * Vocal-Übergabe (Wortspiel-Technik): die letzte Zeile des alten Tracks läuft fast a cappella über
 * den Beat des neuen – genau wenn sie endet, setzt die erste Zeile des neuen Tracks ein.
 */
function composeHandoff(ctx) {
  const { va, vb, a, b, m } = ctx;
  const u = 4; // Länge der letzten Zeile
  const outRuns = va.vocalRuns(4).filter((r) => r.to >= va.end * 0.5);
  const inRuns = vb.vocalRuns(4);
  if (!outRuns.length || !inRuns.length) return null;
  const outRun = outRuns[outRuns.length - 1];
  const lineEnd = va.grid(outRun.to, 4, 'round'); // Ende der letzten Zeile auf dem Raster
  let outBar = lineEnd - u;
  if (ctx.earliestBar !== null && outBar < ctx.earliestBar) return null;
  if (outBar < outRun.from || fullEnergyInside(va, outBar, lineEnd)) return null;
  const vIn = vb.grid(inRuns[0].from, 4, 'floor');
  const inBar = Math.round(vIn - u * m);
  if (inBar < b.points.startBar) return null;
  // Übergabe muss vor dem ersten Drop des neuen Tracks fertig sein
  const drop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > inBar);
  if (drop !== undefined && (drop - inBar) / m < u + 1) return null;
  ctx.outBar = outBar;
  ctx.inBar = inBar;
  const L = u + 1;
  const steps = [
    // neuer Beat kommt unter die letzte Zeile, ohne eigenen Gesang (der kommt erst danach)
    p(0, 'in', 'fader', 0), p(0, 'in', 'vocal', 1), p(0, 'in', 'low', KILL),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 0.9, 1),
    // alter Track: Beat und Bass weg -> Stimme steht fast a cappella über dem neuen Beat
    p(0, 'out', 'low', KILL, 0.5),
    p(0.5, 'out', 'filter', 0.35, 1),
    p(1, 'in', 'low', 0, 0.5),
    // Übergabe: Zeile endet, neue Stimme setzt ein
    p(u - 0.25, 'in', 'vocal', 0, 0.25),
    p(u - 0.25, 'in', 'fader', 1, 0.25),
    p(u - 0.25, 'out', 'fader', 0, 1),
    act(L, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    'Vocal-Übergabe: die letzte Zeile des alten Tracks läuft über den neuen Beat',
    `genau wenn sie endet, setzt die erste Zeile des neuen Tracks ein (Takt ${u})`,
  );
  return { L, steps };
}

/**
 * Wortspiel: das letzte Wort einer Zeile im alten Track und ein gleiches/reimendes Wort am
 * Zeilenanfang im neuen Track. Der neue Track wird so angelegt, dass sein Wort genau auf dem
 * Beat nach dem Wort des alten einsetzt – dort wird übergeben.
 */
function composeWordplay(ctx) {
  const { va, a, b, m } = ctx;
  const wp = ctx.wordplay;
  if (!wp) return null;
  const beatOut = (wp.out.end - a.firstBeat) / a.beatInterval;
  const handBeat = Math.ceil(beatOut - 0.1); // nächster Beat nach dem Wort
  const beatIn = (wp.in.start - b.firstBeat) / b.beatInterval;
  const inBeat = Math.round(beatIn);
  if (Math.abs(beatIn - inBeat) > 0.35) return null; // Wort liegt zu weit neben dem Beat
  const hb = (handBeat - a.downbeat) / 4; // Übergabe als Takt (evtl. gebrochen)
  const pre = 4; // 4 Takte Vorlauf, neuer Track leise und ohne Gesang darunter
  const outBar = hb - pre;
  if (outBar < 0 || fullEnergyInside(va, Math.floor(outBar), Math.ceil(hb))) return null;
  if (ctx.earliestBar !== null && outBar < ctx.earliestBar) return null;
  const inBar = (inBeat - b.downbeat) / 4 - pre * m;
  if (inBar < b.points.startBar - 1e-6) return null;
  const drop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > inBar);
  if (drop !== undefined && (drop - inBar) / m < pre + 0.5) return null;
  ctx.outBar = outBar;
  ctx.inBar = inBar;
  const L = pre + 0.5;
  const steps = [
    p(0, 'in', 'fader', 0), p(0, 'in', 'vocal', 1), p(0, 'in', 'low', KILL),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 0.55, 2),
    // Übergabe genau auf dem Beat nach dem Wort
    p(pre - 0.0625, 'in', 'vocal', 0, 0.0625),
    p(pre, 'in', 'fader', 1, 0.125),
    p(pre, 'in', 'low', 0, 0.25),
    p(pre, 'out', 'low', KILL, 0.125),
    p(pre, 'out', 'fader', 0, 0.5),
    act(L, 'out', 'stop'),
  ];
  const aligned = ((handBeat - a.downbeat) % 4 + 4) % 4 === ((inBeat - b.downbeat) % 4 + 4) % 4;
  ctx.notes.unshift(
    `Wortspiel (${wp.kind === 'gleich' ? 'gleiches Wort' : 'Reim'}): „${wp.out.text}“ → „${wp.in.text}“`,
    `Übergabe genau auf dem Beat nach „${wp.out.text}“${aligned ? '' : ' (Takt-Position verschoben)'}`,
  );
  return { L, steps };
}

const COMPOSERS = {
  wordplay: composeWordplay,
  handoff: composeHandoff,
  blend: composeBlend,
  loop: composeLoop,
  vocal: composeVocal,
  filter: composeFilter,
  cut: composeCut,
  echo: composeEcho,
};

// ------------------------------------------------------------------ Auswahl

function scoreStyles(ctx) {
  const { va, vb, a, b, rel, keyDist, energyUp, m } = ctx;
  const tempoOk = rel.diff <= BEATMATCH_LIMIT;
  const inLead = (b.points.dropBar - b.points.startBar) / m;
  const cleanFrom = va.grid((a.points.vocalLast ?? -1) + 1, 4);
  const outClean = va.end - cleanFrom;
  const loop = bestLoop(va, Math.max(0, va.end - 32), va.end, 8);
  const outVocal = va.vocalRuns(8).some((r) => r.from >= va.end * 0.35);
  const inVocal = vb.vocalRuns(8).length > 0;
  const inHeadVocal = vb.mean(vb.vocal, b.points.startBar, b.points.dropBar) >= 0.45;
  const vocalClash = outClean < 8 && inHeadVocal;

  const c = {};
  if (tempoOk) {
    // Verweben (Blend) ist der Normalfall; alles Härtere nur, wenn die Tracks es verlangen
    c.blend = 1.3 + (inLead >= 16 ? 0.4 : inLead >= 8 ? 0.1 : -0.7) + (outClean >= 8 ? 0.2 : -0.1)
      + (keyDist <= 0.15 ? 0.3 : -0.9 * keyDist) - (vocalClash ? 0.5 : 0);
    if (loop && loopable(va, loop)) c.loop = 0.6 + (outClean < 8 ? 0.4 : 0) + (energyUp > 0.2 ? 0.2 : 0);
    if (outVocal && inVocal) c.vocal = 1.5 + (keyDist <= 0.15 ? 0.35 : keyDist <= 0.35 ? 0 : -0.8);
    c.filter = 0.8 + (keyDist >= 0.3 ? 0.35 : 0) + (energyUp < -0.1 ? 0.2 : 0);
    c.cut = 0.2 + (inLead < 4 ? 0.6 : 0) + (keyDist >= 0.6 ? 0.3 : 0);
    c.echo = 0.05;
    const outLines = va.vocalRuns(4).some((r) => r.to >= va.end * 0.5);
    const inLines = vb.vocalRuns(4).length > 0;
    if (outLines && inLines) c.handoff = 1.25 + (keyDist <= 0.35 ? 0.2 : -0.4);
    if (ctx.wordplay) c.wordplay = 1.9 + (ctx.wordplay.kind === 'gleich' ? 0.3 : 0);
  } else {
    c.cut = rel.diff <= 0.2 ? 2.2 : 1.2;
    c.echo = rel.diff <= 0.2 ? 0.5 : 1.5;
  }
  for (const k of Object.keys(c)) c[k] += ctx.profile.styles[k] ?? 0;
  return c;
}

// ------------------------------------------------------------------ Hauptfunktion

/**
 * @param out, inc: Track-Objekte ({ analysis, energy })
 * @param outRate: aktuelles Tempo-Verhältnis des laufenden Decks
 * @param type: 'auto' oder ein Schlüssel aus TRANSITIONS
 * @param history: zuletzt verwendete Typen (neueste zuletzt) – für Abwechslung
 * @param earliestBar: frühester Takt im laufenden Track (Planung ab "jetzt")
 * @param instant: "Jetzt mixen" – so schnell wie möglich, auf dem nächsten Takt
 */
export function planTransition({ out, inc, outRate = 1, type = 'auto', history = [], earliestBar = null, instant = false, flavorHistory = [], outKeyShift = 0, wordplay = null }) {
  const a = out.analysis;
  const b = inc.analysis;
  const masterBpm = a.bpm * outRate;
  const rel = tempoRelation(masterBpm, b.bpm);
  // Key-Sync: neuen Track notfalls um bis zu ±2 Halbtöne verschieben, damit beide harmonisch passen
  const outKey = shiftCamelot(a.key.camelot, outKeyShift);
  const ks = keySync(outKey, b.key.camelot, (b.key.confidence ?? 1) > 0.15 && (a.key.confidence ?? 1) > 0.15);
  const keyDist = ks.dist;
  const forced = type !== 'auto' && type in TRANSITIONS;
  const ctx = {
    a, b, va: new TrackView(a), vb: new TrackView(b),
    rel, keyDist, masterBpm,
    energyUp: (inc.energy ?? 0.5) - (out.energy ?? 0.5),
    earliestBar, instant,
    m: 1, notes: [], loopExt: null, maxL: 32,
    genreOut: out.genre || detectGenre(a), genreIn: inc.genre || detectGenre(b),
    wordplay,
    outId: out.id ?? a.duration, inId: inc.id ?? b.duration, flavorHistory,
  };
  ctx.profile = combineProfiles(ctx.genreOut, ctx.genreIn);
  ctx.maxL = Math.min(ctx.maxL, Math.max(...ctx.profile.lengths));
  if (ks.semis) {
    ctx.notes.push(`Key-Sync: neuer Track um ${ks.semis > 0 ? '+' : ''}${ks.semis} Halbton${Math.abs(ks.semis) > 1 ? 'e' : ''} angeglichen (${b.key.camelot} → ${shiftCamelot(b.key.camelot, ks.semis)} passt zu ${outKey})`);
  }
  ctx.m = rel.diff <= (forced ? FORCED_LIMIT : BEATMATCH_LIMIT) ? rel.m : 1;

  let chosen = type;
  if (!forced) {
    const c = scoreStyles(ctx);
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    let best = -Infinity;
    for (const [k, score] of Object.entries(c)) {
      const s = score - (k === last ? 0.3 : 0) - (k === prev ? 0.15 : 0);
      if (s > best) {
        best = s;
        chosen = k;
      }
    }
  }
  let note = '';
  // Unsicheres Beatgrid (z. B. Live-Drums, schwankendes Tempo): lange Beatmatches würden
  // auseinanderlaufen -> kurz halten oder ohne Beatmatch per Echo wechseln.
  const conf = Math.min(a.gridConfidence ?? 1, b.gridConfidence ?? 1);
  ctx.maxL = Math.min(ctx.maxL, conf < 0.3 ? 4 : conf < 0.5 ? 8 : 32);
  if (conf < 0.5) ctx.notes.push('Beatgrid nicht ganz sicher – Überlappung kurz gehalten');
  if (forced && chosen !== 'echo' && chosen !== 'cut' && rel.diff > FORCED_LIMIT) {
    note = `${TRANSITIONS[chosen]} geht bei diesem Tempo-Sprung nicht – Echo-Out`;
    chosen = 'echo';
  }
  const beatmatch = chosen !== 'echo' && rel.diff <= (forced ? FORCED_LIMIT : BEATMATCH_LIMIT);
  if (!beatmatch) ctx.m = 1;

  let result = COMPOSERS[chosen](ctx);
  if (!result) {
    note = `${TRANSITIONS[chosen]} passt hier nicht (${chosen === 'loop' ? 'keine sauber loopbare Stelle' : 'keine passenden Gesangszeilen'}) – Blend`;
    chosen = 'blend';
    ctx.notes = [];
    ctx.loopExt = null;
    result = composeBlend(ctx);
  }
  let { L, steps } = result;
  // Der alte Track muss weg sein, bevor der neue in seinen (ersten) Drop geht –
  // zwei Tracks im Drop klingen immer nach Unfall.
  if (chosen !== 'cut' && chosen !== 'echo') {
    const nextDrop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > ctx.inBar);
    if (nextDrop !== undefined) {
      const tDrop = (nextDrop - ctx.inBar) / ctx.m;
      steps = clampOutBefore(steps, tDrop);
      if (L > tDrop) L = tDrop;
    }
  }
  const inRate = beatmatch ? (ctx.m * masterBpm) / b.bpm : 1;
  if (beatmatch && Math.abs(inRate - 1) > 0.001) {
    steps.push(act(Math.max(L, 1) + 0.5, 'in', 'rate', { to: 1, dur: 16 }));
  }
  if (!instant && TEASE_STYLES.has(chosen)) steps = addTeaser(ctx, steps);
  const cleaned = instant ? steps.filter((s) => s.at >= 0) : steps;
  cleaned.sort((x, y) => x.at - y.at);
  const end = Math.max(...cleaned.filter((s) => s.action !== 'rate').map((s) => s.at + (s.dur || 0)));

  if (ctx.genreOut !== ctx.genreIn || ctx.genreOut !== 'edm') {
    ctx.notes.push(`Stil angepasst: ${GENRES[ctx.genreOut]} → ${GENRES[ctx.genreIn]}`);
  }
  return {
    type: chosen,
    label: TRANSITIONS[chosen] + (ctx.flavors
      ? [ctx.flavors.entry !== 'eq' ? ENTRY_FLAVORS[ctx.flavors.entry] : null, ctx.flavors.exit !== 'fade' ? EXIT_FLAVORS[ctx.flavors.exit] : null]
        .filter(Boolean).map((x) => ` · ${x}`).join('')
      : ''),
    flavors: ctx.flavors || null,
    reason: (note ? `${note} · ` : '') + describe(outKey, shiftCamelot(b.key.camelot, ks.semis), b.bpm, rel, keyDist, masterBpm),
    keyShift: ks.semis,
    genres: [ctx.genreOut, ctx.genreIn],
    notes: ctx.notes,
    bars: L,
    endBars: end,
    masterBpm,
    beatmatch,
    m: ctx.m,
    inRate,
    outBar: ctx.outBar,
    inBar: ctx.inBar,
    echoBeats: 1, // Wiederholungen immer genau auf dem Beat
    steps: cleaned,
  };
}

const TEASE_STYLES = new Set(['blend', 'filter', 'loop', 'handoff', 'vocal', 'wordplay']);
const TEASE_LEVEL = 0.22;

/**
 * Einen Takt vor dem Übergang wird der neue Track leise angeteasert: nur Höhen (Hi-Hats),
 * ohne Bass und Gesang. Danach geht der geplante Übergang ohne Lautstärke-Loch weiter.
 */
function addTeaser(ctx, steps) {
  const { b, m } = ctx;
  const composerVocal = steps.some((s) => s.deck === 'in' && s.param === 'vocal' && s.at <= 0);
  if (ctx.inBar - m < (b.points.startBar ?? 0) - 1e-6) {
    // kein Material vor dem Einstieg: erster Takt des Übergangs wird zum leisen Teaser
    const fadeIn = steps.find((s) => s.deck === 'in' && s.param === 'fader' && s.dur && s.at === 0);
    if (!fadeIn) return steps;
    const rest = steps.filter((s) => s !== fadeIn);
    rest.push(
      p(0, 'in', 'fader', TEASE_LEVEL, 0.75),
      { ...fadeIn, at: 1, dur: Math.max(0.5, fadeIn.dur - 1) },
    );
    if (!steps.some((s) => s.deck === 'in' && s.param === 'filter' && s.at <= 1)) {
      rest.push(p(0, 'in', 'filter', 0.55), p(0.75, 'in', 'filter', 0, 0.25));
    }
    ctx.notes.push('erster Takt: neuer Track nur leise angeteasert');
    return rest;
  }
  const out = [];
  for (const s of steps) {
    if (s.deck === 'in' && s.action === 'play' && s.at === 0) continue; // Start wandert nach vorn
    // "Fader auf 0" zu Beginn würde den Teaser abwürgen -> auf Teaser-Pegel halten
    if (s.deck === 'in' && s.param === 'fader' && s.at === 0 && !s.dur && s.to === 0) {
      out.push({ ...s, to: TEASE_LEVEL });
      continue;
    }
    out.push(s);
  }
  out.unshift(
    p(-1, 'in', 'fader', 0), p(-1, 'in', 'low', KILL), p(-1, 'in', 'vocal', 1), p(-1, 'in', 'filter', 0.55),
    act(-1, 'in', 'play', { barOffset: -m }),
    p(-1, 'in', 'fader', TEASE_LEVEL, 0.75),
    p(-0.25, 'in', 'filter', 0, 0.2),
  );
  // Gesangssperre nur aufheben, wenn der Composer den Gesang nicht selbst steuert
  if (!composerVocal) out.splice(7, 0, p(-0.05, 'in', 'vocal', 0, 0.04));
  ctx.notes.push('neuer Track wird einen Takt vorher leise angeteasert (nur Hi-Hats)');
  return out;
}

/** Alle Aktionen des alten Decks enden spätestens bei tEnd (Fader dann sicher auf 0). */
function clampOutBefore(steps, tEnd) {
  const out = [];
  let lastFade = null;
  for (const s of steps) {
    if (s.deck !== 'out') {
      out.push(s);
      continue;
    }
    if (s.at >= tEnd) {
      if (s.action === 'stop') out.push({ ...s, at: tEnd });
      continue;
    }
    const c = { ...s };
    if (c.dur && c.at + c.dur > tEnd) c.dur = tEnd - c.at;
    if (c.param === 'fader') lastFade = c;
    out.push(c);
  }
  // sicherstellen, dass der alte Track bei tEnd stumm ist
  if (!lastFade || lastFade.to > 0.001) {
    const from = Math.max(0, tEnd - 1);
    const conflicting = out.some((s) => s.deck === 'out' && s.param === 'fader' && s.at + (s.dur || 0) > from);
    if (!conflicting) out.push(p(from, 'out', 'fader', 0, tEnd - from));
  }
  if (!out.some((s) => s.deck === 'out' && s.action === 'stop')) out.push(act(tEnd, 'out', 'stop'));
  return out;
}

function describe(outKey, inKey, inBpm, rel, keyDist, masterBpm) {
  const parts = [`${masterBpm.toFixed(1)} → ${inBpm.toFixed(1)} BPM`];
  if (rel.m !== 1) parts.push(rel.m === 2 ? 'Doppeltempo' : 'Halbtempo');
  parts.push(`${outKey} → ${inKey}${keyDist <= 0.15 ? ' (harmonisch)' : keyDist >= 0.6 ? ' (Tonart-Clash)' : ''}`);
  if (rel.diff > BEATMATCH_LIMIT) parts.push('Tempo zu weit für Beatmatch');
  return parts.join(' · ');
}
