// Plant einen Übergang wie ein DJ: Phrasen-genau, mit passender Technik je nach Tempo, Tonart,
// Song-Struktur und Gesang. Liefert eine deklarative Schrittliste (Takte relativ zu T0),
// die der Conductor sample-genau ausführt.
import { BEATMATCH_LIMIT, camelotDistance, tempoRelation } from './order.js';

export const TRANSITIONS = {
  blend: 'Blend + Bass-Swap',
  loop: 'Loop-Roll',
  vocal: 'Lyrics-Wechsel',
  filter: 'Filter-Sweep',
  cut: 'Drop-Cut',
  echo: 'Echo-Out',
};

export const KILL = -26; // dB, EQ-"Kill"
const VOCAL_MIN = 0.45;

// ------------------------------------------------------------------ Helfer

export function barToSeconds(a, bar) {
  return a.firstBeat + (a.downbeat + 4 * bar) * a.beatInterval;
}

export function secondsToBar(a, t) {
  return ((t - a.firstBeat) / a.beatInterval - a.downbeat) / 4;
}

function endBar(a) {
  return a.points.lastBar + 1;
}

function phraseStarts(a) {
  return a.phrases.map((p) => p.bar);
}

/** Spätester Phrasenstart, ab dem noch `len` Takte bis Trackende bleiben. */
function latestPhraseFor(a, len, notBefore = 0) {
  const end = endBar(a);
  const fits = phraseStarts(a).filter((b) => b >= notBefore && b + len <= end);
  if (fits.length) return fits[fits.length - 1];
  const b = Math.floor((end - len - a.phraseOffset) / 4) * 4 + a.phraseOffset;
  return Math.max(notBefore, b);
}

function outroStart(a, len) {
  const end = endBar(a);
  const o = a.points.outroBar;
  if (o !== null && o !== undefined && o + len <= end) return o;
  return latestPhraseFor(a, len);
}

function vocalPhrases(a) {
  return a.phrases.filter((p) => p.vocal >= VOCAL_MIN && p.label !== 'intro' && p.label !== 'outro');
}

// ------------------------------------------------------------------ Schritt-Vorlagen

const p = (at, deck, param, to, dur = 0) => ({ at, deck, param, to, dur });
const act = (at, deck, action, extra = {}) => ({ at, deck, action, ...extra });

function blendSteps(L) {
  return [
    p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'mid', -3), p(0, 'in', 'high', -8),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 0.85, L * 0.25),
    p(L * 0.25, 'in', 'high', 0, L * 0.25),
    p(L * 0.25, 'in', 'mid', 0, L * 0.25),
    // Bass-Swap auf der Phrasenmitte, innerhalb eines Beats
    p(L * 0.5, 'out', 'low', KILL, 0.25),
    p(L * 0.5, 'in', 'low', 0, 0.25),
    p(L * 0.5, 'in', 'fader', 1, 0.25),
    p(L * 0.5, 'out', 'high', -10, L * 0.25),
    p(L * 0.6, 'out', 'mid', -8, L * 0.25),
    p(L * 0.75, 'out', 'fader', 0, L * 0.25),
    act(L, 'out', 'stop'),
  ];
}

function filterSteps(L) {
  return [
    p(0, 'in', 'fader', 0), p(0, 'in', 'filter', -0.85), p(0, 'in', 'low', KILL),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 1, L * 0.3),
    p(0, 'out', 'filter', 0.7, L * 0.85),
    p(L * 0.1, 'in', 'filter', 0, L * 0.7),
    p(L * 0.75, 'out', 'low', KILL, 0.25),
    p(L * 0.75, 'in', 'low', 0, 0.25),
    p(L * 0.8, 'out', 'fader', 0, L * 0.2),
    act(L, 'out', 'stop'),
  ];
}

function loopRollSteps() {
  // 4 Takte Loop, dann 2, 1, 1/2, 1/4, 1/8 Takt – Loop-Start bleibt der Phrasenanfang
  return [
    p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'filter', -0.6),
    act(0, 'in', 'play'),
    act(0, 'out', 'loop', { bars: 4, anchor: 0 }),
    p(0, 'in', 'fader', 0.85, 4),
    p(2, 'in', 'filter', 0, 3.5),
    act(4, 'out', 'loop', { bars: 2, anchor: 0 }),
    p(4, 'out', 'filter', 0.35, 2),
    act(6, 'out', 'loop', { bars: 1, anchor: 0 }),
    p(6, 'out', 'filter', 0.55, 1),
    act(7, 'out', 'loop', { bars: 0.5, anchor: 0 }),
    act(7.5, 'out', 'loop', { bars: 0.25, anchor: 0 }),
    p(7.5, 'out', 'echo', 0.8, 0.25),
    p(7.5, 'out', 'filter', 0.75, 0.5),
    act(7.75, 'out', 'loop', { bars: 0.125, anchor: 0 }),
    // Drop: alter Track weg (Echo klingt aus), neuer Track mit vollem Bass
    p(8, 'out', 'fader', 0),
    p(8, 'in', 'low', 0),
    p(8, 'in', 'fader', 1),
    p(8.25, 'out', 'echo', 0),
    act(9, 'out', 'stop'),
  ];
}

function vocalTradeSteps() {
  // Gesang wechselt alle 4 Takte zwischen den Tracks (der jeweils andere bekommt Vocal-Cut)
  return [
    p(0, 'in', 'fader', 0), p(0, 'in', 'low', KILL), p(0, 'in', 'vocal', 1),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 0.85, 2),
    p(4, 'in', 'vocal', 0, 0.25),
    p(4, 'out', 'vocal', 1, 0.25),
    p(8, 'out', 'vocal', 0, 0.25),
    p(8, 'in', 'vocal', 1, 0.25),
    p(8, 'out', 'low', KILL, 0.25),
    p(8, 'in', 'low', 0, 0.25),
    p(8, 'in', 'fader', 1, 0.25),
    p(12, 'in', 'vocal', 0, 0.25),
    p(12, 'out', 'vocal', 1, 0.25),
    p(12, 'out', 'high', -8, 3),
    p(12, 'out', 'fader', 0, 4),
    act(16, 'out', 'stop'),
  ];
}

function cutSteps() {
  return [
    p(0, 'in', 'fader', 0),
    p(-2, 'out', 'filter', 0.5, 2),
    p(-0.25, 'out', 'echo', 0.7, 0.25),
    act(0, 'in', 'play'),
    p(0, 'in', 'fader', 1),
    p(0, 'out', 'fader', 0),
    p(0.25, 'out', 'echo', 0),
    act(1, 'out', 'stop'),
  ];
}

function echoSteps() {
  return [
    p(0, 'in', 'fader', 1),
    p(-1, 'out', 'filter', 0.45, 1),
    p(-0.5, 'out', 'echo', 1, 0.5),
    p(0, 'out', 'fader', 0, 0.25),
    p(0.25, 'out', 'echo', 0),
    act(1, 'in', 'play'),
    act(1, 'out', 'stop'),
  ];
}

// ------------------------------------------------------------------ Auswahl

function candidates(out, inc, rel, keyDist) {
  const a = out.analysis;
  const b = inc.analysis;
  const inIntro = b.points.dropBar - b.points.startBar;
  const outOutro = endBar(a) - (a.points.outroBar ?? endBar(a));
  const tempoOk = rel.diff <= BEATMATCH_LIMIT;
  const outVocal = vocalPhrases(a).filter((ph) => ph.bar >= a.barCount * 0.4 && ph.bar + 16 <= endBar(a));
  const inVocal = vocalPhrases(b);
  const energyUp = (inc.energy ?? 0.5) - (out.energy ?? 0.5);

  // Würden sich bei einem langen Blend zwei Stimmen überlagern? (Outro alt vs. Intro neu)
  const outTailVocal = a.phrases.filter((ph) => ph.bar >= endBar(a) - 16).reduce((m, ph) => Math.max(m, ph.vocal), 0);
  const inHeadVocal = b.phrases.filter((ph) => ph.bar < b.points.dropBar).reduce((m, ph) => Math.max(m, ph.vocal), 0);
  const vocalClash = outTailVocal >= VOCAL_MIN && inHeadVocal >= VOCAL_MIN;

  const c = {};
  if (tempoOk) {
    c.blend = 1.0 + (inIntro >= 16 ? 0.5 : inIntro >= 8 ? 0 : -0.5) + (outOutro >= 8 ? 0.2 : 0) + (keyDist <= 0.15 ? 0.3 : -0.8 * keyDist) - (vocalClash ? 0.7 : 0);
    c.filter = 0.75 + (keyDist > 0.3 ? 0.25 : 0) + (inIntro >= 8 ? 0.1 : 0);
    c.loop = 0.8 + (inIntro < 16 ? 0.25 : 0) + (energyUp > 0.1 ? 0.25 : 0);
    if (outVocal.length && inVocal.length) c.vocal = 1.25 + (keyDist <= 0.15 ? 0.35 : keyDist <= 0.35 ? 0 : -0.7);
    c.cut = 0.55 + (inIntro < 8 ? 0.4 : 0) + (energyUp > 0.15 ? 0.25 : 0) + (keyDist >= 0.5 ? 0.2 : 0);
    c.echo = 0.3 + (keyDist >= 0.6 ? 0.3 : 0);
  } else {
    c.echo = 2;
    c.cut = rel.diff <= 0.12 ? 0.8 : -1; // Drop-Cut geht auch bei größerem Tempo-Sprung noch
  }
  return { c, outVocal, inVocal };
}

// ------------------------------------------------------------------ Hauptfunktion

/**
 * @param out, inc: Track-Objekte ({ analysis, energy })
 * @param outRate: aktuelles Tempo-Verhältnis des laufenden Decks
 * @param type: 'auto' oder ein Schlüssel aus TRANSITIONS
 * @param history: zuletzt verwendete Typen (neueste zuletzt) – für Abwechslung
 * @param earliestBar: frühester Takt im laufenden Track ("Jetzt mixen")
 */
export function planTransition({ out, inc, outRate = 1, type = 'auto', history = [], earliestBar = null }) {
  const a = out.analysis;
  const b = inc.analysis;
  const masterBpm = a.bpm * outRate;
  const rel = tempoRelation(masterBpm, b.bpm);
  const keyDist = camelotDistance(a.key.camelot, b.key.camelot);
  const { c, outVocal, inVocal } = candidates(out, inc, rel, keyDist);

  let chosen = type;
  if (chosen === 'auto' || !(chosen in TRANSITIONS)) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    let best = -Infinity;
    for (const [k, score] of Object.entries(c)) {
      const s = score - (k === last ? 0.5 : 0) - (k === prev ? 0.25 : 0);
      if (s > best) {
        best = s;
        chosen = k;
      }
    }
  }
  // Manuell gewählter Typ, der beim Tempo nicht geht -> trotzdem ausführen, aber ohne Beatmatch
  const beatmatch = rel.diff <= BEATMATCH_LIMIT && chosen !== 'echo';

  const lengths = { blend: 16, filter: 16, loop: 8, vocal: 16, cut: 1, echo: 2 };
  let L = lengths[chosen];
  if (chosen === 'blend' || chosen === 'filter') {
    const inIntro = b.points.dropBar - b.points.startBar;
    const outOutro = endBar(a) - (a.points.outroBar ?? endBar(a));
    if (inIntro >= 32 && outOutro >= 32 && chosen === 'blend') L = 32;
    if (inIntro < 8 && earliestBar === null) L = 8;
  }

  // ---- Einstiegspunkt im laufenden Track (T0 auf einem Downbeat einer Phrase)
  const outSpan = chosen === 'loop' ? 9 : chosen === 'cut' || chosen === 'echo' ? 1 : L;
  let outBar;
  if (earliestBar !== null) {
    const grid = chosen === 'cut' || chosen === 'echo' ? 1 : 4;
    outBar = Math.ceil((earliestBar - a.phraseOffset) / grid) * grid + a.phraseOffset;
    const maxBar = endBar(a) - Math.min(outSpan, 4);
    if (outBar > maxBar) outBar = Math.max(Math.ceil(earliestBar), maxBar);
    if (outBar + L > endBar(a) && chosen !== 'loop') L = Math.max(4, endBar(a) - outBar);
  } else if (chosen === 'vocal') {
    outBar = outVocal.length ? outVocal[outVocal.length - 1].bar : outroStart(a, L);
  } else if (chosen === 'cut' || chosen === 'echo') {
    // am Ende der letzten Hauptphrase raus (bzw. Outro-Start)
    outBar = a.points.outroBar ?? latestPhraseFor(a, 2);
    if (outBar + 1 > endBar(a)) outBar = endBar(a) - 1;
  } else {
    outBar = outroStart(a, outSpan);
  }

  // ---- Einstiegspunkt im neuen Track
  const m = beatmatch ? rel.m : 1; // Takte des neuen Tracks pro Master-Takt
  const startBar = b.points.startBar;
  let inBar;
  if (chosen === 'cut') {
    inBar = b.points.dropBar;
  } else if (chosen === 'echo') {
    inBar = startBar;
  } else if (chosen === 'vocal') {
    const v = inVocal.length ? inVocal[0].bar : b.points.dropBar;
    inBar = Math.max(startBar, v - 4 * m);
  } else {
    const lead = chosen === 'loop' ? 8 : L;
    inBar = Math.max(startBar, b.points.dropBar - lead * m);
  }
  inBar = Math.round(inBar);

  const inRate = beatmatch ? (m * masterBpm) / b.bpm : 1;

  let steps;
  switch (chosen) {
    case 'blend': steps = blendSteps(L); break;
    case 'filter': steps = filterSteps(L); break;
    case 'loop': steps = loopRollSteps(); L = 8; break;
    case 'vocal': steps = vocalTradeSteps(); break;
    case 'cut': steps = cutSteps(); break;
    default: steps = echoSteps(); break;
  }
  if (beatmatch && Math.abs(inRate - 1) > 0.001) {
    steps.push(act(Math.max(L, 1), 'in', 'rate', { to: 1, dur: 32 }));
  }
  steps.sort((x, y) => x.at - y.at);

  const end = Math.max(...steps.filter((s) => s.action !== 'rate').map((s) => s.at + (s.dur || 0)));
  const reason = describe(chosen, a, b, rel, keyDist, masterBpm);

  return {
    type: chosen,
    label: TRANSITIONS[chosen],
    reason,
    bars: L,
    endBars: end,
    masterBpm,
    beatmatch,
    m,
    inRate,
    outBar,
    inBar,
    echoBeats: 0.75,
    steps,
  };
}

function describe(type, a, b, rel, keyDist, masterBpm) {
  const parts = [`${masterBpm.toFixed(1)} → ${b.bpm.toFixed(1)} BPM`];
  if (rel.m !== 1) parts.push(rel.m === 2 ? 'Doppeltempo' : 'Halbtempo');
  parts.push(`${a.key.camelot} → ${b.key.camelot}${keyDist <= 0.15 ? ' (harmonisch)' : keyDist >= 0.6 ? ' (Tonart-Clash)' : ''}`);
  if (rel.diff > BEATMATCH_LIMIT) parts.push('Tempo zu weit für Beatmatch');
  if (type === 'vocal') parts.push('beide mit Gesang');
  return parts.join(' · ');
}
