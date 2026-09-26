import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFeedback, importFeedback, mergeFeedback, toRelative, fromRelative } from '../app/lib/sync.js';

const BS = String.fromCharCode(92); // Backslash (Windows-Pfade)
const win = (...parts) => parts.join(BS);

test('Abgleich: Track-Bezüge relativ zum Musik-Ordner, auf dem anderen Gerät wieder voll', () => {
  const pc = win('C:', 'Users', 'Fabian', 'Music', 'Privat', 'DJ');
  const phone = '/storage/emulated/0/Music/Automix';
  assert.equal(toRelative(win(pc, 'Banger', 'Mr. Brightside.mp3'), pc), 'rel:Banger/Mr. Brightside.mp3');
  assert.equal(fromRelative('rel:Banger/Mr. Brightside.mp3', phone), '/storage/emulated/0/Music/Automix/Banger/Mr. Brightside.mp3');
  assert.equal(fromRelative('rel:Banger/Mr. Brightside.mp3', pc), win(pc, 'Banger', 'Mr. Brightside.mp3'));
  const entries = [
    { time: 1, type: 'blend', verdict: 'up', outId: win(pc, 'Anfang', 'A.mp3'), inId: win(pc, 'Anfang', 'B.mp3') },
    { time: 2, kind: 'order', a: win(pc, 'x.mp3'), b: win('D:', 'anders', 'y.mp3'), verdict: 'down' },
  ];
  const onPhone = importFeedback(exportFeedback(entries, pc), phone);
  assert.equal(onPhone[0].outId, `${phone}/Anfang/A.mp3`);
  assert.equal(onPhone[1].a, `${phone}/x.mp3`);
  assert.equal(onPhone[1].b, win('D:', 'anders', 'y.mp3')); // außerhalb des Ordners: unverändert
});

test('Abgleich: Bewertungen zusammenführen – jede genau einmal, zeitlich sortiert', () => {
  const a = [{ time: 1, verdict: 'up', type: 'blend' }, { time: 3, verdict: 'down', type: 'cut' }];
  const b = [{ time: 2, verdict: 'up', kind: 'trick', trick: 'echo' }, { time: 3, verdict: 'down', type: 'cut' }];
  const m = mergeFeedback(a, b);
  assert.deepEqual(m.map((e) => e.time), [1, 2, 3]);
  assert.equal(mergeFeedback(m, m).length, 3);
  assert.equal(mergeFeedback(a, b, 2).length, 2);
});
