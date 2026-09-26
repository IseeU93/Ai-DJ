// Musikalisches Wissen aus der MP3-Analyse für die Lasershow: wo im Track wir sind (Takt, Schlag,
// Phrase), was als Nächstes kommt (Build, Drop, Break) und wie sich das anfühlt (Energie, Gesang,
// Tonart). Anders als die Live-Analyse der Lasershow muss hier nichts geraten werden: Beatgrid,
// Drops und Builds stehen vorher fest – der Laser kann auf den Punkt vorausplanen.

import { secondsToBeat } from '../../mix/planner.js';

const PHASE_OF_LABEL = { intro: 'intro', outro: 'outro', build: 'build', break: 'break' };

/** Tonart -> Farbton: Quintenzirkel einmal rund ums Farbrad, Moll kühler/dunkler als Dur. */
export function keyPalette(key) {
  const m = /^(\d{1,2})([AB])$/.exec(key?.camelot || '');
  if (!m) return null;
  const n = (Number(m[1]) - 1) % 12;
  const minor = m[2] === 'A';
  const hue = (n * 30 + (minor ? 200 : 20)) % 360;
  const sat = minor ? 0.95 : 1;
  const light = minor ? 0.5 : 0.55;
  return [0, 18, -18, 38].map((d, i) => hsl((hue + d + 360) % 360, sat, i === 3 ? light + 0.1 : light));
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function phraseAt(a, bar) {
  const list = a.phrases || [];
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].bar <= bar) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Energiestufe 0..1 aus der Takt-Lautheit (dB relativ zum lautesten Teil des Tracks). */
function level(a, bar) {
  const e = a.barEnergy?.[bar];
  if (!Number.isFinite(e)) return 0;
  return Math.max(0, Math.min(1, 1 + e / 14));
}

/**
 * Hauptteile sind nicht automatisch Drops: bei Pop/Rap sind das meist Strophen und Refrains. Als
 * "drop" gilt ein Hauptteil nur, wenn er richtig drückt (laut + Drums + Bass).
 */
function mainPhase(a, ph, genre) {
  // Pop/Rap: ein Refrain ist kein Drop – nur wirklich drückende Teile (EDM-Pop) zählen
  const strict = genre === 'pop' || genre === 'rap';
  const loud = ph.energy >= (strict ? -0.5 : -3);
  const drive = (ph.drums ?? 0) >= (strict ? 0.75 : 0.4) && (ph.bass ?? 0) >= (strict ? 0.5 : 0.3);
  return loud && drive ? 'drop' : 'verse';
}

/**
 * Zustand des Tracks bei `seconds` (Position im Track). Liefert alles, was die Lasershow für ihre
 * Dramaturgie braucht, plus den Blick nach vorn (nächster Drop in Schlägen).
 */
export function insightAt(a, seconds, genre = null) {
  if (!a || !(a.beatInterval > 0)) return null;
  const beatPos = secondsToBeat(a, seconds) - a.downbeat; // Schläge ab Takt 0 (Beat-Map bei schwankendem Tempo)
  const bar = Math.floor(beatPos / 4);
  const beatInBar = ((beatPos % 4) + 4) % 4;
  const pi = phraseAt(a, Math.max(0, bar));
  const ph = pi >= 0 ? a.phrases[pi] : null;
  const label = ph?.label || 'intro';
  let phase = PHASE_OF_LABEL[label] || mainPhase(a, ph || {}, genre);
  if (bar < 0) phase = 'intro';

  const drops = a.points?.drops || [];
  const nextDrop = drops.find((d) => d > bar + beatInBar / 4 - 1e-6 && d * 4 > beatPos);
  const beatsToDrop = nextDrop !== undefined ? nextDrop * 4 - beatPos : Infinity;
  // Ein Drop kündigt sich nur an, wenn davor etwas aufgebaut wurde (Build/Break/Intro)
  const leadIn = phase === 'build' || phase === 'break' || phase === 'intro';
  const dropImminent = leadIn && beatsToDrop <= 4;

  // Spannung: im Build von 0.3 bis 1 bis zum Drop hochziehen, sonst nach Energie
  let tension = 0.25 * level(a, bar);
  if (phase === 'build' && ph) {
    const prog = Math.max(0, Math.min(1, (beatPos / 4 - ph.bar) / Math.max(1, ph.bars)));
    tension = 0.3 + 0.7 * prog;
  } else if (leadIn && beatsToDrop <= 16) {
    tension = Math.max(tension, 1 - beatsToDrop / 16);
  }

  const vocal = a.vocals?.[bar] ?? 0;
  const drums = a.barDrums?.[bar] ?? 0;
  const lvl = level(a, bar);
  const prevLvl = level(a, bar - 2);
  const trend = phase === 'build' || lvl - prevLvl > 0.12 ? 'rising' : prevLvl - lvl > 0.12 ? 'falling' : 'steady';

  return {
    bar,
    beatPos,
    beatIndex: Math.floor(beatInBar),
    beatPhase: beatInBar % 1,
    measurePhase: beatInBar / 4,
    phraseIndex: pi,
    phraseBar: ph ? bar - ph.bar : 0,
    label,
    phase,
    level: lvl,
    trend,
    tension,
    vocal,
    drums,
    vocalOnly: vocal >= 0.6 && drums < 0.2,
    dropImminent,
    beatsToDrop,
    ended: bar > (a.points?.lastBar ?? Infinity),
  };
}

/** Grenzen zwischen zwei Zeitpunkten desselben Tracks (für Szenenwechsel exakt auf der Eins). */
export function boundariesBetween(prev, cur) {
  if (!prev || !cur) return { beat: false, bar: false, phrase: false, section: false };
  const jumped = cur.beatPos < prev.beatPos || cur.beatPos - prev.beatPos > 2; // Loop/Sprung
  if (jumped) return { beat: false, bar: false, phrase: false, section: cur.label !== prev.label };
  const beat = Math.floor(cur.beatPos) !== Math.floor(prev.beatPos);
  const bar = cur.bar !== prev.bar;
  const phrase = bar && cur.phraseIndex !== prev.phraseIndex;
  const section = phrase && (cur.label !== prev.label || cur.phase !== prev.phase);
  return { beat, bar, phrase, section };
}

/** Show-Intensität passend zur Musikrichtung (Eskalation des Choreographen, 0..1). */
export const GENRE_ESCALATION = { pop: 0.35, rap: 0.3, edm: 0.6, hardstyle: 0.85, uptempo: 1 };
