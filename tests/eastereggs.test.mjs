import test from 'node:test';
import assert from 'node:assert/strict';
import { isStarshipsToOneMoreTime, planEasterEgg } from '../app/mix/eastereggs.js';

function fake(bpm, drops) {
  const vocals = new Float32Array(100).fill(0);
  for (const d of drops) vocals[d - 1] = 0.8;
  return {
    bpm, beatInterval: 60 / bpm, firstBeat: 0.1, downbeat: 0,
    vocals, points: { lastBar: 99, drops, dropBar: drops[0], startBar: 0 },
  };
}
const starships = { id: 's', title: 'Starships', artist: 'Nicki Minaj', analysis: fake(125, [24, 56, 80]) };
const omt = { id: 'o', title: 'One More Time', artist: 'Daft Punk', analysis: fake(122.7, [16]) };

test('Easter Egg erkennt nur Starships -> One More Time', () => {
  assert.ok(isStarshipsToOneMoreTime(starships, omt));
  assert.ok(!isStarshipsToOneMoreTime(omt, starships));
  assert.ok(!isStarshipsToOneMoreTime(starships, { title: 'Levels' }));
  assert.ok(isStarshipsToOneMoreTime({ name: 'Nicki Minaj - Starships (Clean).mp3' }, { name: 'daft_punk-one_more_time.mp3' }));
});

test('Easter Egg: "one more time" 7 Takte im Loop, dann harter Wechsel', () => {
  const plan = planEasterEgg({ out: starships, inc: omt });
  assert.equal(plan.egg, 'starships');
  assert.equal(plan.outBar, 80); // letzter Refrain vor einem Drop
  const loop = plan.steps.find((s) => s.action === 'loop');
  assert.deepEqual([loop.at, loop.anchor, loop.bars], [0, -1, 1]);
  const play = plan.steps.find((s) => s.action === 'play');
  assert.equal(play.at, 7);
  assert.ok(plan.steps.some((s) => s.deck === 'out' && s.action === 'stop' && s.at === 7));
  assert.ok(plan.beatmatch && Math.abs(plan.inRate - 125 / 122.7) < 1e-6);
});

test('Easter Egg: Hot Cue 8, Mindest-Takt, erzwungene Technik', () => {
  const cued = planEasterEgg({ out: starships, inc: omt, outCues: { 7: 0.1 + 40 * 4 * (60 / 125) } });
  assert.equal(cued.outBar, 41);
  assert.equal(planEasterEgg({ out: starships, inc: omt, minBar: 90 }), null);
  assert.equal(planEasterEgg({ out: starships, inc: omt, type: 'blend' }), null);
  assert.equal(planEasterEgg({ out: starships, inc: omt, earliestBar: 30 }).outBar, 56);
});

test('Wiedergabeliste: One More Time direkt hinter Starships', async () => {
  const { pairEasterEggs } = await import('../app/mix/eastereggs.js');
  const T = { s: starships, o: omt, a: { title: 'A' }, b: { title: 'B' }, c: { title: 'C' } };
  const tr = (id) => T[id];
  assert.deepEqual(pairEasterEggs(['a', 'o', 'b', 's', 'c'], tr), ['a', 'b', 's', 'o', 'c']);
  assert.deepEqual(pairEasterEggs(['s', 'a', 'b', 'o'], tr, 1), ['s', 'o', 'a', 'b']);
  assert.deepEqual(pairEasterEggs(['o', 'a', 's', 'b'], tr, 1), ['o', 'a', 's', 'b']); // schon gelaufen
  assert.deepEqual(pairEasterEggs(['a', 's', 'o'], tr), ['a', 's', 'o']);
  assert.deepEqual(pairEasterEggs(['a', 'b'], tr), ['a', 'b']);
});
