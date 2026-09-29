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

test('Musikwunsch: Titel oder Party holt keine Uptempo-Tracks in ein Pop-Set', () => {
  const cur = mk('jetzt', 'pop', { energy: 0.6 });
  const tracks = [
    mk('bh', 'pop', { energy: 0.6 }, { artist: 'Taio Cruz' }),
    mk('breakrules', 'uptempo', { bpm: 200, energy: 0.9 }),
    mk('party-uptempo', 'uptempo', { bpm: 190, energy: 0.8, pulse: 12 }),
    mk('party-pop', 'pop', { energy: 0.8, pulse: 12 }),
  ];
  tracks[0].title = 'Break Your Heart';
  tracks[1].title = 'BREAK THE RULES';
  assert.deepEqual(pickWish(tracks, parseWish('Break your heart'), cur).map((t) => t.id), ['bh']);
  assert.ok(!pickWish(tracks, parseWish('Party'), cur).some((t) => ['breakrules', 'party-uptempo'].includes(t.id)));
  // läuft schon harte Musik oder wird danach gefragt, dürfen sie kommen
  assert.ok(pickWish(tracks, parseWish('Uptempo'), cur).some((t) => t.id === 'party-uptempo'));
});

test('Musikwunsch "ruhig": nie Hardstyle/Uptempo, auch wenn der Beat wenig tanzbar wirkt', () => {
  const cur = mk('jetzt', 'pop', { energy: 0.5 });
  // Uptempo-/Hardstyle-Songs mit gebrochenem Beat (niedrige Tanzbarkeit) und ein rasender Pop-Remix
  const tracks = [
    mk('ballade', 'pop', { grid: 0.15, ff: 0.5, pulse: 5, energy: 0.2 }),
    mk('uptempo-gebrochen', 'uptempo', { bpm: 190, grid: 0.2, ff: 0.3, pulse: 4, energy: 0.4 }),
    mk('hardstyle-intro', 'hardstyle', { bpm: 150, grid: 0.2, ff: 0.4, pulse: 4, energy: 0.3 }),
    mk('pop-remix-160', 'pop', { bpm: 160, grid: 0.2, ff: 0.4, pulse: 4, energy: 0.3 }),
  ];
  for (const wish of ['ruhig', 'was ruhiges', 'chillig bitte']) {
    assert.deepEqual(pickWish(tracks, parseWish(wish), cur).map((t) => t.id), ['ballade'], wish);
  }
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
    t('y/Extended', 'Artist', 'Song (Extended Mix)', 330), // andere Fassung desselben Songs: nur einmal
    t('z/Remix', 'Artist', 'Song - Noiseflow Remix', 200), // eigener Remix bleibt
    t('Stimmung/Starships (Lyrics)', 'Starships', 'Nicki Minaj', 229),
    t('Silvester/Starships', 'Nicki Minaj', 'Starships', 210),
  ]);
  assert.deepEqual(tracks.map((x) => x.id), ['Banger/Mr. Brightside', 'Banger/Titanium', 'x/Radio Edit', 'z/Remix', 'Stimmung/Starships (Lyrics)']);
  assert.equal(dropped.length, 5);
});

test('Musikwunsch: derselbe Song aus zwei Ordnern (andere Fassung, ohne Tags) kommt nur einmal', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {} };
  const { Conductor } = await import('../app/mix/conductor.js');
  const c = Object.create(Conductor.prototype);
  const tr = (id, artist, title, dur) => ({ id, artist, title, genre: 'pop', energy: 0.6, analysis: { bpm: 125, duration: dur, key: { camelot: '8A' }, gridConfidence: 0.9, fourFloor: 0.8, points: { dropBar: 16, startBar: 0, lastBar: 90 } } });
  const list = [
    tr('Silvester 2024/Starships.mp3', 'Nicki Minaj', 'Starships', 210),
    tr('Anfang/Other.mp3', 'Someone', 'Other Song', 200),
    tr('Stimmung/Starships - Nicki Minaj (Lyrics).wav', 'Starships', 'Nicki Minaj', 229),
  ];
  Object.assign(c, { tracks: new Map(list.map((t) => [t.id, t])), queue: list.map((t) => t.id), pos: -1, removed: [], pinned: [], played: new Set(), plan: null, emit() {}, invalidatePlan() {} });
  const r = c.applyWish('Starships');
  assert.equal(r.tracks.length, 1);
  assert.equal(c.queue.filter((id) => /starships/i.test(id)).length, 1, c.queue.join(' | '));
});
