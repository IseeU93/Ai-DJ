// Übergangs-Composer: baut für jedes Track-Paar einen eigenen Übergang aus der Struktur beider
// Songs (Phrasen, Drums, Bass, Gesang, Wiederholungen, Energie) – wie ein DJ, der die Tracks kennt.
// Ergebnis ist eine deklarative Schrittliste (Takte relativ zu T0), die der Conductor sample-genau
// ausführt, plus Notizen, warum der Übergang so gebaut wurde.
import { BEATMATCH_LIMIT, camelotDistance, tempoRelation } from './order.js';

export const TRANSITIONS = {
  blend: 'Blend',
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
    for (let b = 0; b <= this.end; b++) {
      const on = b < this.end && this.vocalSmooth(b) >= 0.45;
      if (on && start === null) start = b;
      if (!on && start !== null) {
        if (b - start >= min) runs.push({ from: start, to: b });
        start = null;
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
  if (lastBefore >= 0) {
    const until = Math.min(sw, lastBefore + 1);
    steps.push(p(0, 'in', 'vocal', 1), p(until, 'in', 'vocal', 0, 0.5));
    ctx.notes.push(`Gesang des neuen Tracks bis Takt ${until} abgesenkt (sonst zwei Stimmen gleichzeitig)`);
  }
  if (clashAfter) {
    steps.push(p(sw, 'out', 'vocal', 1, 0.5));
    ctx.notes.push('Gesang des alten Tracks nach dem Bass-Swap abgesenkt');
  }
}

/** Ausstiegs-Takt: Übergangsende = Trackende, sonst frühester erlaubter Takt ("Jetzt mixen"). */
function exitBar(ctx, L) {
  const { va } = ctx;
  if (ctx.earliestBar !== null) return va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
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
  const loop = bestLoop(va, lo, va.end, avail >= 12 ? 8 : 4) || bestLoop(va, lo, va.end, 2);
  if (!loop || loop.score < 0.1) {
    ctx.notes.push('altes Outro zu kurz – Übergang verkürzt');
    return Math.max(2, Math.floor(avail / 2) * 2);
  }
  ctx.loopExt = loop;
  steps.push(act(loop.bar - outBar, 'out', 'loop', { bars: loop.len, anchor: loop.bar - outBar }));
  ctx.notes.push(`Loop über ${loop.len} Takte (ab Takt ${loop.bar - outBar}) verlängert das Ende des alten Tracks`);
  return L;
}

// ------------------------------------------------------------------ Mix-Punkt-Suche

/**
 * Sucht die musikalisch beste Stelle für den Übergang – nicht stur am Ende:
 * alle Phrasengrenzen im alten Track × alle "Ankünfte" (Drops) im neuen Track × Übergangslängen.
 * Bewertet Sektionswechsel, Drop-Swap, Drums im Überlappungsbereich, Gesangskonflikte,
 * Energieverlauf und wie viel vom alten Track übersprungen würde.
 */
function choosePoints(ctx, lengths) {
  const { va, vb, a, b, m } = ctx;
  const E = va.end;
  const drops = a.points.drops?.length ? a.points.drops : [a.points.dropBar];
  const arrivals = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).slice(0, 2);
  const earliest = ctx.earliestBar !== null ? ctx.earliestBar : 0;
  const minOut = Math.max(va.grid(earliest, 4), va.grid(E * 0.45, 4));
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
        sc -= Math.max(0, E - outEnd) * 0.004;
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
        sc -= clash * 0.05;
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
  return best;
}

// ------------------------------------------------------------------ Composer je Technik

function composeBlend(ctx) {
  const { va, vb, b, m } = ctx;
  const inStart = b.points.startBar;
  const inDrop = b.points.dropBar;
  const inLead = (inDrop - inStart) / m;
  const steps = [];
  const lengths = ctx.keyDist <= 0.15 ? [32, 16, 8] : ctx.keyDist <= 0.35 ? [16, 8] : [8];

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
  const swapDur = inDrums > 0.4 ? 0.25 : 0.5;
  if (outHasBass) steps.push(p(sw, 'out', 'low', KILL, swapDur));
  steps.push(p(sw, 'in', 'low', 0, swapDur));
  steps.push(p(sw, 'in', 'fader', 1, Math.max(0.5, Math.min(2, q / 2))));
  steps.push(p(sw + 0.5, 'in', 'high', 0, Math.max(0.5, q / 2)));
  steps.push(p(sw + 0.5, 'out', 'mid', clash ? -14 : -9, Math.max(1, (L - sw) * 0.6)));
  steps.push(p(sw + Math.max(1, q / 2), 'in', 'mid', 0, Math.max(0.5, q / 2)));
  steps.push(p(Math.max(sw + 1, L - q * 1.5), 'out', 'high', -14, Math.max(1, q)));
  const fadeFrom = Math.max(sw + 1, L - q * 1.25);
  if (ctx.energyUp < -0.1) {
    steps.push(p(fadeFrom - 1, 'out', 'filter', -0.4, L - fadeFrom + 1));
    ctx.notes.push('alter Track wird zum Ende weich abgedunkelt (Energie geht runter)');
  }
  steps.push(p(fadeFrom, 'out', 'fader', 0, L - fadeFrom));
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
    const bar = va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
    const len = va.mean(va.repeat, bar, bar + 8) > 0.6 && bar + 8 <= va.end ? 8 : 4;
    loop = { bar, len };
  } else {
    const from = Math.max(0, va.end - 32);
    const l8 = bestLoop(va, from, va.end, 8);
    const l4 = bestLoop(va, from, va.end, 4);
    loop = l8 && (!l4 || l8.score >= l4.score - 0.1) ? l8 : l4 || { bar: va.grid(va.end - 8, 4, 'floor'), len: 4 };
  }
  ctx.outBar = loop.bar;
  ctx.loopExt = loop;
  let L = inLead >= 16 && !ctx.instant ? 16 : 8;
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
    steps.push(p(L - 0.5, 'out', 'echo', 0.5, 0.5));
    steps.push(p(L - 0.25, 'out', 'fader', 0, 0.5), p(L, 'in', 'low', 0, 0.125), p(L - 1, 'in', 'fader', 1, 1));
    steps.push(p(L + 0.5, 'out', 'echo', 0, 0.5));
    steps.push(act(L + 1.5, 'out', 'stop'));
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
    outFrom = va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
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
  for (let j = 0; j < 4; j++) {
    const t = pre + j * u;
    const who = j % 2 === 0 ? 'in' : 'out';
    const has = who === 'in'
      ? vb.mean(vb.vocal, ctx.inBar + t * m, ctx.inBar + (t + u) * m) >= 0.4
      : va.mean(va.vocal, outFrom + t, outFrom + t + u) >= 0.4;
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
  const pt = ctx.instant ? null : choosePoints(ctx, [16, 8]);
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
  if (ctx.earliestBar !== null) ctx.outBar = va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
  else ctx.outBar = a.points.outroBar ?? va.grid(va.end - 8, 8, 'floor');
  ctx.outBar = Math.min(ctx.outBar, va.end - 1);
  ctx.inBar = b.points.dropBar;
  const steps = [p(0, 'in', 'fader', 0), act(0, 'in', 'play'), p(0, 'in', 'fader', 1), p(0, 'out', 'fader', 0)];
  const loud = va.mean(va.energy, ctx.outBar - 2, ctx.outBar) > -5;
  if (!ctx.instant && loud) {
    steps.push(p(-2, 'out', 'filter', 0.5, 1.75), p(-0.25, 'out', 'echo', 0.7, 0.25));
    ctx.notes.unshift('2 Takte Hochpass-Aufbau, dann harter Schnitt direkt in den Drop');
  } else if (!ctx.instant) {
    steps.push(p(-0.25, 'out', 'echo', 0.7, 0.25));
    ctx.notes.unshift('Echo auf dem letzten Beat, dann direkt in den Drop');
  } else {
    steps.push(p(0, 'out', 'echo', 0.7));
    ctx.notes.unshift('sofortiger Schnitt in den Drop, Echo-Fahne vom alten Track');
  }
  steps.push(p(0.25, 'out', 'echo', 0), act(1, 'out', 'stop'));
  return { L: 1, steps };
}

function composeEcho(ctx) {
  const { va, vb, a, b } = ctx;
  if (ctx.earliestBar !== null) ctx.outBar = va.grid(ctx.earliestBar, ctx.instant ? 1 : 4);
  else ctx.outBar = a.points.outroBar ?? va.grid(va.end - 8, 8, 'floor');
  ctx.outBar = Math.min(ctx.outBar, va.end - 1);
  ctx.inBar = b.points.startBar;
  const beatless = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 4) < 0.3;
  const start = beatless ? 0.5 : 1;
  const steps = [p(0, 'in', 'fader', 1)];
  if (ctx.instant) {
    steps.push(p(0, 'out', 'echo', 1), p(0.25, 'out', 'fader', 0, 0.25));
  } else {
    steps.push(p(-1, 'out', 'filter', 0.45, 1), p(-0.5, 'out', 'echo', 1, 0.5), p(0, 'out', 'fader', 0, 0.25));
  }
  steps.push(p(0.5, 'out', 'echo', 0), act(start, 'in', 'play'), act(1, 'out', 'stop'));
  ctx.notes.unshift(
    'alter Track verhallt im Echo',
    beatless ? 'neuer Track startet mit seinem ruhigen Intro schon unter der Echo-Fahne' : 'neuer Track startet einen Takt später in seinem eigenen Tempo',
  );
  return { L: 2, steps };
}

const COMPOSERS = {
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
    c.loop = 0.6 + (outClean < 8 ? 0.4 : 0) + (energyUp > 0.2 ? 0.2 : 0) + (loop && loop.score > 0.9 ? 0.15 : 0);
    if (outVocal && inVocal) c.vocal = 1.5 + (keyDist <= 0.15 ? 0.35 : keyDist <= 0.35 ? 0 : -0.8);
    c.filter = 0.8 + (keyDist >= 0.3 ? 0.35 : 0) + (energyUp < -0.1 ? 0.2 : 0);
    c.cut = 0.2 + (inLead < 4 ? 0.6 : 0) + (keyDist >= 0.6 ? 0.3 : 0);
    c.echo = 0.1 + (keyDist >= 0.7 ? 0.3 : 0);
  } else {
    c.echo = 2;
    if (rel.diff <= 0.12) c.cut = 0.9;
  }
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
export function planTransition({ out, inc, outRate = 1, type = 'auto', history = [], earliestBar = null, instant = false }) {
  const a = out.analysis;
  const b = inc.analysis;
  const masterBpm = a.bpm * outRate;
  const rel = tempoRelation(masterBpm, b.bpm);
  const keyDist = camelotDistance(a.key.camelot, b.key.camelot);
  const forced = type !== 'auto' && type in TRANSITIONS;
  const ctx = {
    a, b, va: new TrackView(a), vb: new TrackView(b),
    rel, keyDist, masterBpm,
    energyUp: (inc.energy ?? 0.5) - (out.energy ?? 0.5),
    earliestBar, instant,
    m: 1, notes: [], loopExt: null,
  };
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
  if (forced && chosen !== 'echo' && chosen !== 'cut' && rel.diff > FORCED_LIMIT) {
    note = `${TRANSITIONS[chosen]} geht bei diesem Tempo-Sprung nicht – Echo-Out`;
    chosen = 'echo';
  }
  const beatmatch = chosen !== 'echo' && rel.diff <= (forced ? FORCED_LIMIT : BEATMATCH_LIMIT);
  if (!beatmatch) ctx.m = 1;

  let result = COMPOSERS[chosen](ctx);
  if (!result) {
    note = `${TRANSITIONS[chosen]} passt hier nicht (kein passender Gesangsteil) – Blend`;
    chosen = 'blend';
    ctx.notes = [];
    ctx.loopExt = null;
    result = composeBlend(ctx);
  }
  const { L, steps } = result;
  const inRate = beatmatch ? (ctx.m * masterBpm) / b.bpm : 1;
  if (beatmatch && Math.abs(inRate - 1) > 0.001) {
    steps.push(act(Math.max(L, 1) + 0.5, 'in', 'rate', { to: 1, dur: 16 }));
  }
  const cleaned = instant ? steps.filter((s) => s.at >= 0) : steps;
  cleaned.sort((x, y) => x.at - y.at);
  const end = Math.max(...cleaned.filter((s) => s.action !== 'rate').map((s) => s.at + (s.dur || 0)));

  return {
    type: chosen,
    label: TRANSITIONS[chosen],
    reason: (note ? `${note} · ` : '') + describe(a, b, rel, keyDist, masterBpm),
    notes: ctx.notes,
    bars: L,
    endBars: end,
    masterBpm,
    beatmatch,
    m: ctx.m,
    inRate,
    outBar: ctx.outBar,
    inBar: ctx.inBar,
    echoBeats: masterBpm > 135 ? 0.5 : 0.75,
    steps: cleaned,
  };
}

function describe(a, b, rel, keyDist, masterBpm) {
  const parts = [`${masterBpm.toFixed(1)} → ${b.bpm.toFixed(1)} BPM`];
  if (rel.m !== 1) parts.push(rel.m === 2 ? 'Doppeltempo' : 'Halbtempo');
  parts.push(`${a.key.camelot} → ${b.key.camelot}${keyDist <= 0.15 ? ' (harmonisch)' : keyDist >= 0.6 ? ' (Tonart-Clash)' : ''}`);
  if (rel.diff > BEATMATCH_LIMIT) parts.push('Tempo zu weit für Beatmatch');
  return parts.join(' · ');
}
