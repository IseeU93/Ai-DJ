// Teaser: Gegen Ende des laufenden Tracks spielt der DJ einmal kurz den Hook des nächsten Tracks
// an – 2 Takte, im Takt, ohne Bass, an einer Stelle, an der der alte Track gerade Luft lässt
// (Break, Instrumental-Teil, keine Stimme). Danach läuft der alte weiter, der Übergang kommt später.

import { camelotDistance } from './order.js';

const at = (arr, i, d = 0) => (arr && i >= 0 && i < arr.length && Number.isFinite(arr[i]) ? arr[i] : d);
const mean = (arr, b0, b1, d = 0) => {
  let s = 0;
  let n = 0;
  for (let i = Math.floor(b0); i < b1; i++) {
    s += at(arr, i, d);
    n++;
  }
  return n ? s / n : d;
};

function labelAt(t, bar) {
  let lab = 'intro';
  for (const ph of t.phrases || []) if (ph.bar <= bar) lab = ph.label;
  return lab;
}

/**
 * Stelle des neuen Tracks, die angespielt wird: eine wiedererkennbare Gesangsstelle, die für sich
 * weich klingt (wenig Schlagzeug, keine harte Kick-Wand). Harte Drops werden nie angeteasert –
 * ohne Bass bleiben davon nur Klatschen und Snares übrig, das klingt nach Fehler. null = nichts Passendes.
 */
export function teaserSource(b) {
  const start = b.points?.startBar ?? 0;
  const hardTrack = (b.fourFloor ?? 0) >= 0.6 && b.bpm >= 140;
  let best = null;
  for (const ph of b.phrases || []) {
    if (ph.bar < start + 4) continue;
    for (const bar of [ph.bar, ph.bar + 4]) {
      if (bar + 2 > (b.points?.lastBar ?? Infinity)) continue;
      const vocal = mean(b.vocals, bar, bar + 2);
      const energy = mean(b.barEnergy, bar, bar + 2, -6); // dB unter den lautesten Stellen des Songs
      if (vocal < 0.45) continue; // ohne Stimme erkennt man den Song nicht
      // harte/volle Sektion (lautester Teil; bei Hardstyle/Uptempo alles außer ruhigen Breaks) – nie
      if (energy > (hardTrack ? -5 : -0.7)) continue;
      let sc = vocal * 1.5 - Math.max(0, energy + 4) * 0.1;
      if (ph.label === 'main') sc += 0.3; // Refrain/Hook: am wiedererkennbarsten
      sc -= (bar - start) * 0.004; // eher früh im Song (erster Refrain)
      if (!best || sc > best.sc) best = { sc, bar, what: ph.label === 'main' ? 'Refrain' : 'Gesang' };
    }
  }
  return best;
}

/**
 * Sucht die Teaser-Stelle im alten Track `a` vor dem geplanten Ausstieg `outBar`: nur in einem
 * ruhigen Moment (Break/Intro/Build-up, keine Stimme) und nur, wenn die Tonarten passen.
 * Liefert { bar, bars, inFrom, what } (Takte des alten Tracks, inFrom = Takt im neuen) oder null.
 */
export function planTeaser(a, b, outBar, nowBar, bars = 2, minScore = 0.6) {
  if (camelotDistance(a.key?.camelot, b.key?.camelot) >= 0.8) return null; // deutlicher Tonart-Clash: schiefe Töne statt Vorfreude
  const src = teaserSource(b);
  if (!src) return null;
  const off = a.phraseOffset || 0;
  let best = null;
  const from = Math.max(Math.ceil(nowBar) + 4, outBar - 40);
  for (let end = outBar - 8; end >= from + bars; end--) {
    if ((((end - off) % 4) + 4) % 4 !== 0) continue; // endet genau auf einer 4er-Grenze
    const b0 = end - bars;
    const vocal = mean(a.vocals, b0 - 1, end + 1);
    if (vocal >= 0.3) continue; // nie über eine Stimme des alten Tracks
    const energy = mean(a.barEnergy, b0, end, -6);
    const drums = mean(a.barDrums, b0, end, 0.5);
    const lab = labelAt(a, b0);
    // nie über einen lauten, laufenden Hauptteil (ruhigere Instrumental-Passagen gehen)
    if (lab === 'outro' || (lab === 'main' && energy > -2.5)) continue;
    if (drums > 0.75 && energy > -2.5) continue;
    let sc = 1 - vocal * 2;
    if (lab === 'break') sc += 0.8;
    else if (lab === 'build' || lab === 'intro') sc += 0.3;
    if ((((end - off) % 8) + 8) % 8 === 0) sc += 0.3; // Phrasenende
    sc -= Math.max(0, energy + 3) * 0.1; // lieber in ruhigere Stellen
    sc -= Math.abs(outBar - end - 16) * 0.01; // grob 16 Takte vor dem Übergang ist ideal
    if (!best || sc > best.sc) best = { sc, bar: b0, bars, inFrom: src.bar, what: src.what };
  }
  return best && best.sc > minScore - 0.1 ? best : null;
}
