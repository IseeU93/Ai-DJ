import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insightAt, boundariesBetween, keyPalette } from '../app/laser/dj/insight.js';

// 128 BPM, Downbeat auf Schlag 0: Intro 8 | Build 8 | Drop 16 | Break 8 | Build 8 | Drop 16 | Outro 8
function fakeTrack() {
  const beatInterval = 60 / 128;
  const layout = [['intro', 8], ['build', 8], ['main', 16], ['break', 8], ['build', 8], ['main', 16], ['outro', 8]];
  const phrases = [];
  let bar = 0;
  for (const [label, bars] of layout) {
    for (let b = 0; b < bars; b += 8) {
      const main = label === 'main';
      phrases.push({ bar: bar + b, bars: 8, label, energy: main ? -0.5 : -8, bass: main ? 0.8 : 0.1, drums: main ? 0.9 : 0.3, vocal: 0 });
    }
    bar += bars;
  }
  const n = bar;
  const barEnergy = Float32Array.from({ length: n }, (_, i) => (phrases.find((p) => p.bar <= i && i < p.bar + p.bars).label === 'main' ? -0.5 : -8));
  return {
    bpm: 128, beatInterval, firstBeat: 0.1, downbeat: 0, phrases, barEnergy,
    vocals: new Float32Array(n), barDrums: Float32Array.from(barEnergy, (e) => (e > -2 ? 0.9 : 0.3)),
    points: { drops: [16, 48], lastBar: n - 1 },
    key: { name: 'A minor', camelot: '8A' },
  };
}

const at = (a, bar, beat = 0) => a.firstBeat + (bar * 4 + beat) * a.beatInterval;

test('Laser kennt Takt, Schlag und Phase exakt aus dem Beatgrid', () => {
  const a = fakeTrack();
  const i = insightAt(a, at(a, 20, 2) + 0.01, 'edm');
  assert.equal(i.bar, 20);
  assert.equal(i.beatIndex, 2);
  assert.ok(i.beatPhase < 0.1);
  assert.equal(i.phase, 'drop');
  assert.equal(insightAt(a, at(a, 3), 'edm').phase, 'intro');
  assert.equal(insightAt(a, at(a, 34), 'edm').phase, 'break');
});

test('Drop wird vorher angekündigt: Spannung steigt im Build, "gleich kommt der Drop" im letzten Takt', () => {
  const a = fakeTrack();
  const early = insightAt(a, at(a, 9), 'edm');
  const late = insightAt(a, at(a, 15, 1), 'edm');
  assert.equal(early.phase, 'build');
  assert.ok(late.tension > early.tension);
  assert.equal(early.dropImminent, false);
  assert.equal(late.dropImminent, true);
  assert.equal(late.beatsToDrop, 3);
  // im Drop selbst nichts mehr ankündigen
  assert.equal(insightAt(a, at(a, 17), 'edm').dropImminent, false);
});

test('Pop/Rap: ruhiger Hauptteil ist Groove, kein Drop', () => {
  const a = fakeTrack();
  a.phrases.forEach((p) => p.label === 'main' && (p.energy = -2.5));
  assert.equal(insightAt(a, at(a, 20), 'edm').phase, 'drop');
  assert.equal(insightAt(a, at(a, 20), 'pop').phase, 'verse');
});

test('Szenenwechsel exakt auf Takt-/Phrasengrenzen, Loops/Sprünge zählen nicht als Beat', () => {
  const a = fakeTrack();
  const before = insightAt(a, at(a, 15, 3) + 0.2, 'edm');
  const after = insightAt(a, at(a, 16) + 0.005, 'edm');
  const b = boundariesBetween(before, after);
  assert.deepEqual(b, { beat: true, bar: true, phrase: true, section: true });
  const inside = boundariesBetween(insightAt(a, at(a, 17, 1) + 0.01), insightAt(a, at(a, 17, 2) + 0.01));
  assert.equal(inside.beat, true);
  assert.equal(inside.bar, false);
  const jump = boundariesBetween(insightAt(a, at(a, 30)), insightAt(a, at(a, 26)));
  assert.equal(jump.beat, false);
});

test('Tonart ergibt eine feste Farbpalette, Nachbartonarten liegen farblich nah', () => {
  const p8a = keyPalette({ camelot: '8A' });
  const p9a = keyPalette({ camelot: '9A' });
  assert.equal(p8a.length, 4);
  assert.ok(p8a.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.notDeepEqual(p8a, p9a);
  assert.deepEqual(keyPalette({ camelot: '8A' }), p8a);
  assert.equal(keyPalette(null), null);
});
