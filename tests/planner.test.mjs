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

test('Lyrics-Wechsel bei zwei Gesangs-Tracks, wenn gerade schon geblendet wurde', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64), history: ['blend'] });
  assert.equal(plan.type, 'vocal', `gewählt: ${plan.type}`);
  const vocalSteps = plan.steps.filter((s) => s.param === 'vocal');
  assert.ok(vocalSteps.length >= 6);
});

test('Abwechslung: gleicher Typ wird nicht dreimal hintereinander gewählt', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64), history: ['vocal', 'vocal'] });
  assert.notEqual(plan.type, 'vocal');
});

test('Loop-Roll: Loops werden kürzer, Drop auf Takt 8', () => {
  const out = track('a', 128);
  const inc = track('b', 127);
  const plan = planTransition({ out, inc, type: 'loop' });
  const loops = plan.steps.filter((s) => s.action === 'loop').map((s) => s.bars);
  assert.deepEqual(loops, [4, 2, 1, 0.5, 0.25, 0.125]);
  assert.equal(plan.inBar + 8 * plan.m, inc.analysis.points.dropBar);
});

test('Jetzt mixen: Einstieg auf nächster 4-Takt-Grenze', () => {
  const out = track('a', 128);
  const plan = planTransition({ out, inc: track('b', 126), type: 'blend', earliestBar: 20.3 });
  assert.equal((plan.outBar - out.analysis.phraseOffset) % 4, 0);
  assert.ok(plan.outBar >= 20.3 && plan.outBar < 25);
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
