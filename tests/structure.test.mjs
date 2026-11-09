import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { trackStructure, describeStructure } from '../app/analysis/structure.js';
import { synthSong, SYNTH } from './synth.mjs';

function analysis(sections, bpm = 128) {
  const s = synthSong({ bpm, root: 57, sections, offset: 0.2 });
  return analyzeTrack(s.L, s.R, s.sr, SYNTH);
}

const CLUB = [
  { bars: 16, kick: true },
  { bars: 24, kick: true, bass: true, pad: true },
  { bars: 8, pad: true },
  { bars: 16, kick: true, bass: true, pad: true },
  { bars: 16, kick: true },
];

test('Struktur: Clubtrack wird wie ein DJ gelesen (Intro, Drop, Break/Build-up, Drop, Outro)', () => {
  const st = trackStructure(analysis(CLUB), { club: true });
  const roles = st.sections.map((s) => s.role);
  assert.equal(roles[0], 'intro', describeStructure(st));
  assert.equal(roles.at(-1), 'outro', describeStructure(st));
  assert.equal(roles.filter((r) => r === 'drop').length, 2, describeStructure(st));
  // der ruhige Teil ohne Kick zwischen den Drops ist kein Höhepunkt
  const mid = st.sections.find((s) => s.from <= 42 && s.to > 42);
  assert.ok(['breakdown', 'build'].includes(mid.role), describeStructure(st));
  // Grenzen liegen auf dem Phrasenraster (± 1 Takt Toleranz für den Analyse-Versatz)
  for (const b of [16, 40, 48, 64]) assert.ok(st.sections.some((s) => Math.abs(s.from - b) <= 1), `keine Grenze bei ${b}: ${describeStructure(st)}`);
});

test('Struktur: Cue-Punkte (Mix-In, erster Höhepunkt, Outro) passen zum Aufbau', () => {
  const st = trackStructure(analysis(CLUB), { club: true });
  const { cues } = st;
  assert.ok(Math.abs(cues.firstPeak - 16) <= 1, JSON.stringify(cues));
  assert.ok(Math.abs(cues.outroStart - 64) <= 1, JSON.stringify(cues));
  assert.ok(cues.mixIn <= cues.introEnd && cues.introEnd <= cues.firstPeak, JSON.stringify(cues));
  assert.ok(cues.lastPeakEnd <= cues.outroStart, JSON.stringify(cues));
  // Energie-Stufen: Drop lauter als Intro und Outro
  const drop = st.sections.find((s) => s.role === 'drop');
  assert.ok(drop.level > st.sections[0].level && drop.level > st.sections.at(-1).level, describeStructure(st));
});

test('Struktur: Song mit Gesang hat Strophe/Refrain statt Drop', () => {
  const st = trackStructure(analysis([
    { bars: 8, kick: true },
    { bars: 16, kick: true, pad: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true, vocal: true },
    { bars: 16, kick: true, pad: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true, vocal: true },
    { bars: 8, kick: true },
  ], 110));
  const roles = st.sections.map((s) => s.role);
  assert.ok(st.vocalSong, describeStructure(st));
  assert.ok(roles.includes('chorus'), describeStructure(st));
  assert.ok(!roles.includes('drop'), describeStructure(st));
  assert.equal(roles[0], 'intro', describeStructure(st));
});
