// Easter Eggs: bekannte DJ-Übergänge, die für ein bestimmtes Song-Paar fest eingebaut sind.
//
// Starships (Nicki Minaj) -> One More Time (Daft Punk): das "... one more time" aus dem Refrain von
// Starships wird 7 Takte geloopt, dann geht es hart auf den Anfang von One More Time.
// Liegt der Loop daneben (andere Version/Edit): auf Starships Hot Cue 8 genau auf "one more time"
// setzen – dann wird dieser Takt geloopt. Hot Cue 8 auf One More Time legt den Einstieg fest.

import { secondsToBar, localBpm } from './planner.js';

const EGG_LOOP_BARS = 7;
const CUE_SLOT = 7; // Hot Cue 8

const norm = (t) => `${t?.title || ''} ${t?.name || ''} ${t?.artist || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

export function isStarshipsToOneMoreTime(out, inc) {
  const a = norm(out);
  const b = norm(inc);
  return /\bstarships\b/.test(a) && !/one more time/.test(a) && /\bone more time\b/.test(b) && !/\bstarships\b/.test(b);
}

/**
 * Plan für den Starships-Übergang oder null (dann plant der normale Planer).
 * opts wie planTransition, dazu outCues/inCues (vom Nutzer gesetzte Hot Cues in Sekunden).
 */
export function planEasterEgg(opts) {
  const { out, inc, outRate = 1, earliestBar = null, latestBar = null, instant = false, type = 'auto' } = opts;
  if (type !== 'auto' || !out?.analysis || !inc?.analysis || !isStarshipsToOneMoreTime(out, inc)) return null;
  const a = out.analysis;
  const b = inc.analysis;
  const end = a.points.lastBar + 1;

  // Takt mit "one more time": vom Nutzer per Hot Cue 8, sonst der Takt vor einem Drop (Ende des
  // Refrains "... let's do this one more time") – bevorzugt der letzte, damit Starships ausgespielt ist
  const cue = opts.outCues?.[CUE_SLOT];
  const from = Math.max(earliestBar ?? 0, opts.minBar ?? 0);
  const fits = (bar) => bar + 1 >= from && (latestBar === null || bar + 1 <= latestBar) && bar + 1 + EGG_LOOP_BARS <= end + 8;
  let cands;
  if (typeof cue === 'number') {
    cands = [Math.round(secondsToBar(a, cue))].filter(fits);
  } else {
    const drops = a.points.drops?.length ? a.points.drops : [a.points.dropBar];
    const before = drops.filter((d) => d !== undefined && d !== null).map((d) => d - 1).filter((bar) => bar >= 0 && fits(bar));
    const sung = before.filter((bar) => (a.vocals?.[bar] ?? 0) >= 0.3);
    cands = sung.length ? sung : before; // Gesangserkennung unsicher -> trotzdem vor einem Drop
  }
  if (!cands.length || instant) return null;
  const phraseBar = earliestBar !== null ? cands[0] : cands[cands.length - 1];
  const outBar = phraseBar + 1; // Phrase läuft einmal normal, ab dem nächsten Takt wird sie geloopt

  const inCue = opts.inCues?.[CUE_SLOT];
  const inBar = typeof inCue === 'number' ? Math.round(secondsToBar(b, inCue)) : Math.max(0, Math.floor(b.points.startBar ?? 0));

  const outBpm = (a.beats ? localBpm(a, outBar) : a.bpm) * outRate;
  const inBpm = b.beats ? localBpm(b, inBar) : b.bpm;
  const ratio = outBpm / inBpm;
  const beatmatch = Math.abs(ratio - 1) <= 0.08;
  const inRate = beatmatch ? ratio : 1;
  const L = EGG_LOOP_BARS;

  const steps = [
    { at: 0, deck: 'out', action: 'loop', bars: 1, anchor: -1 },
    { at: 0, deck: 'in', param: 'fader', to: 0, dur: 0 },
    { at: L, deck: 'in', param: 'fader', to: 1, dur: 0 },
    { at: L, deck: 'in', action: 'play' },
    { at: L, deck: 'out', param: 'fader', to: 0, dur: 0 },
    { at: L, deck: 'out', action: 'stop' },
  ];
  if (beatmatch && Math.abs(inRate - 1) > 0.001) steps.push({ at: L + 1, deck: 'in', action: 'rate', to: 1, dur: 16 });

  return {
    type: 'loop',
    label: 'Easter Egg: Starships → One More Time',
    egg: 'starships',
    flavors: null,
    reason: `„one more time“ ${L} Takte im Loop, dann harter Wechsel`,
    keyShift: 0,
    genres: [out.genre || 'pop', inc.genre || 'edm'],
    notes: [
      `🥚 Easter Egg: „one more time“ aus Starships (Takt ${phraseBar}) läuft ${L} Takte im Loop`,
      'dann hart auf der Eins zu One More Time',
      typeof cue === 'number' ? 'Loop-Stelle aus Hot Cue 8' : 'Loop-Stelle daneben? Auf Starships Hot Cue 8 auf „one more time“ setzen',
    ],
    bars: L,
    endBars: L,
    masterBpm: outBpm,
    beatmatch,
    m: 1,
    inRate,
    outBar,
    inBar,
    echoBeats: 1,
    steps,
    score: 0,
    ranked: null,
    audit: { issues: [], penalty: 0 },
  };
}

/**
 * Wiedergabeliste: One More Time direkt hinter Starships einreihen (wenn beide drin sind), damit das
 * Easter Egg auch kommt. Nur ab minIndex (davor läuft/lief schon etwas). Gibt die neue Liste zurück.
 */
export function pairEasterEggs(queue, track, minIndex = 0) {
  const q = [...queue];
  const s = q.findIndex((id) => /\bstarships\b/.test(norm(track(id))) && !/one more time/.test(norm(track(id))));
  if (s < 0) return q;
  const o = q.findIndex((id, i) => i >= minIndex && i !== s && isStarshipsToOneMoreTime(track(q[s]), track(id)));
  if (o < 0 || o === s + 1 || s + 1 < minIndex) return q;
  const [id] = q.splice(o, 1);
  q.splice(q.indexOf(q[s > o ? s - 1 : s]) + 1, 0, id);
  return q;
}
