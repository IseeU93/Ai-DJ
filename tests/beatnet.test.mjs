import test from 'node:test';
import assert from 'node:assert/strict';
import { gridFromBeats, peaks } from '../app/analysis/beatnet.js';

// Netz-Schläge künstlich: gleichmäßig mit etwas Frame-Wackeln, Einsen auf jedem 4. Schlag ab Schlag 2
function fake({ bpm = 128, n = 400, start = 0.37, jitter = 0.004, db = 2, drop = [] } = {}) {
  const T = 60 / bpm;
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const beats = [];
  const downbeats = [];
  for (let k = 0; k < n; k++) {
    if (drop.includes(k)) continue;
    const t = start + k * T + jitter * rnd();
    beats.push(t);
    if (k % 4 === db) downbeats.push(t);
  }
  return { beats, downbeats };
}

test('beatnet: gleichmäßiges Tempo ergibt festes Raster mit richtiger Eins', () => {
  const g = gridFromBeats(fake());
  assert.equal(g.beatMap, null);
  assert.ok(Math.abs(60 / g.beatInterval - 128) < 0.05);
  assert.ok(g.firstBeat >= 0 && g.firstBeat < g.beatInterval);
  const best = g.downbeatVotes.indexOf(Math.max(...g.downbeatVotes));
  // App-Zählung: Schlag 0 = erster Schlag ab 0 s (hier 0,37 s) -> Eins auf Phase 2
  assert.equal(best, 2);
});

test('beatnet: ausgelassene Schläge werden aufgefüllt, Tempo bleibt', () => {
  const g = gridFromBeats(fake({ drop: [50, 51, 52, 200] }));
  assert.equal(g.beatMap, null);
  assert.ok(Math.abs(60 / g.beatInterval - 128) < 0.05);
});

test('beatnet: halbes eigenes Tempo halbiert das Netz-Tempo (Pop-Oktave)', () => {
  const g = gridFromBeats(fake({ bpm: 168 }), { hintBpm: 84 });
  assert.ok(Math.abs(60 / g.beatInterval - 84) < 0.1);
});

test('beatnet: driftendes Tempo ergibt Beat-Map, die den Schlägen folgt', () => {
  const beats = [];
  let t = 0.2;
  for (let k = 0; k < 400; k++) {
    beats.push(t);
    t += 60 / (100 + (k / 400) * 12);
  }
  const g = gridFromBeats({ beats, downbeats: beats.filter((_, k) => k % 4 === 0) });
  assert.ok(g.beatMap);
  for (let k = 5; k < 395; k++) assert.ok(Math.abs(g.beatMap[k] - beats[k]) < 0.005);
});

test('beatnet: Spitzensuche findet Maxima mit Teilframe-Genauigkeit', () => {
  const l = new Float32Array(500).fill(-5);
  for (const c of [100.3, 250, 400.7]) for (let i = 0; i < 500; i++) l[i] = Math.max(l[i], 4 - 3 * (i - c) ** 2);
  const p = peaks(l).map((x) => x.t);
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p[0] - 100.3 / 50) < 0.003);
  assert.ok(Math.abs(p[2] - 400.7 / 50) < 0.003);
});
