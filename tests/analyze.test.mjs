import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { synthSong, SYNTH } from './synth.mjs';

const SECTIONS = [
  { bars: 16, kick: true, bass: false, pad: false, vocal: false }, // Intro
  { bars: 16, kick: true, bass: true, pad: true, vocal: true }, // Main mit Gesang
  { bars: 8, kick: false, bass: false, pad: true, vocal: false }, // Break
  { bars: 16, kick: true, bass: true, pad: true, vocal: false }, // Main
  { bars: 16, kick: true, bass: false, pad: false, vocal: false }, // Outro
];

for (const bpm of [124, 128, 140, 95]) {
  test(`Beatgrid & Struktur bei ${bpm} BPM`, () => {
    const song = synthSong({ bpm, sections: SECTIONS, offset: 0.37 });
    const a = analyzeTrack(song.L, song.R, song.sr, SYNTH);
    assert.ok(Math.abs(a.bpm - bpm) < 0.05, `bpm ${a.bpm}`);
    const beat = 60 / bpm;
    // Beat-Phase: firstBeat muss auf dem Raster der echten Beats liegen
    const phaseErr = Math.abs((((a.firstBeat - song.firstBeat) % beat) + 1.5 * beat) % beat - beat / 2);
    assert.ok(phaseErr < 0.004, `phase err ${(phaseErr * 1000).toFixed(1)} ms (first ${a.firstBeat})`);
    assert.ok(a.gridConfidence > 0.7, `confidence ${a.gridConfidence}`);
    // Drift über den ganzen Track < 15 ms
    const lastTrue = song.firstBeat + 250 * beat;
    const k = Math.round((lastTrue - a.firstBeat) / a.beatInterval);
    const lastEst = a.firstBeat + k * a.beatInterval;
    assert.ok(Math.abs(lastEst - lastTrue) < 0.015, `drift ${(lastEst - lastTrue) * 1000} ms`);
    // Downbeat: Takt-1 muss auf echte Taktanfänge fallen
    const dbTime = a.firstBeat + a.downbeat * a.beatInterval;
    const barsFromStart = (dbTime - song.firstBeat) / (4 * beat);
    assert.ok(Math.abs(barsFromStart - Math.round(barsFromStart)) < 0.02, `downbeat ${barsFromStart}`);
    const barShift = Math.round(barsFromStart);
    // Drop (erste Main-Phrase) bei Takt 16
    assert.equal(a.points.dropBar + barShift, 16, `dropBar ${a.points.dropBar} shift ${barShift}`);
    assert.equal(a.points.outroBar + barShift, 56, `outroBar ${a.points.outroBar}`);
    // Gesang in Takten 16-31 höher als im Rest
    const v = Array.from(a.vocals);
    const inVocal = v.slice(16 - barShift, 32 - barShift);
    const other = v.slice(40 - barShift, 56 - barShift);
    const mean = (x) => x.reduce((p, c) => p + c, 0) / x.length;
    assert.ok(mean(inVocal) > mean(other) + 0.3, `vocal ${mean(inVocal)} vs ${mean(other)}`);
    // Drums: Intro (Kick) hat Drums, Break (nur Pad) nicht
    const dr = Array.from(a.barDrums);
    assert.ok(mean(dr.slice(4 - barShift, 12 - barShift)) > 0.4, `intro drums ${mean(dr.slice(4, 12))}`);
    assert.ok(mean(dr.slice(33 - barShift, 39 - barShift)) < 0.3, `break drums ${mean(dr.slice(33, 39))}`);
    assert.ok(mean(dr.slice(18 - barShift, 30 - barShift)) > 0.5, `main drums ${mean(dr.slice(18, 30))}`);
    assert.deepEqual(a.points.drops.map((d) => d + barShift), [16, 40], `drops ${a.points.drops}`);
    assert.ok(Math.abs(a.points.vocalFirst + barShift - 16) <= 1, `vocalFirst ${a.points.vocalFirst}`);
    // Loop-taugliche Takte: der Main-Teil wiederholt sich
    assert.ok(mean(Array.from(a.barRepeat).slice(44 - barShift, 52 - barShift)) > 0.6, 'repeat');
    // A-Moll bzw. parallel C-Dur -> Camelot 8 (A/B sind harmonisch kompatibel)
    assert.match(a.key.camelot, /^8[AB]$/, `key ${a.key.name}`);
  });
}

test('Taktanfang über Backbeat (Snare auf 2+4) bei stehendem Akkord', () => {
  const secs = [{ bars: 48, kick: true, snare: true, bass: true, pad: true }];
  for (const offset of [0.3, 0.3 + 60 / 124, 0.3 + 120 / 124]) {
    const song = synthSong({ bpm: 124, sections: secs, offset, staticChord: true });
    const a = analyzeTrack(song.L, song.R, song.sr, SYNTH);
    const dbTime = a.firstBeat + a.downbeat * a.beatInterval;
    const bars = (dbTime - offset) / (4 * 60 / 124);
    assert.ok(Math.abs(bars - Math.round(bars)) < 0.02, `offset ${offset}: downbeat liegt bei ${bars} Takten`);
  }
});

test('Unpräzises Timing senkt die Grid-Zuverlässigkeit', () => {
  const secs = [{ bars: 40, kick: true, snare: true, bass: true }];
  const tight = analyzeTrack(...Object.values(synthSong({ bpm: 120, sections: secs })).slice(0, 3), SYNTH);
  const loose = analyzeTrack(...Object.values(synthSong({ bpm: 120, sections: secs, jitter: 0.012 })).slice(0, 3), SYNTH);
  assert.ok(tight.gridConfidence > loose.gridConfidence + 0.2, `${tight.gridConfidence} vs ${loose.gridConfidence}`);
});

const HARD = [{ bars: 32, kick: true, bass: true, pad: true, vocal: false }];

for (const bpm of [200, 240, 280]) {
  test(`Uptempo: ${bpm} BPM wird nicht als halbes Tempo erkannt`, () => {
    const song = synthSong({ bpm, sections: HARD });
    const a = analyzeTrack(song.L, song.R, song.sr, SYNTH);
    assert.ok(Math.abs(a.bpm - bpm) < 0.1, `bpm ${a.bpm}`);
  });
}

test('House mit Offbeat-Bass bleibt bei 126 BPM (kein falsches Verdoppeln)', () => {
  const song = synthSong({ bpm: 126, sections: HARD, offbeatBass: true });
  const a = analyzeTrack(song.L, song.R, song.sr, SYNTH);
  assert.ok(Math.abs(a.bpm - 126) < 0.1, `bpm ${a.bpm}`);
});

test('Uptempo-Playlist-Hinweis und getapptes Tempo', () => {
  const song = synthSong({ bpm: 120, sections: HARD });
  assert.ok(Math.abs(analyzeTrack(song.L, song.R, song.sr, { ...SYNTH, bpmMin: 170 }).bpm - 240) < 0.1);
  assert.ok(Math.abs(analyzeTrack(song.L, song.R, song.sr, { ...SYNTH, bpm: 119.5 }).bpm - 120) < 0.1);
});

import { evaluate } from '../tools/beatbench.mjs';
import { barToSeconds, secondsToBar, localBpm } from '../app/mix/planner.js';

// Echte Drum-Patterns (Prüfstand tools/beatbench.mjs): Tempo, Beat-Timing und "Eins" müssen stimmen
for (const c of [
  { name: 'Rap 92 (Kicks auf Offbeats, Snare 2+4)', bpm: 92, pattern: { kick: [0, 6, 10], snare: [4, 12], hat: 8 } },
  { name: 'Pop 100 (synkopierte Kick)', bpm: 100, pattern: { kick: [0, 3, 8, 11], snare: [4, 12], hat: 8 } },
  { name: 'Half-Time 140 (nicht verdoppeln)', bpm: 140, pattern: { kick: [0, 10], snare: [8], hat: 8 } },
  { name: 'Hip-Hop Swing 96', bpm: 96, pattern: { kick: [0, 7, 10], snare: [4, 12], hat: 16, swing: 0.3 } },
  { name: 'Rap 94 live gespielt (Tempo ±1 %)', bpm: 94, pattern: { kick: [0, 6, 10], snare: [4, 12], hat: 8 }, drift: 0.01 },
]) {
  test(`Beat-Erkennung: ${c.name}`, () => {
    const r = evaluate(c);
    assert.ok(r.bpmErr < 0.01, `BPM ${r.bpm} statt ${r.truthBpm}`);
    assert.ok(r.ok20 > 0.9, `nur ${(r.ok20 * 100).toFixed(0)} % der Schläge < 20 ms (Median ${r.med.toFixed(1)} ms)`);
    assert.ok(r.downbeatOk, 'Eins falsch');
  });
}

test('Beat-Map: Takt <-> Sekunden folgt dem schwankenden Tempo', () => {
  const beats = Float64Array.from({ length: 200 }, (_, k) => 1 + k * 0.6 + 0.02 * Math.sin(k / 10));
  const a = { beats, firstBeat: beats[0], beatInterval: 0.6, downbeat: 2, bpm: 100 };
  assert.ok(Math.abs(barToSeconds(a, 10) - beats[42]) < 1e-9);
  assert.ok(Math.abs(secondsToBar(a, beats[42]) - 10) < 1e-9);
  assert.ok(Math.abs(secondsToBar(a, barToSeconds(a, 17.25)) - 17.25) < 1e-9);
  assert.ok(Math.abs(localBpm(a, 20) - 100) < 5);
});
