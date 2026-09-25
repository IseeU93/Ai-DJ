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

test('Easter Egg: "one more time" (2:08) 7 Takte im Loop, dann hart auf den Gesang von Daft Punk (0:31)', () => {
  const s = { ...starships, analysis: { ...starships.analysis, duration: 210 } };
  const o = { ...omt, analysis: { ...omt.analysis, duration: 320 } };
  const plan = planEasterEgg({ out: s, inc: o });
  assert.equal(plan.egg, 'starships');
  const a = s.analysis;
  const b = o.analysis;
  // Loop beginnt auf dem Schlag bei ~2:08, genau dort, wo er im Song läuft (nahtlos)
  const loop = plan.steps.find((x) => x.action === 'loop');
  assert.equal(loop.at, loop.anchor);
  assert.equal((plan.outBar + loop.anchor) * 4, Math.round((128.0 - a.firstBeat) / a.beatInterval));
  assert.equal(loop.bars, 1);
  const play = plan.steps.find((x) => x.action === 'play');
  assert.equal(play.at, loop.at + 7);
  assert.ok(plan.steps.some((x) => x.deck === 'out' && x.action === 'stop' && x.at === play.at));
  // Einstieg beim ersten "One more time" (Schlag bei ~30.75 s)
  assert.equal(plan.inBar * 4, Math.round((30.75 - b.firstBeat) / b.beatInterval));
  assert.ok(plan.beatmatch && Math.abs(plan.inRate - 125 / 122.7) < 1e-6);
  // schon über 2:08 hinaus -> die nächste Stelle (~2:54)
  const later = planEasterEgg({ out: s, inc: o, minBar: 70 });
  assert.equal((later.outBar + later.steps.find((x) => x.action === 'loop').anchor) * 4, Math.round((174.1 - a.firstBeat) / a.beatInterval));
});

test('Easter Egg: andere Version -> Takt vor Drop, Hot Cue 8, Mindest-Takt, erzwungene Technik', () => {
  assert.equal(planEasterEgg({ out: starships, inc: omt }).outBar, 79); // letzter Refrain vor einem Drop
  const cued = planEasterEgg({ out: starships, inc: omt, outCues: { 7: 0.1 + 40 * 4 * (60 / 125) } });
  assert.equal(cued.outBar, 40);
  assert.equal(planEasterEgg({ out: starships, inc: omt, minBar: 90 }), null);
  assert.equal(planEasterEgg({ out: starships, inc: omt, type: 'blend' }), null);
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
