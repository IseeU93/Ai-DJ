import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { combineGenre, styleOf, cleanName, trackKey } = await import('../app/lib/webgenre.js');
const { fromFilename } = await import('../app/lib/metadata.js');

const tags = (list) => list.map(([name, count]) => ({ name, count }));

test('Online-Genre: Familie aus dem Netz, Feinheiten aus dem Audio', () => {
  const nicki = tags([['hip hop', 7], ['pop', 5], ['electronic', 4], ['pop rap', 4], ['2010s', 2], ['sxsw', 1]]);
  // "Rap"-Interpretin, aber Four-on-the-floor bei 125 BPM -> Dance-Pop
  const star = combineGenre({ bpm: 125, fourFloor: 0.8, vocals: [0.6] }, { itunes: 'Hip-Hop/Rap', tags: nicki });
  assert.equal(star.genre, 'pop');
  assert.equal(styleOf({ itunes: 'Hip-Hop/Rap', tags: nicki }, star.genre), 'Pop');
  // echter Rap bleibt Rap
  assert.equal(combineGenre({ bpm: 92, fourFloor: 0.3, vocals: [0.8] }, { itunes: 'Hip-Hop/Rap', tags: nicki }).genre, 'rap');
  // harte Familie: Tempo entscheidet zwischen Hardstyle und Uptempo
  const hard = { itunes: 'Hardcore', tags: tags([['hardcore', 7], ['gabber', 6]]) };
  assert.equal(combineGenre({ bpm: 200, fourFloor: 0.9 }, hard).genre, 'uptempo');
  assert.equal(combineGenre({ bpm: 150, fourFloor: 0.9, bassWeight: -6 }, { itunes: 'Dance', tags: tags([['hardstyle', 5]]) }).genre, 'hardstyle');
  // Schlager bleibt Pop, Stil "German Pop"
  const helene = { itunes: 'German Pop', tags: tags([['schlager', 4], ['german', 3], ['pop', 1]]) };
  const h = combineGenre({ bpm: 128, fourFloor: 0.8, vocals: [0.7] }, helene);
  assert.equal(h.genre, 'pop');
  assert.equal(styleOf(helene, h.genre), 'German Pop');
  assert.equal(combineGenre({ bpm: 123, fourFloor: 0.9 }, { itunes: 'Dance', tags: tags([['electronic', 40], ['house', 20]]) }).genre, 'edm');
});

test('Titel säubern: Download-Seiten, (Lyrics), Emojis; Schlüssel unabhängig von der Reihenfolge', () => {
  assert.equal(cleanName('Starships - Nicki Minaj (Lyrics) 🎵'), 'Starships - Nicki Minaj');
  assert.equal(cleanName('SpotiDownloader.com One More Time'), 'One More Time');
  assert.deepEqual(fromFilename('SpotiDownloader.com - One More Time - Daft Punk.mp3'), { artist: 'One More Time', title: 'Daft Punk' });
  assert.equal(trackKey({ artist: 'Daft Punk', title: 'One More Time' }), trackKey({ artist: 'One More Time', title: 'Daft Punk' }));
  assert.equal(trackKey({ artist: 'Beyoncé', title: 'Crazy in Love (Official Video)' }), 'beyonce crazy in love');
});
