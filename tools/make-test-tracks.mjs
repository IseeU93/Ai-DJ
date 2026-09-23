// Erzeugt synthetische Testtracks (WAV) mit bekannter Struktur – ohne urheberrechtlich geschütztes Material.
//   node tools/make-test-tracks.mjs <zielordner>
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { synthSong } from '../tests/synth.mjs';

const out = resolve(process.argv[2] || 'test-tracks');
await mkdir(out, { recursive: true });

const S = (vocalMain) => [
  { bars: 16, kick: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: vocalMain },
  { bars: 8, pad: true, vocal: vocalMain },
  { bars: 16, kick: true, bass: true, pad: true },
  { bars: 16, kick: true },
];

const songs = [
  ['Testband - Nachtfahrt', 124, 57, true],
  ['Testband - Kaltstart', 126, 64, false],
  ['Beispiel - Hallenlicht', 128, 59, true],
  ['Beispiel - Langsam', 98, 62, true],
  ['Demo - Schleife', 127, 52, false],
];

function wav(L, R, sr) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 30000))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 30000))), 46 + i * 4);
  }
  return buf;
}

for (const [name, bpm, root, vocal] of songs) {
  const s = synthSong({ bpm, root, sr: 44100, offset: 0.05, sections: S(vocal), seed: bpm });
  await writeFile(join(out, `${name}.wav`), wav(s.L, s.R, s.sr));
  console.log('geschrieben:', name);
}
