// Übergangs-Composer: baut für jedes Track-Paar einen eigenen Übergang aus der Struktur beider
// Songs (Phrasen, Drums, Bass, Gesang, Wiederholungen, Energie) – wie ein DJ, der die Tracks kennt.
// Ergebnis ist eine deklarative Schrittliste (Takte relativ zu T0), die der Conductor sample-genau
// ausführt, plus Notizen, warum der Übergang so gebaut wurde.
import { BEATMATCH_LIMIT, camelotDistance, keySync, shiftCamelot, tempoRelation } from './order.js';
import { GENRES, combineProfiles, detectGenre } from './genre.js';
import { auditPlan } from './audit.js';

export const TRANSITIONS = {
  blend: 'Blend',
  chorus: 'Refrain-Wechsel',
  mashup: 'Mashup: alte Stimme, neuer Beat',
  mashin: 'Mashup: neue Stimme, alter Beat',
  roll: 'Loop-Roll',
  pingpong: 'Hin und her',
  handoff: 'Vocal-Übergabe',
  loop: 'Loop-Mix',
  vocal: 'Lyrics-Wechsel',
  filter: 'Filter-Blend',
  cut: 'Drop-Cut',
  echo: 'Echo-Out',
  build: 'Build-up & Drop',
  ramp: 'Tempo-Rampe',
  breakdown: 'Break-Übergang',
};

export const KILL = -26; // dB, EQ-"Kill"
const VOCAL_ON = 0.5;
const FORCED_LIMIT = 0.16; // max. Tempoangleichung, wenn der Nutzer eine Technik erzwingt

// ------------------------------------------------------------------ Takt-Umrechnung

/**
 * Zeit des Schlags k (ab dem ersten erkannten Schlag, auch gebrochen). Bei schwankendem Tempo
 * aus der Beat-Map (jeder Schlag einzeln erkannt), sonst aus dem festen Raster.
 */
export function beatToSeconds(a, k) {
  const m = a.beats;
  if (!m || m.length < 2) return a.firstBeat + k * a.beatInterval;
  if (k <= 0) return m[0] + k * a.beatInterval;
  if (k >= m.length - 1) return m[m.length - 1] + (k - (m.length - 1)) * a.beatInterval;
  const i = Math.floor(k);
  return m[i] + (m[i + 1] - m[i]) * (k - i);
}

/** Umkehrung: gebrochener Schlag-Index zur Zeit t. */
export function secondsToBeat(a, t) {
  const m = a.beats;
  if (!m || m.length < 2) return (t - a.firstBeat) / a.beatInterval;
  if (t <= m[0]) return (t - m[0]) / a.beatInterval;
  if (t >= m[m.length - 1]) return m.length - 1 + (t - m[m.length - 1]) / a.beatInterval;
  let lo = 0;
  let hi = m.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - m[lo]) / (m[hi] - m[lo]);
}

export function barToSeconds(a, bar) {
  return beatToSeconds(a, a.downbeat + 4 * bar);
}

export function secondsToBar(a, t) {
  return (secondsToBeat(a, t) - a.downbeat) / 4;
}

/** Tempo an einer Stelle (Takt) – bei schwankendem Tempo lokal über ±2 Takte, sonst das feste. */
export function localBpm(a, bar) {
  if (!a.beats) return a.bpm;
  const t0 = barToSeconds(a, bar - 2);
  const t1 = barToSeconds(a, bar + 2);
  return t1 > t0 ? (16 * 60) / (t1 - t0) : a.bpm;
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
  /** Gesang im Schlag k (0..3, negativ = Takt davor) von Takt `bar` – nur mit Songtext-Scan. */
  beatVocal(bar, k) {
    const v = this.a.vocalBeats?.[(this.a.downbeat || 0) + 4 * Math.floor(bar) + k];
    return v === undefined ? null : v;
  }
  get hasBeats() { return !!this.a.vocalBeats; }
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
// ab hier gilt ein Takt als "singt" (wie im Selbstcheck – sonst hört man zwei Stimmen, die der Schutz übersieht)
const VOICE = 0.35;

function vocalGuard(ctx, steps, L, sw) {
  const { va, vb, m } = ctx;
  let lastBefore = -1;
  let clashAfter = false;
  for (let t = 0; t < L; t++) {
    const ov = va.vocalSmooth(outBarAt(ctx, t));
    let iv = 0;
    for (let k = 0; k < Math.max(1, m); k++) iv = Math.max(iv, vb.vocalSmooth(ctx.inBar + t * m + k));
    if (ov >= VOICE && iv >= VOICE) {
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
      if (ov >= VOICE && iv >= VOICE) {
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
    const bar = cutPoint(ctx);
    // läuft gerade ein voller Drop: bis zu seinem Ende warten statt mitten hineinzuschneiden
    const after = afterFullEnergy(va, bar);
    if (after !== bar) ctx.notes.push(`wartet bis Takt ${after}: der alte Track ist gerade voll im Drop`);
    return after;
  }
  const outro = outroStart(va);
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
    // auf ganze 4-Takt-Gruppen, damit der Bass-Wechsel auf einer Phrasengrenze bleibt
    return avail >= 4 ? Math.floor(avail / 4) * 4 : Math.max(2, Math.floor(avail / 2) * 2);
  }
  ctx.loopExt = loop;
  steps.push(act(loop.bar - outBar, 'out', 'loop', { bars: loop.len, anchor: loop.bar - outBar }));
  ctx.notes.push(`Loop über ${loop.len} Takte (ab Takt ${loop.bar - outBar}) verlängert das Ende des alten Tracks`);
  return L;
}

/**
 * Sperrzone: läuft im Bereich [b0, b1) ein voller Hauptteil (Drop mit Drums und Energie)
 * oder ein Build-up? Dort wird nie gemixt – das zerstört den Hype.
 */
function fullEnergyInside(v, b0, b1) {
  for (let b = Math.max(0, b0); b < b1; b++) {
    if (v.label(b) === 'build') return true;
    if (v.label(b) === 'main' && v.drums(b) >= 0.55 && v.energy(b) > -4) return true;
  }
  return false;
}

/** Läuft im Bereich [b0, b1) kräftiger Gesang (z. B. Refrain)? */
function strongVocalInside(v, b0, b1) {
  for (let b = Math.max(0, b0); b < b1; b++) if (v.vocalSmooth(b) >= 0.6) return true;
  return false;
}

/** Erster Takt ab `bar` (auf dem 4er-Raster), an dem kein voller Drop mehr läuft. */
/**
 * Ab "jetzt" aussteigen (nach Sprung, "Jetzt mixen", Mix aus der Bibliothek): nie irgendwo mitten
 * in einer Phrase, sondern am nächsten natürlichen Schnittpunkt – dem Ende des laufenden Abschnitts.
 * Bei "Jetzt mixen" wird höchstens 2 Takte darauf gewartet, sonst auf die nächste 4er-Gruppe.
 */
/** Spätester Ausstieg: letzter Takt vor dem Ausklingen – oder nach der letzten Zeile, falls die später endet. */
function lastExit(va) {
  const last = va.a.points.lastBar ?? va.end - 1;
  let b = va.end - 1;
  while (b < last && !lineSafe(va, b)) b++;
  return b;
}

/** Ausstieg bei diesem Takt schneidet keine Zeile ab: in dem Takt wird nicht gesungen. */
function lineSafe(va, bar) {
  // in diesem Takt wird nicht gesungen (auch nicht leise) und im nächsten beginnt keine neue Zeile –
  // das Ausblenden dauert etwa einen Takt, sonst würde die nächste Passage angeschnitten
  if (va.vocal(bar) < 0.35 && va.vocal(bar + 1) < 0.5) return true;
  // Mit Songtext-Scan genauer: die Zeile endet vor der Eins (letzter Schlag davor frei) und die
  // nächste beginnt frühestens auf Schlag 3 – dort atmet der Song, ein Ausstieg schneidet nichts ab
  if (!va.hasBeats) return false;
  return va.beatVocal(bar, -1) < 0.3 && va.beatVocal(bar, 0) < 0.3 && va.beatVocal(bar, 1) < 0.35;
}

/**
 * Nächster Ausstieg ab `bar` (4-Takt-Raster), an dem gerade keine Zeile läuft – bis `maxLater` Takte
 * später, sonst notfalls bis 8 Takte früher; findet sich nichts, bleibt es bei `bar`.
 */
function safeExit(va, bar, maxLater = 8) {
  if (lineSafe(va, bar)) return bar;
  // bis zum echten Songende (auch ins Ausklingen): lieber den Song zu Ende singen lassen
  const last = va.a.points.lastBar ?? va.end - 1;
  // 1. nächste Phrasengrenze (4er-Raster) ohne Gesang – kurz danach, notfalls 16 Takte früher
  for (let d = 4; d <= maxLater; d += 4) if (bar + d <= last && lineSafe(va, bar + d)) return bar + d;
  for (let d = 4; d <= 16; d += 4) if (bar - d > 0 && lineSafe(va, bar - d)) return bar - d;
  // 2. Gesang bis kurz vor Schluss: auf dem Raster nach der letzten Zeile (auch im Ausklingen)
  for (let d = maxLater + 4; bar + d <= last; d += 4) if (lineSafe(va, bar + d)) return bar + d;
  // 3. notfalls der erste Takt nach der Zeile
  for (let b = bar + 1; b <= last; b++) if (lineSafe(va, b)) return b;
  return bar;
}

function cutPoint(ctx) {
  const { va } = ctx;
  const e = ctx.earliestBar;
  const limit = ctx.instant ? 2 : 16;
  // Phrasengrenze, an der gerade niemand singt (sonst wird mitten in der Zeile weggemixt)
  let firstPhrase = null;
  for (let bar = Math.ceil(e - 1e-6); bar <= e + limit && bar < va.end - 1; bar++) {
    if (!va.isPhraseStart(bar) && !(bar - Math.ceil(e) >= 4 && (((bar - (va.a.phraseOffset || 0)) % 4) + 4) % 4 === 0)) continue;
    if (lineSafe(va, bar)) return bar;
    if (firstPhrase === null && va.isPhraseStart(bar)) firstPhrase = bar;
  }
  if (firstPhrase !== null) return firstPhrase;
  if (ctx.instant) {
    const g4 = va.grid(e, 4);
    return g4 - e <= 1.5 ? g4 : va.grid(e, 1);
  }
  return va.grid(e, 4);
}

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
  const minOut = Math.max(va.grid(earliest, 4), va.grid(E * 0.45, 4), Math.min(va.grid(ctx.minExit ?? 0, 4), va.grid(E - 8, 4, 'floor')));
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
      const maxOut = ctx.latestBar !== null ? Math.min(E - 4, ctx.latestBar) : E - 4;
      for (let outBar = minOut; outBar <= maxOut; outBar += 4) {
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
        // Nie wegmischen, während der alte Track kräftigen Gesang hat (man singt mit …)
        if (strongVocalInside(va, outBar, Math.min(outEnd, E))) {
          if (!allowFull) continue;
          sc -= 2;
        }
        // … und keinen späteren Gesangsteil überspringen
        let skippedVocal = 0;
        for (let bar = outEnd; bar < E; bar++) if (va.vocalSmooth(bar) >= 0.5) skippedVocal++;
        // (bei Pop/Rap ist es normal, nach dem 2. Refrain zu gehen – dort nur leicht)
        sc -= ctx.profile?.shortForm ? Math.min(0.4, skippedVocal * 0.012) : skippedVocal * 0.08;
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
        if (ctx.profile?.shortForm) sc -= Math.min(0.4, skippedMain * 0.01);
        else if (swapDrop === undefined) sc -= skippedMain * 0.035;
        else sc -= Math.max(0, skippedMain - 16) * 0.035; // beim Drop-Swap ersetzt der neue Drop den alten
        sc -= Math.max(0, E - outEnd) * 0.001;
        sc += (ctx.tune?.exitShift ?? 0) * (outBar / E);
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

export const ENTRY_FLAVORS = { eq: 'EQ-Einstieg', lpOpen: 'Tiefpass öffnet sich', hpIn: 'dünner Hochpass-Einstieg', riser: 'Noise-Riser', flangerIn: 'Flanger-Einstieg' };
export const EXIT_FLAVORS = {
  fade: 'Ausblenden', lpOut: 'Tiefpass-Ausstieg', hpOut: 'Hochpass-Ausstieg', echoOut: 'Echo-Wurf', loopOut: 'Loop-Out',
  reverbOut: 'Hall-Fahne', flangerOut: 'Flanger-Ausstieg', gateOut: 'Stutter-Gate',
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  // Finalizer (murmur3 fmix32): sonst ändert das letzte Zeichen kaum die oberen Bits und
  // Optionen einer Gruppe bekämen fast denselben "Zufall"
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Kombiniert Effekte für Ein- und Ausstieg frei – wie ein DJ, der Filter, Hall, Echo, Flanger,
 * Gate und Riser mischt. Aus jeder Gruppe höchstens ein Baustein (nie zwei Filter oder Hall und
 * Echo gleichzeitig), "none" heißt: aus dieser Gruppe nichts. Gewichtet nach den Tracks (Energie,
 * Helligkeit, Tonart, Loopbarkeit), stabil pro Paar, mit Abwechslung gegenüber den letzten
 * Übergängen und höchstens drei Zusatz-Effekten, damit es nicht überladen klingt.
 */
function applyFlavors(ctx, steps, { L, sw, q, fadeFrom }) {
  const { va, vb, b } = ctx;
  const roll = hash(`${ctx.outId}|${ctx.inId}`); // stabil pro Paar, verschieden zwischen Paaren
  const recent = ctx.flavorHistory || [];
  const club = !ctx.profile.shortForm;
  const inDark = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 4) < 0.35; // atmosphärisches Intro
  const extra = ctx.freestyle ? 0.3 : 0; // Freestyle: mutiger kombinieren
  const tailLoop = bestLoop(va, Math.max(0, ctx.outBar + Math.floor(fadeFrom) - 4), ctx.outBar + Math.floor(fadeFrom), 1);
  const canLoopOut = !ctx.loopExt && tailLoop && loopable(va, { bar: tailLoop.bar, len: 1 }, tailLoop.bar) && L - fadeFrom >= 1;

  const groups = {
    inFilter: {
      eq: 1,
      lpOpen: 0.8 + (inDark ? 0.4 : 0) + (ctx.keyDist >= 0.3 ? 0.3 : 0),
      hpIn: 0.7 + ((b.brightness ?? -10) > -8 ? 0.2 : 0) + (ctx.energyUp > 0.1 ? 0.2 : 0),
    },
    // (Flanger klingt über Gesang schnell billig – bei Pop sparsam)
    inMod: { none: 0.6, ...(sw >= 2 ? { flangerIn: 0.45 + extra + (club ? 0.15 : -0.25) + (inDark ? 0.15 : 0) } : {}) },
    // Noise-Riser nur, wenn es danach wirklich losgeht und genug Anlauf da ist
    inTension: { none: 0.6, ...(sw >= 4 && ctx.energyUp > -0.05 ? { riser: 0.45 + extra + (ctx.energyUp > 0.1 ? 0.3 : 0) + (club ? 0.15 : -0.35) } : {}) },
    outFilter: {
      fade: 0.9,
      lpOut: 0.8 + (ctx.energyUp < -0.05 ? 0.5 : 0),
      hpOut: 0.8 + (ctx.energyUp > 0.05 ? 0.4 : 0),
    },
    outEcho: { none: 0.75, echoOut: 0.35 + extra + (ctx.energyUp > 0.25 ? 0.25 : 0) },
    outReverb: { none: 0.75, reverbOut: 0.4 + extra + (ctx.energyUp < 0 ? 0.2 : 0) + (ctx.keyDist >= 0.3 ? 0.1 : 0) },
    outMod: { none: 0.6, ...(L - fadeFrom >= 1 ? { flangerOut: 0.4 + extra + (club ? 0.15 : -0.2) } : {}) },
    outGate: { none: 0.65, ...(L - fadeFrom >= 1 && !ctx.loopExt ? { gateOut: 0.35 + extra + (club ? 0.15 : -0.1) + (ctx.energyUp > 0.1 ? 0.15 : 0) } : {}) },
    outLoop: { none: 0.65, ...(canLoopOut ? { loopOut: 0.5 + extra } : {}) },
  };
  const EXTRA_GROUPS = ['inMod', 'inTension', 'outEcho', 'outReverb', 'outMod', 'outGate', 'outLoop'];

  const used = (k) => ['in', 'out', 'x'].some((pre) => recent.includes(`${pre}:${k}`));
  const picks = {};
  for (const [g, opts] of Object.entries(groups)) {
    let best = null;
    Object.entries(opts).forEach(([k, v], i) => {
      const sc = v - (used(k) ? 0.45 : 0) + 0.6 * hash(`${roll}|${g}|${i}`);
      if (!best || sc > best.sc) best = { k, sc };
    });
    picks[g] = best;
  }
  // Kombinationen frei – aber geschmackvoll: ein Profi stapelt bei Songs mit Gesang höchstens zwei
  // Zusatz-Effekte (Club: drei, Freestyle: vier), die stärksten bleiben
  const maxExtras = (club ? 3 : 2) + (ctx.freestyle ? 1 : 0);
  const extraGroups = EXTRA_GROUPS.filter((g) => picks[g].k !== 'none');
  extraGroups.sort((x, y) => picks[y].sc - picks[x].sc).slice(maxExtras).forEach((g) => (picks[g] = { k: 'none', sc: 0 }));

  const en = picks.inFilter.k;
  const ex = picks.outFilter.k;
  const extras = EXTRA_GROUPS.map((g) => picks[g].k).filter((k) => k !== 'none');
  ctx.flavors = { entry: en, exit: ex, extras };
  const has = (k) => extras.includes(k);

  // --- Einstieg
  if (en === 'lpOpen') {
    steps.push(p(0, 'in', 'filter', -0.7), p(q * 0.5, 'in', 'filter', 0, Math.max(1, sw - q * 0.5)));
    ctx.notes.push('neuer Track öffnet sich langsam aus dem Tiefpass');
  } else if (en === 'hpIn') {
    steps.push(p(0, 'in', 'filter', 0.45), p(q, 'in', 'filter', 0, Math.max(1, sw - q)));
    ctx.notes.push('neuer Track kommt erst dünn (Hochpass) und bekommt dann Körper');
  }
  if (has('flangerIn')) {
    steps.push(p(0, 'in', 'flanger', 0.9), p(Math.max(1, sw - 2), 'in', 'flanger', 0, 2));
    ctx.notes.push('neuer Track kommt mit Flanger-Sweep rein');
  }
  if (has('riser')) {
    steps.push(act(sw - 4, 'fx', 'riser', { bars: 4, level: 0.1 }), act(sw, 'fx', 'downlifter', { bars: 2, level: 0.06 }));
    ctx.notes.push('Noise-Riser baut 4 Takte Spannung auf, beim Wechsel ein Downlifter');
  }

  // --- Ausstieg
  const fl = Math.max(0.5, L - fadeFrom + 0.5);
  if (ex === 'lpOut') {
    steps.push(p(fadeFrom - 0.5, 'out', 'filter', -0.6, fl));
    ctx.notes.push('alter Track verschwindet im Tiefpass');
  } else if (ex === 'hpOut') {
    steps.push(p(fadeFrom - 0.5, 'out', 'filter', 0.6, fl));
    ctx.notes.push('alter Track wird per Hochpass ausgedünnt');
  }
  if (has('flangerOut')) {
    steps.push(p(fadeFrom - 0.5, 'out', 'flanger', 1, Math.max(0.5, fl * 0.6)));
    ctx.notes.push('Flanger-Sweep auf dem alten Track beim Ausblenden');
  }
  if (has('gateOut')) {
    steps.push(act(L - 1, 'out', 'gate', { bars: 0.5, div: 8, depth: 0.85 }), act(L - 0.5, 'out', 'gate', { bars: 0.5, div: 16, depth: 1 }));
    ctx.notes.push('letzter Takt des alten Tracks wird rhythmisch zerhackt (Stutter-Gate)');
  }
  if (has('loopOut')) {
    const at = Math.max(Math.ceil(fadeFrom), L - 2);
    const bar = va.grid(ctx.outBar + at - 1, 1, 'floor');
    steps.push(act(at, 'out', 'loop', { bars: 1, anchor: bar - ctx.outBar }));
    ctx.notes.push('alter Track läuft auf einem 1-Takt-Loop aus');
  }
  if (has('echoOut')) {
    steps.push(p(Math.max(fadeFrom, L - 0.75), 'out', 'echo', 0.35, 0.25), p(L - 0.25, 'out', 'echo', 0, 0.25));
    ctx.notes.push('Echo-Wurf auf dem letzten Beat des alten Tracks');
  }
  if (has('reverbOut')) {
    steps.push(p(Math.max(fadeFrom, L - 1.5), 'out', 'reverb', 0.75, 1));
    ctx.notes.push('alter Track verschwindet in einer Hall-Fahne');
  }
}

/**
 * Freie Effekte für alle Techniken außer dem Blend (der hat seine eigenen Bausteine): Noise-Riser
 * in den Wechsel, Flanger auf dem Einstieg, Echo-Wurf, Hall-Fahne, Flanger oder Stutter-Gate auf
 * dem Ausstieg – frei kombiniert, zeitlich an den Wechselpunkt der Technik gehängt. Was die
 * Technik schon selbst auf einem Deck macht (z. B. ihr eigenes Echo), wird nicht überschrieben.
 */
function applyFx(ctx, steps, L) {
  const roll = hash(`${ctx.outId}|${ctx.inId}|fx`);
  const recent = ctx.flavorHistory || [];
  const club = !ctx.profile.shortForm;
  const extra = ctx.freestyle ? 0.15 : 0;
  const usesParam = (deck, param) => steps.some((s) => s.deck === deck && s.param === param);
  const usesAction = (deck, action) => steps.some((s) => s.deck === deck && s.action === action);
  const outGone = steps.filter((s) => s.deck === 'out' && s.param === 'fader' && s.to <= 0.05).map((s) => s.at + (s.dur || 0));
  const tEnd = outGone.length ? Math.min(...outGone) : L; // alter Track weg
  const swap = steps.find((s) => s.deck === 'in' && s.param === 'low' && s.to > -3);
  const play = steps.find((s) => s.deck === 'in' && s.action === 'play');
  const tIn = play ? play.at : 0;
  const tSwap = swap ? swap.at : Math.max(tIn, Math.round(tEnd));
  const minAt = Math.min(0, ...steps.map((s) => s.at));
  const chance = {
    riser: tSwap - 4 >= minAt && ctx.energyUp > -0.05 ? 0.2 + (club ? 0.15 : 0) + (ctx.energyUp > 0.1 ? 0.15 : 0) : 0,
    flangerIn: !usesParam('in', 'flanger') && tEnd - tIn >= 1 ? 0.2 + (club ? 0.05 : -0.08) : 0,
    echoOut: !usesParam('out', 'echo') && tEnd >= 1 ? 0.12 : 0,
    reverbOut: !usesParam('out', 'reverb') && tEnd >= 1 ? 0.14 + (ctx.energyUp < 0 ? 0.06 : 0) : 0,
    flangerOut: !usesParam('out', 'flanger') && tEnd >= 2 ? 0.18 + (club ? 0.07 : -0.08) : 0,
    gateOut: !usesAction('out', 'gate') && !usesAction('out', 'loop') && tEnd >= 1 ? 0.15 + (club ? 0.1 : -0.05) : 0,
  };
  let extras = [];
  for (const [k, c] of Object.entries(chance)) {
    const want = c + extra - (recent.includes(`x:${k}`) ? 0.12 : 0);
    if (c > 0 && hash(`${roll}|${k}`) < want) extras.push({ k, sc: want - hash(`${roll}|${k}`) });
  }
  // nicht überladen: bei Songs mit Gesang höchstens zwei Effekte auf einmal (die "sichersten" bleiben)
  extras = extras.sort((x, y) => y.sc - x.sc).slice(0, (club ? 3 : 2) + (ctx.freestyle ? 1 : 0)).map((x) => x.k);
  const has = (k) => extras.includes(k);
  if (has('riser')) {
    steps.push(act(tSwap - 4, 'fx', 'riser', { bars: 4, level: 0.1 }), act(tSwap, 'fx', 'downlifter', { bars: 2, level: 0.06 }));
    ctx.notes.push('Noise-Riser baut Spannung bis zum Wechsel auf, dann ein Downlifter');
  }
  if (has('flangerIn')) {
    steps.push(p(tIn, 'in', 'flanger', 0.8), p(tIn + Math.max(1, Math.min(4, tSwap - tIn - 1)), 'in', 'flanger', 0, 1.5));
    ctx.notes.push('neuer Track kommt mit Flanger-Sweep rein');
  }
  if (has('flangerOut')) {
    steps.push(p(Math.max(0, tEnd - 2), 'out', 'flanger', 0.9, 1.5));
    ctx.notes.push('Flanger-Sweep auf dem alten Track');
  }
  if (has('gateOut')) {
    steps.push(act(tEnd - 1, 'out', 'gate', { bars: 0.5, div: 8, depth: 0.8 }), act(tEnd - 0.5, 'out', 'gate', { bars: 0.5, div: 16, depth: 0.9 }));
    ctx.notes.push('letzter Takt des alten Tracks im Stutter-Gate');
  }
  if (has('echoOut')) {
    steps.push(p(tEnd - 0.75, 'out', 'echo', 0.35, 0.25), p(tEnd - 0.25, 'out', 'echo', 0, 0.25));
    ctx.notes.push('Echo-Wurf auf dem letzten Beat des alten Tracks');
  }
  if (has('reverbOut')) {
    steps.push(p(Math.max(0, tEnd - 1), 'out', 'reverb', 0.7, 0.75));
    ctx.notes.push('alter Track verschwindet in einer Hall-Fahne');
  }
  ctx.flavors = { entry: 'eq', exit: 'fade', extras };
  return steps;
}

// ------------------------------------------------------------------ Composer je Technik

/**
 * Tempo-Rampe (für Songs, deren Tempo 8–13 % auseinanderliegt – zu viel zum einfachen Angleichen):
 * Wie ein DJ am Pitch-Fader zieht der Mixer das Tempo des alten Tracks über 8 seiner Takte langsam
 * an das des neuen heran. Die Rampe ist so bemessen, dass sie genau auf einer Eins endet; dort
 * setzt der neue Track in seinem Originaltempo ein und die beiden werden normal übergeblendet.
 */
function composeRamp(ctx) {
  const { va, vb, b, rel, masterBpm } = ctx;
  if (ctx.instant || rel.m !== 1) return null;
  const r = b.bpm / masterBpm; // Zieltempo des alten Tracks (relativ)
  if (Math.abs(r - 1) <= BEATMATCH_LIMIT || Math.abs(r - 1) > 0.13) return null;
  const K = 8; // Takte des alten Tracks, über die das Tempo gleitet
  const R = (2 * K) / (1 + r); // Dauer der Rampe in Takten des Anfangstempos (linear -> endet auf der Eins)
  const L = 8; // Blend nach der Rampe (Takte im neuen Tempo)
  const A = (j) => R + j / r; // Blend-Takt j -> Zeit in Takten des Anfangstempos
  // Ende im alten Track an einer Stelle ohne Gesang, davor Rampe + Blend
  let end;
  if (ctx.earliestBar !== null) {
    // ab "jetzt": Rampe beginnt an der nächsten Phrasengrenze, Ende an einer Stelle ohne Gesang
    end = safeExit(va, va.grid(ctx.earliestBar, 4) + K + L, 16);
  } else end = safeExit(va, exitBar(ctx, L) + L);
  const start = end - L - K;
  if (start < 0 || (ctx.earliestBar !== null && start < ctx.earliestBar - 1e-6) || end > (va.a.points.lastBar ?? va.end)) return null;
  // im Blend-Teil darf der alte Track nicht singen (zwei Stimmen mit leicht anderem Tempo gehen nie gut)
  if (va.mean(va.vocal, start + K, end) >= 0.4) return null;
  const inStart = b.points.startBar ?? 0;
  ctx.outBar = start;
  ctx.inBar = Math.max(inStart, vb.grid((b.points.dropBar ?? inStart + L) - L, 4, 'floor'));
  const steps = [
    act(0, 'out', 'rate', { to: r, dur: R }),
    p(0, 'in', 'fader', 0),
    act(A(0), 'in', 'play'), p(A(0), 'in', 'low', KILL), p(A(0), 'in', 'filter', 0.35),
    p(A(0), 'in', 'fader', 0.9, A(2) - A(0)),
    p(A(2), 'in', 'filter', 0, A(4) - A(2)),
    p(A(4), 'out', 'low', KILL, 0.25), p(A(4), 'in', 'low', 0, 0.25), p(A(4) + 0.01, 'in', 'fader', 1, 1),
    p(A(6), 'out', 'fader', 0, A(L) - A(6)),
    act(A(L), 'out', 'stop'),
  ];
  const pct = Math.round((r - 1) * 100);
  ctx.notes.unshift(
    `Tempo-Rampe: der alte Track gleitet über ${K} Takte ${pct > 0 ? '+' : ''}${pct} % auf ${b.bpm.toFixed(0)} BPM`,
    'genau auf der Eins setzt der neue Track in seinem Originaltempo ein, dann ein normaler Blend',
  );
  return { L: A(L), steps };
}

/**
 * Break-Übergang (der DJ-Weg bei ganz verschiedenem Tempo): Der alte Track läuft in einen Teil ohne
 * Schlagzeug (Breakdown/Bridge/ruhiges Outro). Genau dort startet der neue und übernimmt über
 * 4 Takte – ohne Beat im alten Track hört man den Tempo-Unterschied nicht, es gibt kein Echo-Loch.
 */
function composeBreakdown(ctx) {
  const { va, vb, b } = ctx;
  if (ctx.instant) return null;
  const E = va.end;
  const from = Math.max(ctx.earliestBar ?? 0, Math.floor(E * (ctx.profile.shortForm ? 0.55 : 0.45)));
  // der letzte passende Teil ohne Drums (4 Takte), in dem nicht gesungen wird
  let bar = null;
  for (let x = va.grid(E - 4, 4, 'floor'); x >= from; x -= 4) {
    // ruhiger Teil: als Break erkannt und ohne Bass/Kick-Druck (oder deutlich leiser) – dort stört
    // ein anderes Tempo nicht
    const calm = va.label(x) !== 'main' && va.label(x + 3) !== 'main'
      && (va.mean(va.bass, x, x + 4) < -9 || va.mean(va.energy, x, x + 4) < -5);
    if (!calm && va.mean(va.drums, x, x + 4) >= 0.3) continue;
    // in keinem der Takte wird gesungen (der alte Track ist erst am Ende weg)
    let sung = false;
    for (let y = x; y <= x + 4; y++) if (va.vocal(y) >= 0.4) sung = true;
    if (sung) continue;
    if (va.mean(va.energy, x, x + 4) < -18) continue; // schon Stille/ausgeklungen
    bar = x;
    break;
  }
  if (bar === null) return null;
  ctx.outBar = bar;
  const start = b.points.startBar ?? 0;
  ctx.inBar = start;
  // neuer Track: öffnet sich aus dem Tiefpass, wird lauter; alter Track verklingt mit Hall
  // (Bass des neuen erst, wenn der alte weg ist; der alte blendet ab der Eins aus)
  const steps = [
    p(0, 'in', 'fader', 0), act(0, 'in', 'play'), p(0, 'in', 'filter', -0.6), p(0, 'in', 'low', KILL),
    p(0, 'in', 'fader', 1, 3), p(1, 'in', 'filter', 0, 3),
    p(1, 'out', 'reverb', 0.5, 1), p(0, 'out', 'fader', 0, 3.5),
    p(4, 'in', 'low', 0, 0.25),
    act(4.5, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    `Break-Übergang: im Teil ohne Schlagzeug des alten Tracks (Takt ${bar}) startet der neue`,
    'kein Beat gegen Beat – der Tempo-Unterschied fällt nicht auf',
  );
  return { L: 4.5, steps };
}

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
  // Lautstärke angleichen: leises Intro unter lautem Outro nicht untergehen lassen, lautes Intro
  // nicht hineinplatzen lassen (Energie-Werte sind schon lautheitsnormiert)
  const eOut = va.mean(va.energy, outBarAt(ctx, 0), outBarAt(ctx, 0) + Math.max(1, L / 2));
  const eIn = vb.mean(vb.energy, ctx.inBar, ctx.inBar + Math.max(1, (L * m) / 2));
  const levelDiff = Math.max(-9, Math.min(9, eOut - eIn));
  const base = inDrums > 0.4 ? 0.75 : 0.85;
  const inTarget = Math.max(0.4, Math.min(1, base * 10 ** (levelDiff / 20)));
  if (Math.abs(levelDiff) >= 3) ctx.notes.push(`Einblend-Pegel angeglichen (neues Intro ${levelDiff > 0 ? 'leiser' : 'lauter'} als das alte Outro)`);
  steps.push(p(0, 'in', 'fader', inTarget, Math.max(1, q)));
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
    const bar = safeExit(va, afterFullEnergy(va, cutPoint(ctx)));
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
    outFrom = safeExit(va, afterFullEnergy(va, cutPoint(ctx)));
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
  // Einstieg im Phrasenraster des neuen Tracks – sonst liegt der Bass-Wechsel dort neben der Eins
  if (ctx.inBar !== vb.grid(ctx.inBar, 4, 'round')) ctx.inBar = vb.grid(ctx.inBar, 4, 'ceil');
  L = extendWithLoop(ctx, steps, L);
  const down = ctx.energyUp < -0.05;
  const depth = down ? -0.7 : 0.55 + Math.min(0.25, Math.max(0, (ctx.a.brightness ?? 0) + 12) / 48);
  // Bass-Wechsel auf einer 4-Takt-Grenze (vorher landete er bei 8 Takten auf Takt 7 – mitten in der Phrase)
  const sw = L >= 16 ? L - 4 : L >= 8 ? 4 : L;

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
  if (ctx.profile.shortForm && !ctx.instant) return composeSongCut(ctx);
  if (ctx.earliestBar !== null) ctx.outBar = safeExit(va, afterFullEnergy(va, cutPoint(ctx)));
  else ctx.outBar = outroStart(va) ?? safeExit(va, va.grid(va.end - 8, 8, 'floor'));
  ctx.outBar = Math.min(ctx.outBar, lastExit(va));
  // Nur in einen echten Drop (laut, mit Beat) – nie in ein Intro oder einen leeren Beat-Teil
  const arrival = realDrop(ctx.vb, b);
  if (arrival === null && !ctx.instant) return composeEcho(ctx);
  ctx.inBar = arrival ?? b.points.dropBar;
  // Weicher als früher: der alte Track wird über 4 Takte dünner, sein letzter Schlag verhallt,
  // der neue kommt mit einem kurzen Fade statt als Schlag ins Gesicht
  // (noch weicher: der neue blendet über einen halben Takt ein, der alte verschwindet in Hall + Echo)
  const steps = [p(0, 'in', 'fader', 0), act(0, 'in', 'play'), p(0, 'in', 'fader', 1, 0.5), p(0, 'out', 'fader', 0, 0.5)];
  if (!ctx.instant) {
    steps.push(p(-4, 'out', 'filter', 0.45, 3.75), p(-2, 'out', 'low', -10, 1.75), p(-0.25, 'out', 'echo', 0.4, 0.25), p(-0.5, 'out', 'reverb', 0.5, 0.5));
    ctx.notes.unshift('4 Takte wird der alte Track dünner, sein letzter Schlag verhallt – dann der Drop des neuen');
  } else {
    ctx.notes.unshift('Wechsel auf dem Takt in den Drop');
  }
  steps.push(p(1, 'out', 'echo', 0), act(1.5, 'out', 'stop'));
  return { L: 1.5, steps };
}

/**
 * Outro-Beginn auf der nächsten 4-Takt-Grenze: die Analyse erkennt ihn manchmal ein, zwei Takte
 * daneben – ein Ausstieg dort wechselt dann mitten in der Phrase.
 */
function outroStart(va) {
  const o = va.a.points.outroBar;
  if (o === null || o === undefined) return null;
  const bar = Math.min(va.grid(o, 4, 'round'), va.grid(va.end - 1, 4, 'floor'));
  return safeExit(va, bar); // darf bis nach der letzten Zeile gehen, auch ins Ausklingen
}

/** Ausstiegs-Takt für die harten Techniken: Ende eines Refrains, sonst Outro/Phrasengrenze. */
function hardExit(ctx) {
  const { va, a } = ctx;
  const exit = chorusExit(ctx);
  if (exit) return safeExit(va, exit.bar);
  if (ctx.earliestBar !== null) return safeExit(va, afterFullEnergy(va, cutPoint(ctx)));
  return outroStart(va) ?? safeExit(va, va.grid(va.end - 8, 8, 'floor'));
}

/**
 * Build-up & Drop: der alte Track baut 8 Takte Spannung auf (Hochpass steigt, Noise-Riser,
 * Bass weg, zum Schluss Stutter-Gate und Hall) – dann fällt der neue Track direkt in seinen Drop.
 */
function composeBuild(ctx) {
  const { va, vb, b } = ctx;
  if (ctx.instant) return null;
  const arrival = realDrop(vb, b);
  if (arrival === null) return null;
  ctx.outBar = Math.min(hardExit(ctx), lastExit(va));
  ctx.inBar = arrival;
  // Anlauf: 8 Takte, bei "bald mixen" so viel, wie noch Platz ist
  const B = ctx.earliestBar !== null ? Math.max(2, Math.min(8, Math.floor(ctx.outBar - ctx.earliestBar) + 2)) : 8;
  const steps = [
    act(-B, 'fx', 'riser', { bars: B, level: 0.13 }),
    p(-B, 'out', 'filter', 0.55, B - 0.25),
    p(-2, 'out', 'low', KILL, 1),
    act(-1, 'out', 'gate', { bars: 0.5, div: 8, depth: 0.9 }),
    act(-0.5, 'out', 'gate', { bars: 0.5, div: 16, depth: 1 }),
    p(-0.5, 'out', 'reverb', 0.6, 0.5),
    p(0, 'out', 'fader', 0), act(0, 'out', 'stop'),
    p(0, 'in', 'fader', 1), act(0, 'in', 'play'),
    act(0, 'fx', 'downlifter', { bars: 2, level: 0.08 }),
  ];
  ctx.notes.unshift(
    `${B} Takte Build-up auf dem alten Track: Hochpass steigt, Noise-Riser, Bass raus`,
    'letzter Takt zerhackt (Stutter-Gate) mit Hall – dann direkt der Drop des neuen Tracks',
  );
  return { L: 1, steps };
}

/** Echter Drop des Tracks: lauter Hauptteil mit Beat (kein Intro/Beat-Loop), sonst null. */
function realDrop(v, t) {
  const drops = t.points.drops?.length ? t.points.drops : [t.points.dropBar];
  for (const d of drops) {
    if (d === undefined || d === null) continue;
    if (v.label(d) === 'main' && v.mean(v.drums, d, d + 4) >= 0.55 && v.mean(v.energy, d, d + 8) > -3) return d;
  }
  return null;
}

/**
 * Pop/Rap ohne Beatmatch (Tempo zu verschieden): am Ende eines Refrains aussteigen – der alte Track
 * verhallt auf der Eins im Echo, der neue startet sauber an seinem Anfang. Kein harter Schnitt
 * mitten in einen laufenden Beat.
 */
function composeSongCut(ctx) {
  const { vb, b } = ctx;
  const exit = chorusExit(ctx);
  if (!exit) return null;
  ctx.outBar = safeExit(ctx.va, exit.bar);
  // Hat der neue Song ein langes Intro ohne Gesang, kurz vor seiner ersten Zeile einsteigen –
  // sonst läuft minutenlang nur ein Beat ohne etwas zum Mitsingen
  const start = b.points.startBar ?? 0;
  const firstLine = b.points.vocalFirst ?? start;
  ctx.inBar = firstLine - start > 8 ? vb.grid(firstLine - 4, 4, 'floor') : start;
  // Energie halten: endet der alte Song laut (Refrain) und fängt der neue leise an, fällt die Party
  // in ein Loch – dann wie ein Profi: Echo raus und direkt in den Refrain des neuen Songs
  const eOld = ctx.va.mean(ctx.va.energy, ctx.outBar - 4, ctx.outBar);
  const eNew = vb.mean(vb.energy, ctx.inBar, ctx.inBar + 4);
  const hook = hookBar(vb, b);
  let hookIn = false;
  if (!ctx.instant && hook !== null && eOld - eNew > 5 && eOld > -4 && vb.energy(hook) > eNew + 3) {
    ctx.inBar = hook;
    hookIn = true;
  }
  const beatless = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 2) < 0.3;
  // Der neue startet genau auf der Eins (nicht einen Schlag später) und blendet kurz ein, der alte
  // verklingt über einen Takt in Echo und Hall – kein harter Schnitt, kein Loch
  const steps = [
    p(-1, 'out', 'filter', 0.3, 1), p(-0.25, 'out', 'echo', 0.55, 0.25), p(-0.5, 'out', 'reverb', 0.45, 0.5),
    p(0, 'out', 'fader', 0, 1), p(0, 'in', 'fader', 0), p(0, 'in', 'fader', 1, beatless ? 0.25 : 0.5),
    act(0, 'in', 'play'),
    p(1.5, 'out', 'echo', 0), act(2, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    `Ausstieg nach dem Refrain (Takt ${exit.bar})${ctx.rel.diff > BEATMATCH_LIMIT ? ' – Tempo zu verschieden zum Angleichen' : ' – sauberer Schnitt statt langer Überblendung (beide Songs singen fast durchgehend)'}`,
    hookIn
      ? `alter Track verhallt auf der Eins im Echo, der neue springt direkt in seinen Refrain (Takt ${ctx.inBar}) – kein Energieloch`
      : 'alter Track verhallt auf der Eins im Echo, der neue startet sauber an seinem Anfang',
  );
  return { L: 2, steps };
}

function composeEcho(ctx) {
  const { va, vb, a, b } = ctx;
  if (ctx.profile.shortForm && !ctx.instant && ctx.earliestBar === null) {
    const r = composeSongCut(ctx);
    if (r) return r;
  }
  if (ctx.earliestBar !== null) ctx.outBar = safeExit(va, afterFullEnergy(va, cutPoint(ctx)));
  else ctx.outBar = outroStart(va) ?? safeExit(va, va.grid(va.end - 8, 8, 'floor'));
  ctx.outBar = Math.min(ctx.outBar, lastExit(va));
  ctx.inBar = b.points.startBar;
  const beatless = vb.mean(vb.drums, ctx.inBar, ctx.inBar + 4) < 0.3;
  const start = beatless ? 0.5 : 1;
  const steps = [];
  if (ctx.instant) {
    steps.push(p(0, 'out', 'echo', 0.5), p(0.25, 'out', 'fader', 0, 0.25));
  } else {
    steps.push(p(-1, 'out', 'filter', 0.45, 1), p(-0.5, 'out', 'echo', 0.5, 0.5), p(-0.5, 'out', 'reverb', 0.45, 0.5), p(0, 'out', 'fader', 0, 0.5));
  }
  // Neuer Track blendet kurz ein statt hart einzusetzen
  steps.push(p(0, 'in', 'fader', 0), p(start, 'in', 'fader', 1, 0.25));
  steps.push(p(0.5, 'out', 'echo', 0), act(start, 'in', 'play'), act(1, 'out', 'stop'));
  ctx.notes.unshift(
    'alter Track verhallt im Echo',
    beatless ? 'neuer Track startet mit seinem ruhigen Intro schon unter der Echo-Fahne' : 'neuer Track startet einen Takt später in seinem eigenen Tempo',
  );
  return { L: 2, steps };
}

/**
 * Refrain-Wechsel (Pop/Rap, wie im Open-Format-DJing üblich): Der alte Track spielt bis zum Ende
 * eines Refrains – nach gut der Hälfte des Songs, nicht bis zum letzten Ton. Der neue Track startet
 * an seinem Anfang, sein Intro läuft ohne Bass leise unter den letzten Takten des Refrains. Genau
 * auf der Phrasengrenze nach dem Refrain wird umgeschaltet (Bass-Wechsel, kurzer Echo-Schweif auf
 * dem Beat), und die erste Strophe des neuen Tracks übernimmt. Nie zwei Stimmen gleichzeitig.
 */
function chorusExit(ctx) {
  const { va } = ctx;
  const E = va.end;
  const from = ctx.earliestBar !== null ? va.grid(ctx.earliestBar + (ctx.instant ? 0 : 4), 4) : va.grid(Math.max(E * 0.4, Math.min(ctx.minExit ?? 0, E * 0.8)), 4);
  // Nicht bis ins leere Ende: spätestens, solange noch Musik/Gesang da ist
  const vocalEnd = (va.a.points.vocalLast ?? E) + 1;
  // (Gesangserkennung verpasst manchmal späte Zeilen/Samples – bis 80 % darf es immer gehen)
  const last = Math.min(E - 4, Math.max(from, vocalEnd, Math.floor(E * 0.8)));
  let best = null;
  for (let bar = from; bar <= last; bar += 4) {
    if (!va.isPhraseStart(bar) && bar % 8 !== (va.a.phraseOffset ?? 0) % 8) continue;
    const before = va.mean(va.vocalSmooth, bar - 8, bar);
    const eBefore = va.mean(va.energy, bar - 8, bar);
    const eAfter = va.mean(va.energy, bar, bar + 8);
    let sc = 0;
    sc += before >= 0.5 ? 0.6 : before * 0.6; // davor wurde gesungen (Refrain/Hook)
    sc += Math.max(-0.3, Math.min(0.6, (eBefore - eAfter) * 0.2)); // danach wird es ruhiger (Strophe/Bridge)
    sc += eBefore > -3 ? 0.3 : 0; // der Teil davor war ein lauter Höhepunkt
    if (va.label(bar) !== va.label(bar - 1)) sc += 0.2;
    // Gesangszeile läuft genau über die Grenze -> Zeile würde abgeschnitten
    if (va.vocalSmooth(bar - 1) >= 0.6 && va.vocalSmooth(bar) >= 0.6 && va.vocal(bar) > va.vocal(bar - 1) + 0.15) sc -= 0.3;
    // im Ausstiegstakt wird gesungen -> die Zeile würde weggemixt, während die Leute mitsingen
    if (!lineSafe(va, bar)) sc -= 1.5;
    // Wo es musikalisch passt – kein fester Prozentwert. Nur: nicht zu früh (weniger als die
    // Hälfte gespielt) und nicht ins ausklingende Ende, wo nur noch Leerlauf käme.
    const frac = bar / E;
    // Pop/Rap auf der Party: frühestens nach dem zweiten Refrain (~60 %) – nach dem ersten Refrain
    // raus klingt, als würde der Song abgewürgt
    const minFrac = ctx.profile.shortForm ? 0.58 : 0.5;
    if (frac < minFrac && ctx.earliestBar === null) sc -= (minFrac - frac) * (ctx.profile.shortForm ? 8 : 2);
    // danach nur noch Leerlauf? Für einen kurzen Refrain-Wechsel reichen ein paar Takte Outro
    const tail = E - bar;
    if (tail <= 4) sc -= 0.6;
    else if (tail <= 8) sc -= 0.2;
    if (bar >= vocalEnd - 2) sc -= 0.3;
    sc -= 0.05 * frac; // bei Gleichstand lieber den früheren passenden Refrain-Schluss
    sc += ctx.tune.exitShift * frac; // gelernt: "zu früh" -> später, "zu spät" -> früher
    if (!best || sc > best.sc) best = { bar, sc };
  }
  return best;
}

function composeChorus(ctx) {
  const { va, vb, b, m } = ctx;
  const exit = chorusExit(ctx);
  if (!exit) return null;
  // Intro des neuen Tracks bis zu seiner ersten Stimme (bzw. seinem Einstieg), höchstens 8 Takte
  const start = b.points.startBar ?? 0;
  // erste Stimme oder erster Hauptteil – was zuerst kommt (Gesangserkennung kann spät anschlagen)
  const first = Math.min(b.points.vocalFirst ?? Infinity, b.points.dropBar ?? Infinity, start + 16);
  const introBars = Math.max(0, Math.floor((first - start) / m));
  let pre = ctx.instant ? 0 : Math.min(8, introBars >= 4 ? 4 * Math.floor(Math.min(introBars, 8) / 4) : introBars >= 2 ? introBars : 0);
  // Der Wechsel muss auch im neuen Track auf einer Phrasengrenze liegen (sonst kippt er dort
  // mitten in einen Abschnitt): Vorlauf auf dessen 4er-Raster ausrichten
  if (pre > 0) {
    const offB = b.phraseOffset || 0;
    const grid = (bar) => ((((bar - offB) % 4) + 4) % 4) === 0;
    let best = null;
    for (let k = 1; k <= 8; k++) {
      if (!grid(start + k * m)) continue;
      if (best === null || Math.abs(k - pre) < Math.abs(best - pre)) best = k;
    }
    if (best !== null) pre = best;
  }
  // Einstieg frei wie ein DJ: meist am Anfang des neuen Songs – soll die Energie hoch (oder zur
  // Abwechslung), direkt in seinen Refrain/Hook. Dann läuft der Takt davor ohne Gesang/Bass an.
  const hook = hookBar(vb, b);
  const dice = hash(`${ctx.outId}|${ctx.inId}|entry`);
  if (!ctx.instant && hook !== null && (ctx.energyUp > 0.08 || dice < 0.35)) {
    const hp = 4;
    ctx.outBar = exit.bar - hp;
    ctx.inBar = Math.max(start, Math.round(hook - hp * m));
    return chorusSteps(ctx, exit, hp, `neuer Track steigt direkt vor seinem Refrain ein (Takt ${hook}) – der Hook kommt genau beim Wechsel`);
  }
  ctx.outBar = exit.bar - pre;
  ctx.inBar = start;
  return chorusSteps(ctx, exit, pre, pre > 0
    ? `neuer Track startet am Anfang, sein Intro läuft ${pre} Takte ohne Bass unter dem Refrain`
    : 'neuer Track startet direkt mit seiner ersten Zeile');
}

/** Erster Refrain/Hook eines Tracks: lauter Hauptteil mit Gesang, nicht ganz am Anfang. */
function hookBar(v, t) {
  const start = t.points.startBar ?? 0;
  for (const ph of t.phrases) {
    if (ph.bar < start + 8 || ph.bar > v.end * 0.6) continue;
    if (ph.label === 'main' && ph.vocal >= 0.4 && ph.energy > -3) return ph.bar;
  }
  return null;
}

function chorusSteps(ctx, exit, pre, entryNote) {
  const { va } = ctx;
  const steps = [];
  if (pre > 0) {
    steps.push(p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'vocal', 1));
    steps.push(act(0, 'in', 'play'));
    // Tonarten beißen sich: vom neuen Intro nur Beat/Hi-Hats (Hochpass) unter dem Refrain – keine
    // Akkorde gegen Akkorde. Die Harmonie kommt erst mit dem Wechsel.
    const clash = ctx.keyDist >= 0.5;
    steps.push(p(0, 'in', 'fader', clash ? 0.65 : 0.8, Math.max(1, pre - 0.5)));
    if (clash) {
      steps.push(p(0, 'in', 'filter', 0.55), p(pre - 0.1, 'in', 'filter', 0, 0.1));
      ctx.notes.push('Tonarten passen nicht: vom neuen Intro vorher nur Beat und Hi-Hats, die Harmonie erst beim Wechsel');
    }
    // alter Refrain wird zum Ende etwas schlanker, damit das neue Intro Platz hat
    steps.push(p(Math.max(0, pre - 2), 'out', 'low', -8, 2));
  } else {
    steps.push(p(0, 'in', 'fader', 1), act(0, 'in', 'play'));
  }
  // Umschalten genau auf der Eins nach dem Refrain
  steps.push(p(pre - 0.25, 'out', 'echo', 0.35, 0.25));
  steps.push(p(pre, 'out', 'fader', 0, 0.5), p(pre, 'out', 'low', KILL, 0.1));
  steps.push(p(pre, 'in', 'low', 0, 0.1), p(pre, 'in', 'vocal', 0, 0.1), p(pre, 'in', 'fader', 1, 0.1));
  steps.push(p(pre + 1, 'out', 'echo', 0), act(pre + 1.5, 'out', 'stop'));
  ctx.notes.unshift(
    `Ausstieg nach dem Refrain (Takt ${exit.bar} von ${va.end}), nicht erst am Songende`,
    entryNote,
    'auf der Eins: Bass-Wechsel + kurzer Echo-Schweif, der neue Track übernimmt',
  );
  return { L: pre + 1.5, steps };
}

/** Instrumentaler Abschnitt mit Beat (Intro/Break) im Track: Start-Takt oder null. */
function beatWithoutVocal(v, from, to, len) {
  for (let bar = v.grid(from, 4); bar + len <= to; bar += 4) {
    if (v.mean(v.vocalSmooth, bar, bar + len) < 0.3 && v.mean(v.drums, bar, bar + len) >= 0.45) return bar;
  }
  return null;
}

/**
 * Mashup: Die Stimme des alten Tracks läuft fast a cappella (Kick/Bass weggefiltert) über dem
 * instrumentalen Beat des neuen Tracks – wie ein Live-Edit. Danach übernimmt der neue ganz.
 */
function composeMashup(ctx) {
  const { va, vb, b, m } = ctx;
  if (ctx.keyDist > 0.35 || ctx.instant) return null;
  const U = 8;
  const runs = va.vocalRuns(8).filter((r) => r.from >= va.end * 0.45 && r.from >= (ctx.earliestBar ?? 0));
  if (!runs.length) return null;
  const inst = beatWithoutVocal(vb, b.points.startBar ?? 0, (b.points.vocalFirst ?? vb.end) + 2, U * m);
  if (inst === null) return null;
  // der Drop des neuen Tracks darf das Mashup nicht mittendrin abschneiden (sonst Wechsel neben der Eins)
  const nextDrop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > inst);
  if (nextDrop !== undefined && (nextDrop - inst) / m < U) return null;
  ctx.outBar = va.grid(runs[0].from, 4, 'floor');
  ctx.inBar = inst;
  const steps = [
    p(0, 'in', 'fader', 0), p(0, 'in', 'vocal', 1), act(0, 'in', 'play'),
    p(0, 'in', 'fader', 1, 1),
    // alter Track: Beat und Bass raus, nur noch Stimme/Mitten
    p(0, 'out', 'low', KILL, 1), p(0, 'out', 'filter', 0.45, 1), p(0, 'out', 'high', -4, 1),
    p(U - 0.5, 'out', 'echo', 0.3, 0.5), p(U, 'out', 'fader', 0, 1), p(U, 'in', 'vocal', 0, 1),
    p(U + 1, 'out', 'echo', 0), act(U + 1.5, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    `Mashup: ${U} Takte singt der alte Track über den Beat des neuen`,
    'Kick und Bass des alten Tracks sind weggefiltert – nur seine Stimme bleibt',
  );
  return { L: U + 1.5, steps };
}

/**
 * Mashup andersrum: Die erste Zeile des neuen Tracks (nur Stimme, gefiltert) läuft über den Beat des
 * alten; erst danach kippt der Beat zum neuen Track.
 */
function composeMashIn(ctx) {
  const { va, vb, b, m } = ctx;
  if (ctx.keyDist > 0.35 || ctx.instant) return null;
  const inRun = vb.vocalRuns(4)[0];
  if (!inRun) return null;
  const inBar = vb.grid(inRun.from, 4, 'floor');
  const drop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > inBar);
  const U = Math.min(8, drop !== undefined ? Math.floor((drop - inBar) / m / 4) * 4 : 8);
  if (U < 4) return null;
  const from = Math.max(va.grid(va.end * 0.5, 4), ctx.earliestBar !== null ? va.grid(ctx.earliestBar + 4, 4) : 0);
  // alter Track: Beat ohne (oder mit wenig) Gesang – sonst singen zwei
  const outBar = beatWithoutVocal(va, from, va.end - 4, U + 1);
  if (outBar === null) return null;
  ctx.outBar = outBar;
  ctx.inBar = inBar;
  const steps = [
    p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'filter', 0.45),
    act(0, 'in', 'play'), p(0, 'in', 'fader', 0.9, 0.5), p(0, 'out', 'vocal', 1, 0.5),
    // Beat kippt: Bass/Kick des neuen rein, alter raus
    p(U - 0.25, 'out', 'echo', 0.25, 0.25), p(U, 'out', 'fader', 0, 0.5), p(U, 'out', 'low', KILL, 0.1),
    p(U, 'in', 'filter', 0, 0.1), p(U, 'in', 'low', 0, 0.1), p(U, 'in', 'fader', 1, 0.1),
    p(U + 1, 'out', 'echo', 0), act(U + 1.5, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    `Mashup: die ersten ${U} Takte singt der neue Track über den Beat des alten`,
    `bei Takt ${U} kippt der Beat zum neuen Track`,
  );
  return { L: U + 1.5, steps };
}

/**
 * Loop-Roll (für Mutige): Der letzte Takt vor dem Wechsel wird immer schneller wiederholt
 * (1/4 -> 1/8 -> 1/16), der Hochpass zieht hoch – und auf der Eins schlägt der neue Track mit
 * seinem Hook oder Drop ein.
 */
function composeRoll(ctx) {
  const { va, vb, b } = ctx;
  // Ein Roll klingt nur gekonnt, wenn das Grid sitzt, der alte Track an der Stelle einen klaren
  // Beat hat und der neue in einen echten Drop einschlägt – sonst lieber etwas anderes.
  if (Math.min(ctx.a.gridConfidence ?? 1, b.gridConfidence ?? 1) < 0.6) return null;
  const drop = b.points.dropBar;
  if (drop === undefined || vb.mean(vb.drums, drop, drop + 4) < 0.55) return null;
  let exitBar;
  if (ctx.instant) exitBar = va.grid(ctx.earliestBar + 2, 1);
  else {
    // Ende eines Builds/Hauptteils im alten Track – dort, wo ohnehin etwas "ankommen" will
    const cands = [];
    for (let bar = va.grid(Math.max(va.end * 0.5, (ctx.earliestBar ?? 0) + 4), 8); bar <= va.end - 4; bar += 4) {
      if (!va.isPhraseStart(bar)) continue;
      const kick = va.mean(va.drums, bar - 2, bar);
      if (kick < 0.5) continue;
      const lab = va.label(bar - 1);
      cands.push({ bar, sc: kick + (lab === 'build' ? 0.8 : lab === 'main' ? 0.3 : 0) - (va.vocalSmooth(bar - 1) >= 0.6 ? 0.5 : 0) });
    }
    cands.sort((x, y) => y.sc - x.sc);
    if (!cands.length) return null;
    exitBar = cands[0].bar;
  }
  // Zwei Takte: Viertel -> Achtel -> Sechzehntel -> Zweiunddreißigstel, immer ab der Eins des
  // vorletzten Takts (ein Ankerpunkt = nahtlos, nichts springt), Hochpass zieht langsam hoch.
  ctx.outBar = exitBar - 2;
  ctx.inBar = drop;
  const steps = [
    act(0, 'out', 'loop', { bars: 0.25, anchor: 0 }),
    act(1, 'out', 'loop', { bars: 0.125, anchor: 0 }),
    act(1.5, 'out', 'loop', { bars: 0.0625, anchor: 0 }),
    act(1.75, 'out', 'loop', { bars: 0.03125, anchor: 0 }),
    p(0, 'out', 'filter', 0.5, 2), p(1, 'out', 'low', KILL, 1), p(0, 'out', 'fader', 0.85, 2),
    p(1.875, 'out', 'echo', 0.3, 0.125),
    p(2, 'out', 'fader', 0), p(2, 'in', 'fader', 1), act(2, 'in', 'play'),
    p(2.5, 'out', 'echo', 0), act(3, 'out', 'stop'),
  ];
  ctx.notes.unshift('Loop-Roll über 2 Takte: der Beat wird immer dichter wiederholt, der Filter zieht hoch', `auf der Eins schlägt der neue Track in seinen Drop ein (Takt ${drop})`);
  return { L: 2.25, steps };
}

/**
 * Hin und her (Freestyle): Beide Tracks laufen im Takt, der Groove springt alle 4 Takte zwischen
 * ihnen hin und her – Bass und Stimme wechseln die Seite, bis der neue Track endgültig übernimmt.
 */
function composePingPong(ctx) {
  const { va, vb, b, m } = ctx;
  if (ctx.keyDist > 0.35 || ctx.instant) return null;
  // Pop/Rap kürzer (8 Takte), Clubmusik 16 – sonst läuft der alte Track zu weit in den nächsten Teil
  const U = ctx.profile.shortForm ? 2 : 4;
  const L = 4 * U;
  const end = L + 1.5; // bis der alte Track ganz weg ist
  // Wunschstelle: Pop/Rap nach einem Refrain, Clubmusik dort, wo sonst das Outro gemischt würde
  const exit = ctx.profile.shortForm ? chorusExit(ctx) : null;
  const clubEnd = Math.min(va.end - 2, (outroStart(va) ?? va.end - 8) + 8);
  const target = exit ? exit.bar - L : va.grid(clubEnd - L, 4, 'floor');
  const minBar = ctx.earliestBar !== null ? va.grid(ctx.earliestBar + 4, 4) : 0;
  // Fenster suchen, in dem der alte Track im selben Teil bleibt: kein neuer Abschnitt, keine neue
  // Gesangszeile, solange er noch hörbar ist, und das Ende in einem Takt ohne Gesang
  let best = null;
  for (let bar = va.grid(target - 16, 4); bar <= target + 8; bar += 4) {
    if (bar < minBar || bar + end > va.end || va.mean(va.drums, bar, bar + L) < 0.35) continue;
    let sc = -Math.abs(bar - target) * 0.03;
    for (let x = bar + 1; x < bar + end; x++) {
      if (va.label(x) !== va.label(x - 1)) sc -= va.label(x) === 'main' ? 3 : 1;
      if (va.vocal(x) >= 0.5 && va.vocal(x - 1) < 0.35) sc -= 3;
    }
    if (!lineSafe(va, bar + L)) sc -= 1.5;
    if (!best || sc > best.sc) best = { bar, sc };
  }
  if (!best || best.sc < -2.5) return null; // kein ruhiges Fenster -> andere Technik
  const outBar = best.bar;
  const start = b.points.startBar ?? 0;
  const inBar = vb.mean(vb.drums, start, start + L * m) >= 0.35 ? start : beatWithoutVocal(vb, start, vb.end - L, L * m) ?? start;
  ctx.outBar = outBar;
  ctx.inBar = inBar;
  // Beim Zurückspringen den Gesang des alten Tracks nur zurückholen, wenn dort gerade keiner
  // singt – sonst käme eine Zeile zurück, die gleich wieder verschwindet
  const backVocal = va.mean(va.vocal, outBar + 2 * U, outBar + 3 * U) >= 0.4 ? 1 : 0;
  const steps = [
    p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), act(0, 'in', 'play'), p(0, 'in', 'fader', 0.85, 1),
    // 1: neuer Groove übernimmt
    p(U, 'out', 'low', KILL, 0.1), p(U, 'in', 'low', 0, 0.1), p(U, 'out', 'vocal', 1, 0.25),
    // 2: zurück zum alten – der neue wird dünn gefiltert
    p(2 * U, 'in', 'low', KILL, 0.1), p(2 * U, 'out', 'low', 0, 0.1), p(2 * U, 'out', 'vocal', backVocal, 0.25),
    p(2 * U, 'in', 'filter', 0.3, 0.5),
    // 3: endgültig zum neuen
    p(3 * U, 'in', 'filter', 0, 0.1), p(3 * U, 'in', 'low', 0, 0.1), p(3 * U, 'in', 'fader', 1, 0.1),
    p(3 * U, 'out', 'low', KILL, 0.1), p(3 * U, 'out', 'vocal', 1, 0.25),
    p(L - 2, 'out', 'high', -10, 2), p(L - 2, 'out', 'fader', 0, 2), p(L - 0.25, 'out', 'echo', 0.3, 0.25),
    p(L + 1, 'out', 'echo', 0), act(L + 1.5, 'out', 'stop'),
  ];
  ctx.notes.unshift(
    `Hin und her: der Groove springt alle ${U} Takte zwischen beiden Tracks`,
    `ab Takt ${3 * U} gehört er endgültig dem neuen Track`,
    ...(backVocal ? ['beim Zurückspringen bleibt der alte Gesang weg (sonst käme eine Zeile nur kurz zurück)'] : []),
  );
  return { L: end, steps };
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
    // Bass des neuen Tracks ab der Eins der Phrase (über einen Takt hochgezogen)
    p(0, 'in', 'low', 0, 1),
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

const COMPOSERS = {
  chorus: composeChorus,
  mashup: composeMashup,
  mashin: composeMashIn,
  roll: composeRoll,
  pingpong: composePingPong,
  handoff: composeHandoff,
  blend: composeBlend,
  loop: composeLoop,
  vocal: composeVocal,
  filter: composeFilter,
  cut: composeCut,
  echo: composeEcho,
  build: composeBuild,
  ramp: composeRamp,
  breakdown: composeBreakdown,
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
    const dropOk = realDrop(vb, b) !== null;
    if (dropOk) c.cut = 0.1 + (inLead < 4 ? 0.4 : 0) + (keyDist >= 0.6 ? 0.3 : 0);
    c.echo = 0.05;
    const outLines = va.vocalRuns(4).some((r) => r.to >= va.end * 0.5);
    const inLines = vb.vocalRuns(4).length > 0;
    if (outLines && inLines) c.handoff = 1.25 + (keyDist <= 0.35 ? 0.2 : -0.4);
    // Refrain-Wechsel: bei Songs mit durchgehendem Gesang (Pop/Rap) der natürliche DJ-Weg
    const vocalHeavy = va.mean(va.vocalSmooth, Math.floor(va.end * 0.4), va.end) >= 0.45;
    if (outVocal) c.chorus = 0.9 + (vocalHeavy ? 0.5 : 0) + (outClean < 8 ? 0.3 : 0);
    // Freie DJ-Techniken: Stimme über fremdem Beat nur, wenn die Tonarten passen
    if (keyDist <= 0.35 && outVocal) c.mashup = 1.0 + (keyDist <= 0.15 ? 0.25 : 0);
    if (keyDist <= 0.35 && inVocal) c.mashin = 0.9 + (keyDist <= 0.15 ? 0.25 : 0);
    if (!ctx.profile.shortForm) c.roll = 0.6 + (energyUp > 0.1 ? 0.25 : 0);
    // Build-up & Drop: wenn der neue Track einen echten Drop hat und es energetisch nach oben geht
    if (dropOk && !ctx.profile.shortForm) c.build = 0.5 + (energyUp > 0.1 ? 0.35 : 0) + (inLead < 8 ? 0.2 : 0);
  } else {
    // Tempo-Rampe: der DJ-Weg für 8–13 % Unterschied (statt Echo-Schnitt)
    if (rel.m === 1 && rel.diff <= 0.13) c.ramp = ctx.profile.shortForm ? 2.7 : 1.8;
    // Break-Übergang: im Teil ohne Drums wechseln – klingt natürlicher als ein Echo-Schnitt
    c.breakdown = ctx.profile.shortForm ? 2.75 : 1.7;
    // ohne Beatmatch: Cut nur in einen echten Drop, sonst sauber per Echo
    if (realDrop(vb, b) !== null) c.cut = rel.diff <= 0.2 ? 1.6 : 1.0;
    c.echo = rel.diff <= 0.2 ? 1.2 : 1.5;
    if (ctx.profile.shortForm) c.echo = 2.6; // sauber verhallen statt hart in einen Beat schneiden
  }
  for (const k of Object.keys(c)) c[k] += ctx.profile.styles[k] ?? 0;
  // freier: auch ohne Freestyle pro Songpaar etwas Zufall, damit nicht immer dieselbe Technik gewinnt
  if (!ctx.freestyle) for (const k of Object.keys(c)) c[k] += 0.35 * hash(`${ctx.outId}|${ctx.inId}|${k}|var`);
  if (ctx.freestyle && tempoOk) {
    // Freestyle: wilder, verspielter, mehr Abwechslung – aber nie gegen die Tonart
    // (der brave Standard-Blend tritt zurück, damit die freien Techniken wirklich zum Zug kommen)
    const boost = { blend: -0.8, filter: -0.2, mashup: 0.7, mashin: 0.7, roll: 0.4, loop: 0.5, handoff: 0.35, vocal: 0.3, chorus: -0.1, build: 0.3 };
    for (const [k, v] of Object.entries(boost)) if (k in c) c[k] += v;
    if (keyDist <= 0.35) c.pingpong = 1.9;
    for (const k of Object.keys(c)) c[k] += 1.0 * hash(`${ctx.outId}|${ctx.inId}|${k}|free`);
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
/**
 * Mindest-Spielzeit: Ein Song, der gerade erst übernommen hat (z. B. direkt in seinen Refrain),
 * wird nicht nach einer halben Minute wieder weggemixt – mindestens ~80 s (Club: ~100 s) ab dem
 * Einstieg. Gilt nicht bei "Jetzt mixen"/Sprüngen (earliestBar) und nie über das Songende hinaus.
 */
function minExitBar(ctx, entryBar) {
  if (ctx.earliestBar !== null) return null;
  const { a, va } = ctx;
  const entry = entryBar ?? a.points.startBar ?? 0;
  const barSec = 4 * (a.beatInterval || 60 / a.bpm);
  const bars = Math.min((ctx.profile.shortForm ? 80 : 100) / barSec, (va.end - entry) * 0.5);
  return Math.min(entry + bars, va.end * 0.8);
}

/** Allgemeine Stellschrauben + die für den laufenden Song (z. B. "bei diesem Song zu früh"). */
function mergeTune(g, t) {
  const base = { lengthScale: 1, exitShift: 0, hardness: 0, ...(g || {}) };
  if (!t) return base;
  return {
    lengthScale: Math.max(0.5, Math.min(1.6, base.lengthScale * t.lengthScale)),
    exitShift: Math.max(-1, Math.min(1, base.exitShift + t.exitShift)),
    hardness: Math.max(base.hardness, t.hardness),
  };
}

/**
 * Plant mehrere Varianten (die bestbewerteten Techniken), prüft jede im Selbstcheck (zwei Stimmen,
 * zwei Basslines, Lautstärke-Loch, Wechsel neben der Eins, abgeschnittene Zeile) und nimmt die
 * beste. Erzwungene Techniken und "Jetzt mixen" werden nur geprüft, nicht ersetzt.
 */
function addEarlyPenalty(plan, opts, va) {
  if (!plan.minExit || plan.outBar >= plan.minExit - 0.5) return;
  const early = plan.minExit - plan.outBar;
  plan.audit.penalty += Math.min(3, early * 0.08);
  plan.audit.issues.push('Song würde zu kurz gespielt');
}

export function planTransition(opts) {
  const first = planSingle(opts);
  const va = new TrackView(opts.out.analysis);
  const vb = new TrackView(opts.inc.analysis);
  first.audit = auditPlan(first, va, vb);
  addEarlyPenalty(first, opts, va);
  const forced = opts.type && opts.type !== 'auto' && opts.type in TRANSITIONS;
  let best = first;
  if (!forced && !opts.instant && first.ranked) {
    let bestTotal = first.score - first.audit.penalty;
    const tried = new Set([first.type]);
    let usable = 1;
    let attempts = 0;
    for (const [k] of first.ranked) {
      // bis zu 3 echte Alternativen; Techniken, die hier gar nicht passen, zählen nicht mit
      if (usable >= 4 || attempts >= 10) break;
      if (tried.has(k)) continue;
      tried.add(k);
      attempts++;
      const alt = planSingle(opts, k);
      if (alt.type !== k) continue; // Technik passte nicht (Rückfall auf Blend)
      usable++;
      alt.audit = auditPlan(alt, va, vb);
      addEarlyPenalty(alt, opts, va);
      const total = alt.score - alt.audit.penalty;
      if (total > bestTotal + 0.05) {
        best = alt;
        bestTotal = total;
      }
    }
    // Mitsingen hat Vorrang: schneidet der Beste eine Zeile ab, alle Techniken durchprobieren
    if (best.audit.lineCut) {
      let clean = null;
      for (const [k] of first.ranked) {
        if (k === best.type) continue;
        const alt = planSingle(opts, k);
        if (alt.type !== k) continue;
        alt.audit = auditPlan(alt, va, vb);
        addEarlyPenalty(alt, opts, va);
        if (alt.audit.lineCut) continue;
        const total = alt.score - alt.audit.penalty;
        if (!clean || total > clean.total) clean = { plan: alt, total };
      }
      // notfalls: Echo-Out am Ende des Gesangsblocks (der Ausstieg wartet, bis die Zeile vorbei ist)
      if (!clean) {
        const echo = planSingle({ ...opts, type: 'echo' });
        echo.audit = auditPlan(echo, va, vb);
        if (!echo.audit.lineCut) clean = { plan: echo };
      }
      if (clean) {
        clean.plan.notes.push(`Selbstcheck: statt ${TRANSITIONS[best.type]} – die hätte eine Gesangszeile abgeschnitten`);
        best = clean.plan;
      }
    }
    if (best !== first && !best.notes.some((n) => n.startsWith('Selbstcheck: statt'))) {
      best.notes.push(`Selbstcheck: statt ${TRANSITIONS[first.type]} (${first.audit.issues.join(', ') || 'knapp schlechter'})`);
    }
  }
  if (best.audit.issues.length) best.notes.push(`Selbstcheck: ${best.audit.issues.join(', ')}`);
  return best;
}

function planSingle({ out, inc, outRate = 1, type = 'auto', history = [], earliestBar = null, latestBar = null, entryBar = null, instant = false, flavorHistory = [], outKeyShift = 0, freestyle = false, keylock = true, bias = null, tune = null, trackTune = null }, pick = null) {
  const a = out.analysis;
  const b = inc.analysis;
  const masterBpm = a.bpm * outRate;
  const rel = tempoRelation(masterBpm, b.bpm);
  // Key-Sync: neuen Track notfalls um bis zu ±2 Halbtöne verschieben, damit beide harmonisch passen
  const outKey = shiftCamelot(a.key.camelot, outKeyShift);
  // Key-Sync verschiebt den ganzen Song – nur mit Keylock möglich, und Stimmen klingen schon bei
  // 2 Halbtönen unnatürlich (zu tief/Mickey-Mouse): bei Gesang höchstens 1 Halbton
  const vocalIn = b.vocals?.length ? Array.from(b.vocals).reduce((x, v) => x + v, 0) / b.vocals.length : 0;
  let ks = keySync(outKey, b.key.camelot, keylock && (b.key.confidence ?? 1) > 0.15 && (a.key.confidence ?? 1) > 0.15);
  // Stimmen klingen schon bei einem Halbton hörbar "falsch" – und die Verschiebung gilt für den
  // ganzen Song. Key-Sync deshalb nur noch bei (fast) instrumentalen Tracks.
  if (vocalIn >= 0.2 && ks.semis) ks = { semis: 0, dist: camelotDistance(outKey, b.key.camelot) };
  const keyDist = ks.dist;
  const forced = !pick && type !== 'auto' && type in TRANSITIONS;
  const ctx = {
    a, b, va: new TrackView(a), vb: new TrackView(b),
    rel, keyDist, masterBpm,
    energyUp: (inc.energy ?? 0.5) - (out.energy ?? 0.5),
    earliestBar, latestBar, instant,
    m: 1, notes: [], loopExt: null, maxL: 32,
    genreOut: out.genre || detectGenre(a), genreIn: inc.genre || detectGenre(b),
    outId: out.id ?? a.duration, inId: inc.id ?? b.duration, flavorHistory, freestyle,
    tune: mergeTune(mergeTune(tune, trackTune?.[out.id]), trackTune?.[inc.id]),
  };
  ctx.profile = combineProfiles(ctx.genreOut, ctx.genreIn);
  ctx.minExit = minExitBar(ctx, entryBar);
  ctx.maxL = Math.min(ctx.maxL, Math.max(...ctx.profile.lengths));
  if (ks.semis) {
    ctx.notes.push(`Key-Sync: neuer Track um ${ks.semis > 0 ? '+' : ''}${ks.semis} Halbton${Math.abs(ks.semis) > 1 ? 'e' : ''} angeglichen (${b.key.camelot} → ${shiftCamelot(b.key.camelot, ks.semis)} passt zu ${outKey})`);
  }
  ctx.m = rel.diff <= (forced ? FORCED_LIMIT : BEATMATCH_LIMIT) ? rel.m : 1;

  let chosen = type;
  let ranked = null;
  let chosenScore = 0;
  if (!forced) {
    const c = scoreStyles(ctx);
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    // gelernte Vorlieben aus deinen Bewertungen (👍/👎 pro Technik und Genre-Paar)
    const pair = `${ctx.genreOut}>${ctx.genreIn}`;
    // + was du genau bei diesen beiden Songs bewertet hast (zählt am stärksten)
    for (const k of Object.keys(c)) {
      c[k] += (bias?.[k] ?? 0) + (bias?.[`${k}@${pair}`] ?? 0)
        + (bias?.[`${k}#out:${ctx.outId}`] ?? 0) + (bias?.[`${k}#in:${ctx.inId}`] ?? 0)
        + (bias?.[`${k}#pair:${ctx.outId}>${ctx.inId}`] ?? 0);
    }
    // harte Techniken: grundsätzlich zurückhaltend (bei Pop/Rap noch mehr), plus was du als "zu hart" bewertet hast
    const soft = 0.25 + (ctx.profile.shortForm ? 0.3 : 0);
    for (const k of ['cut', 'roll', 'mashin', 'build', 'pingpong']) if (k in c) c[k] -= soft + 1.5 * ctx.tune.hardness;
    ranked = Object.entries(c)
      // Abwechslung: dieselbe Technik direkt nochmal kostet (bei Pop/Rap mehr – dort fällt es auf)
      .map(([k, score]) => [k, score - (k === last ? (ctx.profile.shortForm ? 0.5 : 0.3) : 0) - (k === prev ? (ctx.profile.shortForm ? 0.25 : 0.15) : 0)])
      .sort((x, y) => y[1] - x[1]);
    const picked = pick ? ranked.find(([k]) => k === pick) : ranked[0];
    if (picked) [chosen, chosenScore] = picked;
    else chosen = pick;
  }
  let note = '';
  // Unsicheres Beatgrid (z. B. Live-Drums, schwankendes Tempo): lange Beatmatches würden
  // auseinanderlaufen -> kurz halten oder ohne Beatmatch per Echo wechseln.
  const conf = Math.min(a.gridConfidence ?? 1, b.gridConfidence ?? 1);
  ctx.maxL = Math.min(ctx.maxL, conf < 0.3 ? 4 : conf < 0.5 ? 8 : 32);
  // Starke Tempo-Anpassung: Keylock arbeitet hörbarer -> Überlappung kürzer halten
  const stretch = Math.abs((ctx.m * masterBpm) / b.bpm - 1);
  if (stretch > 0.06) ctx.maxL = Math.min(ctx.maxL, 8);
  else if (stretch > 0.04) ctx.maxL = Math.min(ctx.maxL, 16);
  if (conf < 0.5) ctx.notes.push('Beatgrid nicht ganz sicher – Überlappung kurz gehalten');
  // Überlappung nach Zeit begrenzen: 16 Takte bei 96 BPM wären 40 s zwei Songs übereinander
  const barSec = (4 * 60) / masterBpm;
  const maxSec = (ctx.profile.shortForm ? 20 : 65) * ctx.tune.lengthScale; // House/Techno dürfen lang verweben, Pop nicht
  const byTime = Math.max(Math.min(...ctx.profile.lengths), [32, 16, 8, 4].find((L) => L * barSec <= maxSec) ?? 4);
  ctx.maxL = Math.min(ctx.maxL, byTime);
  if (forced && !['echo', 'cut', 'breakdown'].includes(chosen) && rel.diff > FORCED_LIMIT) {
    note = `${TRANSITIONS[chosen]} geht bei diesem Tempo-Sprung nicht – Echo-Out`;
    chosen = 'echo';
  }
  // (Tempo-Rampe: der alte Track passt sich an, der neue läuft in seinem Originaltempo)
  const beatmatch = chosen !== 'echo' && chosen !== 'ramp' && chosen !== 'breakdown' && rel.diff <= (forced ? FORCED_LIMIT : BEATMATCH_LIMIT);
  if (!beatmatch) ctx.m = 1;

  let result = COMPOSERS[chosen](ctx);
  if (!result) {
    // Rückfall: Blend nur, wenn das Tempo angeglichen werden kann – sonst nie Beat gegen Beat, dann Echo-Out
    const fb = beatmatch ? 'blend' : 'echo';
    note = `${TRANSITIONS[chosen]} passt hier nicht (${chosen === 'loop' ? 'keine sauber loopbare Stelle' : chosen === 'mashup' || chosen === 'mashin' ? 'kein passender Abschnitt ohne Gesang' : chosen === 'breakdown' ? 'kein Teil ohne Schlagzeug' : chosen === 'ramp' ? 'keine ruhige Stelle für die Rampe' : 'keine passenden Gesangszeilen'}) – ${TRANSITIONS[fb]}`;
    chosen = fb;
    chosenScore = ranked?.find(([k]) => k === fb)?.[1] ?? chosenScore; // Rückfall zählt als diese Technik
    ctx.notes = [];
    ctx.loopExt = null;
    result = fb === 'blend' ? composeBlend(ctx) : composeEcho(ctx);
  }
  let { L, steps } = result;
  if (!instant && chosen !== 'blend' && chosen !== 'build' && !ctx.flavors) steps = applyFx(ctx, steps, L);
  // Der alte Track muss weg sein, bevor der neue in seinen (ersten) Drop geht –
  // zwei Tracks im Drop klingen immer nach Unfall.
  // (Refrain-Wechsel schaltet selbst genau auf der Eins um – sein Echo-Schweif darf ausklingen)
  if (!SELF_TIMED.has(chosen)) {
    const nextDrop = (b.points.drops?.length ? b.points.drops : [b.points.dropBar]).find((d) => d > ctx.inBar);
    if (nextDrop !== undefined) {
      // Hat der neue Track vor dem Drop einen Build-up, muss der alte schon davor weg sein
      const build = b.phrases.find((ph) => ph.label === 'build' && ph.bar + ph.bars === nextDrop && ph.bar > ctx.inBar);
      const limitBar = build && (build.bar - ctx.inBar) / ctx.m >= 4 ? build.bar : nextDrop;
      if (limitBar !== nextDrop) ctx.notes.push('alter Track ist weg, bevor der Build-up des neuen beginnt');
      const tDrop = (limitBar - ctx.inBar) / ctx.m;
      steps = clampOutBefore(steps, tDrop);
      if (L > tDrop) L = tDrop;
    }
  }
  // Bei schwankendem Tempo zählt das Tempo genau an den Übergangsstellen, nicht der Schnitt
  const outLocal = a.beats ? localBpm(a, ctx.outBar) * outRate : masterBpm;
  const inLocal = b.beats ? localBpm(b, ctx.inBar) : b.bpm;
  const inRate = beatmatch ? (ctx.m * outLocal) / inLocal : 1;
  if (beatmatch && Math.abs(inRate - 1) > 0.001) {
    // danach unmerklich zurück aufs Originaltempo (länger bei größerer Abweichung)
    steps.push(act(Math.max(L, 1) + 0.5, 'in', 'rate', { to: 1, dur: Math.abs(inRate - 1) > 0.03 ? 32 : 16 }));
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
      ? [ctx.flavors.entry !== 'eq' ? ENTRY_FLAVORS[ctx.flavors.entry] : null, ctx.flavors.exit !== 'fade' ? EXIT_FLAVORS[ctx.flavors.exit] : null,
        ...(ctx.flavors.extras || []).map((k) => ENTRY_FLAVORS[k] || EXIT_FLAVORS[k])]
        .filter(Boolean).map((x) => ` · ${x}`).join('')
      : ''),
    flavors: ctx.flavors || null,
    reason: (note ? `${note} · ` : '') + describe(outKey, shiftCamelot(b.key.camelot, ks.semis), b.bpm, rel, keyDist, masterBpm),
    keyShift: ks.semis,
    genres: [ctx.genreOut, ctx.genreIn],
    notes: ctx.notes,
    bars: L,
    endBars: end,
    masterBpm: outLocal,
    beatmatch,
    m: ctx.m,
    inRate,
    outBar: ctx.outBar,
    inBar: ctx.inBar,
    echoBeats: 1, // Wiederholungen immer genau auf dem Beat
    steps: cleaned,
    score: chosenScore,
    ranked,
    minExit: ctx.minExit,
  };
}

const SELF_TIMED = new Set(['cut', 'echo', 'chorus', 'roll', 'mashin', 'pingpong', 'build', 'ramp', 'breakdown']);
const TEASE_STYLES = new Set(['blend', 'filter', 'loop', 'handoff', 'vocal', 'wordplay']);
const TEASE_LEVEL = 0.4;

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
    p(-2, 'in', 'fader', 0), p(-2, 'in', 'low', KILL), p(-2, 'in', 'vocal', 1), p(-2, 'in', 'filter', 0.35),
    act(-2, 'in', 'play', { barOffset: -2 * m }),
    p(-2, 'in', 'fader', TEASE_LEVEL, 1.5),
    p(-0.25, 'in', 'filter', 0, 0.2),
  );
  // Gesangssperre nur aufheben, wenn der Composer den Gesang nicht selbst steuert
  if (!composerVocal) out.splice(7, 0, p(-0.05, 'in', 'vocal', 0, 0.04));
  ctx.notes.push('neuer Track wird zwei Takte vorher angeteasert (Hi-Hats/Snare, ohne Bass und Gesang)');
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
    if (c.action === 'gate' && c.at + c.bars > tEnd) c.bars = tEnd - c.at;
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
