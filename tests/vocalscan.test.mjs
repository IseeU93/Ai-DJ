import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { planTransition, beatToSeconds } from '../app/mix/planner.js';
import { cleanWords, withLyricVocals, guessLanguage } from '../app/lyrics/vocalscan.js';
import { synthSong, SYNTH } from './synth.mjs';

const SECTIONS = [
  { bars: 16, kick: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 8, pad: true },
  { bars: 16, kick: true, bass: true, pad: true },
  { bars: 16, kick: true },
];

test('Songtext-Scan: Whisper-Halluzinationen (Endlosschleifen, Null-Dauer) fliegen raus, echte Refrains bleiben', () => {
  const at = (t, w, d = 0.4) => ({ t, e: t + d, w });
  const chorus = ['we', 'found', 'love', 'in', 'a', 'hopeless', 'place'];
  const real = [];
  for (let r = 0; r < 3; r++) chorus.forEach((w, i) => real.push(at(10 + r * 4 + i * 0.5, w)));
  const loop = [];
  for (let r = 0; r < 8; r++) ['going', 'to', 'the', 'next', 'one'].forEach((w, i) => loop.push(at(60 + r * 2 + i * 0.3, w, 0.2)));
  const zero = [at(90, 'thank', 0), at(90, 'you', 0)];
  const out = cleanWords([...real, ...loop, ...zero]);
  assert.equal(out.length, real.length);
});

test('Songtext-Scan: Gesang pro Takt und pro Schlag aus den Wortzeiten', () => {
  const s = synthSong({ bpm: 128, root: 57, sections: SECTIONS, offset: 0.2 });
  const a = analyzeTrack(s.L, s.R, s.sr, SYNTH);
  // eine Zeile über Takt 20 (Schlag 0-2), Takt 21 frei
  const b0 = beatToSeconds(a, a.downbeat + 4 * 20);
  const beat = a.beatInterval;
  const words = [0, 1, 2].map((k) => ({ t: b0 + k * beat, e: b0 + (k + 0.8) * beat, w: 'la' }));
  const v = withLyricVocals({ ...a, vocals: new Float32Array(a.vocals.length) }, words);
  assert.equal(v.vocalSource, 'lyrics');
  assert.ok(v.vocals[20] >= 0.9, `Takt 20: ${v.vocals[20]}`);
  assert.ok(v.vocals[21] < 0.2, `Takt 21: ${v.vocals[21]}`);
  const k = a.downbeat + 80;
  assert.ok(v.vocalBeats[k] > 0.8 && v.vocalBeats[k + 2] > 0.5 && v.vocalBeats[k + 3] < 0.3);
  assert.notEqual(v, a, 'neues Objekt (Caches erkennen die Änderung)');
});

test('Songtext-Scan: Ausstieg nur, wenn die Zeile vor der Eins endet – nie mitten durch eine Zeile', () => {
  const s = synthSong({ bpm: 128, root: 57, sections: SECTIONS, offset: 0.2 });
  const a = analyzeTrack(s.L, s.R, s.sr, SYNTH);
  const beat = a.beatInterval;
  // durchgehender Gesang von Takt 40 bis 71, Zeilen laufen über jede Taktgrenze – außer vor Takt 56
  const words = [];
  for (let b = 40; b < 72; b++) {
    for (let k = 0; k < 4; k++) {
      if (b === 55 && k >= 2) continue; // Atempause vor Takt 56
      if (b === 56 && k < 2) continue;
      const t = beatToSeconds(a, a.downbeat + 4 * b + k);
      words.push({ t, e: t + beat * 0.95, w: 'la' });
    }
  }
  const lyr = withLyricVocals(a, words);
  const out = { id: 'o', analysis: lyr, energy: 0.5, genre: 'pop' };
  const inc = { id: 'i', analysis: a, energy: 0.5, genre: 'pop' };
  const plan = planTransition({ out, inc, type: 'echo' });
  assert.ok(!plan.audit.lineCut, plan.notes.join(' | '));
});

test('Songtext-Sprache wird aus Stil und Titel geraten', () => {
  assert.equal(guessLanguage({ title: 'Atemlos durch die Nacht', artist: 'Helene Fischer' }), 'german');
  assert.equal(guessLanguage({ title: 'Poker Face', artist: 'Lady Gaga' }), 'english');
  assert.equal(guessLanguage({ title: 'Wahnsinn', artist: 'Wolfgang Petry', style: 'Schlager' }), 'german');
});
