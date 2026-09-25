import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWish, pickWish } from '../app/mix/wish.js';

const mk = (id, genre, extra = {}, info = {}) => ({
  id, title: id, artist: info.artist || '', genre, energy: extra.energy ?? 0.5, style: info.style, webInfo: info.web,
  analysis: { bpm: extra.bpm ?? 124, key: { camelot: '8A' }, gridConfidence: extra.grid ?? 0.9, fourFloor: extra.ff ?? 0.8, pulse: extra.pulse ?? 9, points: { dropBar: 16, startBar: 0, lastBar: 90 } },
});

test('Musikwunsch: Text wird verstanden', () => {
  const w = parseWish('bitte mal was Ruhigeres, gerne Schlager');
  assert.equal(w.mood, -1);
  assert.equal(w.styles[0].word, 'schlager');
  assert.deepEqual([...parseWish('Hip Hop und härter').genres], ['rap']);
  assert.equal(parseWish('härter').energy, 1);
  assert.equal(parseWish('schneller').tempo, 1);
  assert.equal(parseWish('so um 130 bpm').bpm, 130);
  assert.deepEqual(parseWish('Helene Fischer').terms, ['helene', 'fischer']);
  assert.ok(parseWish('bitte mal').empty);
});

test('Musikwunsch: passende Songs, gut mixbar sortiert', () => {
  const cur = mk('jetzt', 'pop', { energy: 0.6 });
  const tracks = [
    mk('ballade', 'pop', { grid: 0.15, ff: 0.5, pulse: 5, energy: 0.2 }),
    mk('party1', 'pop', { energy: 0.8 }),
    mk('helene', 'pop', { energy: 0.6 }, { artist: 'Helene Fischer', style: 'German Pop', web: { itunes: 'Schlager', tags: [{ name: 'schlager', count: 4 }] } }),
    mk('uptempo', 'uptempo', { bpm: 200, energy: 1 }),
    mk('rap', 'rap', { bpm: 92, ff: 0.3, energy: 0.5 }),
  ];
  assert.equal(pickWish(tracks, parseWish('was ruhiges'), cur)[0].id, 'ballade');
  assert.deepEqual(pickWish(tracks, parseWish('Schlager'), cur).map((t) => t.id), ['helene']);
  assert.deepEqual(pickWish(tracks, parseWish('Helene Fischer'), cur).map((t) => t.id), ['helene']);
  assert.deepEqual(pickWish(tracks, parseWish('Hip-Hop'), cur).map((t) => t.id), ['rap']);
  // härter: der härteste Song ist dabei; die Reihenfolge steigert sich (erst gut anschließend, dann härter)
  const hard = pickWish(tracks, parseWish('härter'), cur).map((t) => t.id);
  assert.ok(hard.includes('uptempo') && !hard.includes('ballade'), hard.join());
  assert.ok(hard.indexOf('uptempo') >= hard.indexOf('party1'), hard.join());
  assert.ok(!pickWish(tracks, parseWish('ruhig'), cur).some((t) => t.id === 'uptempo'));
  assert.deepEqual(pickWish(tracks, parseWish('Reggae'), cur), []);
});

test('Doppelte Songs aus mehreren Playlists nur einmal', async () => {
  const { dedupeTracks } = await import('../app/mix/dedupe.js');
  const t = (id, artist, title, duration) => ({ id, artist, title, analysis: { duration } });
  const { tracks, dropped } = dedupeTracks([
    t('Banger/Mr. Brightside', 'The Killers', 'Mr. Brightside', 224),
    t('Silvester/Mr. Brightside', 'The Killers', 'Mr. Brightside', 224),
    t('Anfang/Mr Brightside (Lyrics)', 'The Killers', 'Mr Brightside', 223),
    t('Banger/Titanium', 'David Guetta, Sia', 'Titanium', 246),
    t('Silvester/Titanium (feat. Sia)', 'David Guetta, Sia', 'Titanium (feat. Sia)', 245),
    t('x/Radio Edit', 'Artist', 'Song', 180),
    t('y/Extended', 'Artist', 'Song', 330), // andere Fassung (viel länger) bleibt
  ]);
  assert.deepEqual(tracks.map((x) => x.id), ['Banger/Mr. Brightside', 'Banger/Titanium', 'x/Radio Edit', 'y/Extended']);
  assert.equal(dropped.length, 3);
});
