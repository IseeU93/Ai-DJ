import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { synthSong } from './synth.mjs';

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
    const a = analyzeTrack(song.L, song.R, song.sr);
    assert.ok(Math.abs(a.bpm - bpm) < 0.05, `bpm ${a.bpm}`);
    const beat = 60 / bpm;
    // Beat-Phase: firstBeat muss auf dem Raster der echten Beats liegen
    const phaseErr = Math.abs((((a.firstBeat - song.firstBeat) % beat) + 1.5 * beat) % beat - beat / 2);
    assert.ok(phaseErr < 0.012, `phase err ${(phaseErr * 1000).toFixed(1)} ms (first ${a.firstBeat})`);
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
    // A-Moll bzw. parallel C-Dur -> Camelot 8 (A/B sind harmonisch kompatibel)
    assert.match(a.key.camelot, /^8[AB]$/, `key ${a.key.name}`);
  });
}
