// Show-Plan pro Track: Aus der fertigen MP3-Analyse wird vorab festgelegt, welcher Effekt auf welcher
// Phrase läuft (und welche Zusatzebene im Drop). Gewechselt wird nur auf Phrasengrenzen – mindestens
// 8, meist 16 Takte – statt bei jedem Ausschlag der Live-Analyse. Der Plan entsteht, sobald ein Track
// in ein Deck geladen ist, also auch für den nächsten Track schon vor dem Übergang.
import { insightAt } from './insight.js';

const HARD = new Set(['uptempo', 'hardstyle']);
const CALM = new Set(['pop', 'rap']);

/** Effekt-Pools je Abschnitt und Musikrichtung ('*' = Standard). */
const POOLS = {
  intro: { '*': ['scanner', 'lissajous', 'rainbowRing'], uptempo: ['tunnel', 'spiral'], hardstyle: ['tunnel', 'scanner'] },
  outro: { '*': ['scanner', 'rainbowRing', 'lissajous'], uptempo: ['tunnel', 'spiral'], hardstyle: ['tunnel', 'scanner'] },
  verse: {
    '*': ['scanner', 'hotBeams', 'spiral', 'lsdTunnel', 'rainbowRing'],
    pop: ['liquidSky', 'rainbowRing', 'scanner', 'lissajous', 'snake'],
    rap: ['scanner', 'liquidSky', 'rainbowRing', 'lissajous'],
    hardstyle: ['hotBeams', 'tunnel', 'spiral', 'scanner'],
    uptempo: ['tunnel', 'lsdTunnel', 'spiral', 'hotBeams'],
  },
  build: { '*': ['tunnel', 'lsdTunnel', 'spiral'], pop: ['lsdTunnel', 'rainbowRing'], rap: ['lsdTunnel', 'rainbowRing'] },
  drop: {
    '*': ['hotBeams', 'beamSweep', 'scanner', 'spiral'],
    pop: ['hotBeams', 'scanner', 'spiral'],
    rap: ['hotBeams', 'scanner'],
    hardstyle: ['beamSweep'],
    uptempo: ['beamSweep'],
  },
  break: { '*': ['liquidSky', 'snake', 'lissajous', 'rainbowRing'], uptempo: ['lsdTunnel', 'tunnel', 'rainbowRing'], hardstyle: ['liquidSky', 'lsdTunnel', 'rainbowRing'] },
};
/** Zusatzebene nur im Drop, nie bei Pop/Rap. */
const DROP_OVERLAY = { '*': ['chaosBlades', null], hardstyle: ['chaosBlades', 'hotBeams'], uptempo: ['chaosBlades', 'hotBeams'] };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick(list, seed, avoid) {
  const opts = list.filter((e) => e !== avoid);
  const from = opts.length ? opts : list;
  return from[seed % from.length];
}

/**
 * Baut den Plan: Liste von Segmenten { bar, bars, phase, effect, overlay, hard }.
 * Ein Abschnitt (gleiche Phase am Stück) behält seinen Effekt bis zu 16 Takte (ruhige Genres 32),
 * erst danach kommt der nächste – immer auf einer Phrasengrenze.
 */
export function buildShowPlan(a, genre, id = '') {
  if (!a?.phrases?.length) return [];
  const g = genre || 'edm';
  const hold = CALM.has(g) ? 32 : 16;
  const segs = [];
  let prevEffect = null;
  let n = hash(`${id}|${g}`);
  for (const ph of a.phrases) {
    const phase = insightAt(a, a.firstBeat + (a.downbeat + 4 * (ph.bar + 0.5)) * a.beatInterval, g)?.phase || 'verse';
    const last = segs[segs.length - 1];
    // gleicher Abschnitt und noch nicht lange genug gelaufen -> weiter mit demselben Effekt
    if (last && last.phase === phase && last.bars + ph.bars <= hold) {
      last.bars += ph.bars;
      continue;
    }
    n = (Math.imul(n, 1103515245) + 12345) >>> 0;
    const pool = POOLS[phase]?.[g] || POOLS[phase]?.['*'] || POOLS.verse['*'];
    const effect = pick(pool, n >>> 8, prevEffect);
    let overlay = null;
    if (phase === 'drop' && !CALM.has(g)) {
      const ov = DROP_OVERLAY[g] || DROP_OVERLAY['*'];
      overlay = ov[(n >>> 4) % ov.length];
      if (overlay === effect) overlay = null;
    }
    segs.push({ bar: ph.bar, bars: ph.bars, phase, effect, overlay, hard: phase === 'drop' && HARD.has(g) });
    prevEffect = effect;
  }
  return segs;
}

export function segmentAt(plan, bar) {
  let found = plan[0] || null;
  for (const s of plan) {
    if (s.bar <= bar) found = s;
    else break;
  }
  return found;
}
