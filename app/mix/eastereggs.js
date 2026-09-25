// Easter Eggs: bekannte DJ-Übergänge, die für ein bestimmtes Song-Paar fest eingebaut sind.
//
// Starships (Nicki Minaj) -> One More Time (Daft Punk): das "one more time" aus dem Refrain von
// Starships (ca. 2:10) wird 7 Takte geloopt, dann geht es hart genau auf das "One more time, we're
// gonna celebrate" von Daft Punk (Radio Edit ca. 1:03 – davor ist Intro).
// Liegt es daneben (andere Version/Edit): Hot Cue 8 auf Starships genau auf "one" von "one more
// time" setzen, und/oder Hot Cue 8 auf One More Time auf den Einsatz des Gesangs.

import { barToSeconds, secondsToBeat, localBpm } from './planner.js';

const EGG_LOOP_BARS = 7; // so lange läuft der Loop
const EGG_LOOP_LEN = 0.5; // Loop-Länge: halber Takt = genau "one more time"
const CUE_SLOT = 7; // Hot Cue 8

// Bekannte Versionen (erkannt an der Länge in Sekunden). Starships: Zeit des "one" von "... let's do
// this one more time" (liegt jeweils auf der Eins), bevorzugte Stelle zuerst (Refrain um 2:10).
// One More Time: Einsatz "One more time, we're gonna celebrate" nach dem Intro.
// Starships Lyrics-Version (3:49), One More Time Radio Edit (3:55) und Album (5:20) per Spracherkennung +
// Onset an echten Dateien gemessen; Starships Album/Single aus synchronisierten Lyrics.
const STARSHIPS = [
  { duration: [226, 232], ones: [129.91, 175.99, 53.11] }, // "Starships (Lyrics)"
  { duration: [204, 217], ones: [128.0, 174.1, 51.1] }, // Album/Single 3:30
];
const ONE_MORE_TIME = [
  { duration: [233, 238], vocal: 62.88 }, // Radio Edit 3:55
  { duration: [300, 330], vocal: 30.35 }, // Album 5:20 (gemessen; Lyrics-Daten sagen 30.75 = einen Schlag zu spät)
];
const version = (list, dur) => list.find((v) => dur >= v.duration[0] && dur <= v.duration[1]) || null;

const norm = (t) => `${t?.title || ''} ${t?.name || ''} ${t?.artist || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

export function isStarshipsToOneMoreTime(out, inc) {
  const a = norm(out);
  const b = norm(inc);
  return /\bstarships\b/.test(a) && !/one more time/.test(a) && /\bone more time\b/.test(b) && !/\bstarships\b/.test(b);
}

/** Zeit -> Takt (gebrochen), auf den nächsten Schlag gerastet. */
const barOnBeat = (a, sec) => (Math.round(secondsToBeat(a, sec)) - a.downbeat) / 4;

/**
 * Plan für den Starships-Übergang oder null (dann plant der normale Planer).
 * opts wie planTransition, dazu outCues/inCues (vom Nutzer gesetzte Hot Cues in Sekunden) und
 * minBar (frühester Takt, ab dem noch geplant werden kann).
 */
export function planEasterEgg(opts) {
  const { out, inc, outRate = 1, earliestBar = null, latestBar = null, instant = false, type = 'auto' } = opts;
  if (type !== 'auto' || !out?.analysis || !inc?.analysis || !isStarshipsToOneMoreTime(out, inc)) return null;
  if (instant) return null;
  const a = out.analysis;
  const b = inc.analysis;
  const end = a.points.lastBar + 1;
  const from = Math.max(earliestBar ?? 0, opts.minBar ?? 0);
  const fits = (bar) => Math.floor(bar) >= from && (latestBar === null || bar <= latestBar) && bar + EGG_LOOP_BARS <= end + 8;

  // Stelle mit "one more time" in Starships (Takt, gebrochen – "one" liegt nicht auf der Eins)
  const cue = opts.outCues?.[CUE_SLOT];
  let source;
  let cands;
  if (typeof cue === 'number') {
    source = 'Hot Cue 8';
    cands = [barOnBeat(a, cue)];
  } else if (version(STARSHIPS, a.duration)) {
    source = 'bekannte Stelle';
    cands = version(STARSHIPS, a.duration).ones.map((t) => barOnBeat(a, t));
  } else {
    // unbekannte Version: Takt vor einem Drop mit Gesang, der dem 2. Refrain (~57 % des Songs) am
    // nächsten liegt – nicht der letzte, sonst landet der Übergang ganz am Ende
    source = 'geschätzt';
    const drops = (a.points.drops?.length ? a.points.drops : [a.points.dropBar]).filter((d) => d !== undefined && d !== null);
    const before = drops.map((d) => d - 1).filter((bar) => bar >= 0);
    const sung = before.filter((bar) => (a.vocals?.[bar] ?? 0) >= 0.3);
    const target = secondsToBeat(a, a.duration * 0.57) / 4;
    cands = (sung.length ? sung : before).sort((x, y) => Math.abs(x - target) - Math.abs(y - target));
  }
  const phrase = cands.find(fits);
  if (phrase === undefined) return null;
  const outBar = Math.floor(phrase);
  const off = phrase - outBar; // "one" liegt so weit hinter der Eins
  const L = EGG_LOOP_BARS;
  const sw = off + L; // Wechsel genau dort, wo das nächste "one" käme

  // Einsatz "One more time" bei Daft Punk
  const inCue = opts.inCues?.[CUE_SLOT];
  let inBar;
  if (typeof inCue === 'number') inBar = barOnBeat(b, inCue);
  else if (version(ONE_MORE_TIME, b.duration)) inBar = barOnBeat(b, version(ONE_MORE_TIME, b.duration).vocal);
  else inBar = b.points.vocalFirst ?? b.points.startBar ?? 0;

  const outBpm = (a.beats ? localBpm(a, outBar) : a.bpm) * outRate;
  const inBpm = b.beats ? localBpm(b, inBar) : b.bpm;
  const ratio = outBpm / inBpm;
  const beatmatch = Math.abs(ratio - 1) <= 0.08;
  const inRate = beatmatch ? ratio : 1;

  const steps = [
    { at: 0, deck: 'in', param: 'fader', to: 0, dur: 0 },
    { at: off, deck: 'out', action: 'loop', bars: EGG_LOOP_LEN, anchor: off },
    { at: sw, deck: 'in', param: 'fader', to: 1, dur: 0 },
    { at: sw, deck: 'in', action: 'play' },
    { at: sw, deck: 'out', param: 'fader', to: 0, dur: 0 },
    { at: sw, deck: 'out', action: 'stop' },
  ];
  if (beatmatch && Math.abs(inRate - 1) > 0.001) steps.push({ at: sw + 1, deck: 'in', action: 'rate', to: 1, dur: 16 });

  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return {
    type: 'loop',
    label: 'Easter Egg: Starships → One More Time',
    egg: 'starships',
    flavors: null,
    reason: `„one more time“ ${L} Takte im Loop, dann harter Wechsel`,
    keyShift: 0,
    genres: [out.genre || 'pop', inc.genre || 'edm'],
    notes: [
      `🥚 Easter Egg: „one more time“ aus Starships bei ${mmss(barToSeconds(a, phrase))} (${source}) läuft ${L} Takte im Loop`,
      'dann hart auf das erste „One more time“ von Daft Punk',
      source === 'Hot Cue 8' ? 'Loop-Stelle aus Hot Cue 8' : 'Stelle daneben? Auf Starships Hot Cue 8 genau auf „one“ setzen',
    ],
    bars: sw,
    endBars: sw,
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
