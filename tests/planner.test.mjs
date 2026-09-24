import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { planTransition } from '../app/mix/planner.js';
import { assignEnergy, buildSetOrder, camelotDistance, tempoRelation } from '../app/mix/order.js';
import { synthSong } from './synth.mjs';

const SECTIONS = [
  { bars: 16, kick: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 8, pad: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 16, kick: true },
];

const cache = new Map();
function track(id, bpm, root = 57) {
  const k = `${bpm}-${root}`;
  if (!cache.has(k)) {
    const s = synthSong({ bpm, root, sections: SECTIONS, offset: 0.2 });
    cache.set(k, analyzeTrack(s.L, s.R, s.sr));
  }
  return { id, analysis: cache.get(k), energy: 0.5 };
}

test('Camelot & Tempo-Beziehungen', () => {
  assert.equal(camelotDistance('8A', '8A'), 0);
  assert.equal(camelotDistance('8A', '9A'), 0.1);
  assert.equal(camelotDistance('12A', '1A'), 0.1);
  assert.equal(camelotDistance('8A', '8B'), 0.15);
  assert.ok(camelotDistance('8A', '2B') > 0.6);
  assert.equal(tempoRelation(87, 174).m, 2);
  assert.equal(tempoRelation(128, 126).m, 1);
});

test('Blend: Outro des alten trifft Intro des neuen, Drop landet am Ende', () => {
  const out = track('a', 128);
  const inc = track('b', 126);
  const plan = planTransition({ out, inc, type: 'blend' });
  assert.equal(plan.beatmatch, true);
  assert.ok(Math.abs(plan.inRate - 128 / 126) < 0.002, `inRate ${plan.inRate}`);
  const a = out.analysis;
  assert.equal(plan.outBar, a.points.outroBar);
  assert.ok(plan.outBar + plan.bars <= a.points.lastBar + 1);
  // Drop des neuen Tracks genau am Übergangsende
  assert.equal(plan.inBar + plan.bars * plan.m, inc.analysis.points.dropBar);
  assert.ok(plan.steps.some((s) => s.param === 'low' && s.deck === 'out' && s.to < -20), 'Bass-Swap fehlt');
});

test('Zu großer Tempo-Sprung -> Echo-Out ohne Beatmatch', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('c', 100) });
  assert.equal(plan.type, 'echo');
  assert.equal(plan.beatmatch, false);
  assert.equal(plan.inRate, 1);
});

test('Instrumentale Intros/Outros -> sauberer Blend bevorzugt', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64) });
  assert.equal(plan.type, 'blend', `gewählt: ${plan.type}`);
});

test('Lyrics-Wechsel bei zwei Gesangs-Tracks, wenn schon zweimal geblendet wurde', () => {
  // Gesang des neuen Tracks erst nach seinem Drop -> kein Tausch möglich, sauber auf Blend
  const late = planTransition({ out: track('a', 128), inc: track('b', 128, 64), type: 'vocal' });
  assert.equal(late.type, 'blend', late.reason);
  // Gesang schon im Intro -> Lyrics-Wechsel vor dem Drop
  const vocalIntro = [
    { bars: 16, kick: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true, vocal: true },
    { bars: 16, kick: true },
  ];
  const plan = planTransition({ out: track('a', 128), inc: trackWith('vi', 128, vocalIntro, 64), type: 'vocal' });
  assert.equal(plan.type, 'vocal', plan.reason);
  const tDrop = (plan.inBar < 16 ? 16 - plan.inBar : 0);
  assert.ok(plan.steps.filter((s) => s.deck === 'out').every((s) => s.at + (s.dur || 0) <= tDrop + 1e-9), 'alter Track nach dem Drop');
});

test('Abwechslung: gleicher Typ wird nicht dreimal hintereinander gewählt', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64), history: ['vocal', 'vocal'] });
  assert.notEqual(plan.type, 'vocal');
});

test('Loop-Mix: loopt eine gesangsfreie Groove-Stelle, Drop des neuen Tracks am Ende', () => {
  const out = track('a', 128);
  const inc = track('b', 127);
  const plan = planTransition({ out, inc, type: 'loop' });
  const loops = plan.steps.filter((s) => s.action === 'loop');
  assert.ok([4, 8].includes(loops[0].bars), `loop ${loops[0].bars}`);
  const a = out.analysis;
  const lb = plan.outBar + loops[0].anchor;
  const voc = Array.from(a.vocals).slice(lb, lb + loops[0].bars);
  assert.ok(Math.max(...voc) < 0.5, `Gesang im Loop ${voc}`);
  assert.equal(plan.inBar + plan.bars * plan.m, inc.analysis.points.dropBar);
  assert.ok(plan.notes.length >= 2);
});

test('Loop-Mix mit Energie-Anstieg endet mit kurzem Loop-Roll in den Drop', () => {
  const out = { ...track('a', 128), energy: 0.3 };
  const inc = { ...track('b', 127), energy: 0.8 };
  const plan = planTransition({ out, inc, type: 'loop' });
  const loops = plan.steps.filter((s) => s.action === 'loop').map((s) => s.bars);
  assert.deepEqual(loops.slice(1), [1, 0.5, 0.25]);
});

test('Frühester Takt: beste Stelle ab dort, auf dem 4-Takt-Raster', () => {
  const out = track('a', 128);
  const plan = planTransition({ out, inc: track('b', 126), type: 'blend', earliestBar: 20.3 });
  assert.equal((plan.outBar - out.analysis.phraseOffset) % 4, 0);
  assert.ok(plan.outBar >= 20.3, `outBar ${plan.outBar}`);
});

test('Mix-Punkt nicht stur am Ende: Drop-Swap, wenn der alte Track noch einen Drop hätte', () => {
  // alter Track: Break (Takt 40-47) und danach letzter Drop bei 48, der neue hat 16 Takte Intro
  const sections = [
    { bars: 16, kick: true },
    { bars: 24, kick: true, bass: true, pad: true },
    { bars: 8, pad: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const out = trackWith('d', 128, sections);
  const plan = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const lastDrop = out.analysis.points.drops.at(-1);
  assert.ok(plan.outBar + plan.bars <= lastDrop, `Mix endet bei ${plan.outBar + plan.bars}, alter Drop bei ${lastDrop}: ${plan.notes.join(' | ')}`);
  assert.ok(plan.notes.some((n) => n.includes('Drop-Swap') || n.includes('Break')), plan.notes.join(' | '));
});

test('Set-Reihenfolge: ruhiger Start, harmonische Nachbarn', () => {
  const keys = ['8A', '3B', '9A', '10A', '4B', '8A', '9A'];
  const tracks = keys.map((k, i) => ({
    id: `t${i}`,
    analysis: {
      bpm: 124 + (i % 3),
      key: { camelot: k },
      intensity: i,
      bassWeight: i,
      brightness: 0,
    },
  }));
  assignEnergy(tracks);
  const order = buildSetOrder(tracks);
  assert.equal(order.length, tracks.length);
  assert.equal(new Set(order).size, tracks.length);
  assert.ok(order[0].energy <= 0.35, `Start-Energie ${order[0].energy}`);
  let clashes = 0;
  for (let i = 1; i < order.length; i++) {
    if (camelotDistance(order[i - 1].analysis.key.camelot, order[i].analysis.key.camelot) > 0.4) clashes++;
  }
  assert.ok(clashes <= 2, `clashes ${clashes}: ${order.map((t) => t.analysis.key.camelot)}`);
});

test('Set-Reihenfolge: laufender Track bleibt vorne', () => {
  const tracks = ['8A', '9A', '10A', '11A'].map((k, i) => ({
    id: `t${i}`, analysis: { bpm: 125, key: { camelot: k }, intensity: i, bassWeight: 0, brightness: 0 },
  }));
  assignEnergy(tracks);
  const order = buildSetOrder(tracks, [tracks[3]]);
  assert.equal(order[0], tracks[3]);
});

test('Erzwungener Blend bei großem Tempo-Sprung wird zu Echo-Out', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('c', 100), type: 'blend' });
  assert.equal(plan.type, 'echo');
  assert.match(plan.reason, /Echo-Out/);
});

test('Erzwungener Blend bei 12 % Tempo-Unterschied wird trotzdem angeglichen', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('d', 113), type: 'blend' });
  assert.equal(plan.type, 'blend');
  assert.equal(plan.beatmatch, true);
});

const SHORT_OUTRO = [
  { bars: 16, kick: true },
  { bars: 32, kick: true, bass: true, pad: true, vocal: true },
  { bars: 4, kick: true },
];

function trackWith(id, bpm, sections, root = 57) {
  const s = synthSong({ bpm, root, sections, offset: 0.2 });
  return { id, analysis: analyzeTrack(s.L, s.R, s.sr), energy: 0.5 };
}

test('Blend verlängert ein zu kurzes Outro per Loop auf gesangsfreien Takten', () => {
  const out = trackWith('s', 128, SHORT_OUTRO);
  const plan = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const loop = plan.steps.find((s) => s.action === 'loop');
  assert.ok(loop, 'kein Loop');
  assert.ok(plan.notes.some((n) => n.includes('Loop')), plan.notes.join(' | '));
});

test('Gesang wird abgesenkt, wenn sich zwei Stimmen überlagern würden', () => {
  const vocalIntro = [
    { bars: 16, kick: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  // Normalfall: der Planer steigt erst nach dem Gesang des alten Tracks ein -> kein Konflikt
  const out = trackWith('s', 128, SHORT_OUTRO);
  const inc = trackWith('v', 128, vocalIntro, 64);
  const clean = planTransition({ out, inc, type: 'blend' });
  assert.ok(clean.outBar >= out.analysis.points.vocalLast, `outBar ${clean.outBar}`);
  // "Jetzt mixen" mitten im Gesang: Stimme des neuen Tracks wird abgesenkt
  const now = planTransition({ out, inc, type: 'blend', earliestBar: 20, instant: true });
  assert.ok(now.steps.some((s) => s.param === 'vocal' && s.to === 1), now.notes.join(' | '));
});

test('Jetzt mixen (sofort): Einstieg auf dem nächsten Takt, keine Vorlauf-Schritte', () => {
  const out = track('a', 128);
  for (const type of ['blend', 'loop', 'cut', 'echo', 'filter']) {
    const plan = planTransition({ out, inc: track('b', 126), type, earliestBar: 30.2, instant: true });
    assert.equal(plan.outBar, 31, `${type}: outBar ${plan.outBar}`);
    assert.ok(plan.steps.every((s) => s.at >= 0), type);
  }
});

test('Übergang passt sich der Intro-Länge des neuen Tracks an', () => {
  const shortIntro = [
    { bars: 8, kick: true },
    { bars: 32, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const out = track('a', 128);
  const long = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const short = planTransition({ out, inc: trackWith('i', 128, shortIntro), type: 'blend' });
  assert.equal(long.bars, 16);
  assert.equal(short.bars, 8);
});

test('Alter Track ist immer vor dem ersten Drop des neuen komplett weg', () => {
  const out = track('a', 128);
  for (const type of ['blend', 'loop', 'filter', 'vocal']) {
    const inc = track('b', 127, 64);
    const plan = planTransition({ out, inc, type });
    const drop = inc.analysis.points.drops.find((d) => d > plan.inBar);
    const tDrop = (drop - plan.inBar) / plan.m;
    const outSteps = plan.steps.filter((s) => s.deck === 'out');
    assert.ok(outSteps.every((s) => s.at + (s.dur || 0) <= tDrop + 1e-9), `${type}: ${JSON.stringify(outSteps.at(-1))} tDrop ${tDrop}`);
    const fades = outSteps.filter((s) => s.param === 'fader');
    assert.equal(fades.at(-1).to, 0, type);
  }
});

test('Reshuffle liefert andere, aber gültige Reihenfolgen', () => {
  const keys = ['8A', '9A', '10A', '8B', '9B', '7A', '8A', '11A'];
  const tracks = keys.map((k, i) => ({ id: `t${i}`, analysis: { bpm: 124 + (i % 3), key: { camelot: k }, intensity: i, bassWeight: i % 4, brightness: 0 } }));
  assignEnergy(tracks);
  const best = buildSetOrder(tracks).map((t) => t.id).join();
  const variants = new Set([1, 2, 3, 4, 5].map((s) => buildSetOrder(tracks, [], s * 7919).map((t) => t.id).join()));
  assert.ok([...variants].some((v) => v !== best), 'keine Variante');
  for (const v of variants) assert.equal(new Set(v.split(',')).size, tracks.length);
});
