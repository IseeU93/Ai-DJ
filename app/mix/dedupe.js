// Gleicher Song in mehreren Playlists (z. B. "Banger" und "Silvester 2024"): beim gemeinsamen Laden
// nur einmal in die Queue. Erkannt an denselben Wörtern in Interpret + Titel (ohne Klammer-Zusätze).

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Liefert { tracks, dropped }: die erste Fassung jedes Songs bleibt, weitere Dateien desselben Songs
 * (auch andere Fassung wie Radio Edit/Lyrics-Video/ohne Tags) fallen raus. Remixe mit eigenem Namen
 * ("… - Noiseflow Remix") zählen als eigener Song.
 */
export function dedupeTracks(list, priority = () => 0) {
  // je Song die bevorzugte Fassung (höchste Priorität, sonst die erste) – an der Stelle der ersten
  const best = new Map();
  for (const t of list) {
    const k = looseKey(t);
    const cur = best.get(k);
    if (!cur || priority(t) > priority(cur)) best.set(k, t);
  }
  const done = new Set();
  const tracks = [];
  const dropped = [];
  for (const t of list) {
    const k = looseKey(t);
    if (!k) {
      tracks.push(t);
      continue;
    }
    if (done.has(k)) {
      if (best.get(k) !== t) dropped.push(t);
      continue;
    }
    done.add(k);
    const keep = best.get(k);
    tracks.push(keep);
    if (keep !== t) dropped.push(t);
  }
  return { tracks, dropped };
}

/**
 * Lockerer Schlüssel: dieselben Wörter aus Interpret + Titel, egal in welcher Reihenfolge und welche
 * Fassung ("Starships.mp3" mit Tags und "Starships - Nicki Minaj (Lyrics).wav" ohne Tags).
 */
export function looseKey(t) {
  const words = norm(`${t.artist || ''} ${t.title || ''}`).split(' ')
    .filter((w) => w.length > 1 && !['feat', 'ft', 'the', 'radio', 'edit', 'version', 'mix', 'remastered', 'lyrics', 'official'].includes(w));
  return [...new Set(words)].sort().join(' ');
}
