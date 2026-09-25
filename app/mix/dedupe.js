// Gleicher Song in mehreren Playlists (z. B. "Banger" und "Silvester 2024"): beim gemeinsamen Laden
// nur einmal in die Queue. Erkannt an Interpret + Titel (ohne Klammer-Zusätze) und gleicher Länge.

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export function songKey(t) {
  const artist = norm(t.artist).split(' ').slice(0, 2).join(' ');
  return `${artist}|${norm(t.title)}`;
}

/** Liefert { tracks, dropped }: die erste Fassung jedes Songs bleibt, weitere gleiche fallen raus. */
export function dedupeTracks(list) {
  const seen = new Map();
  const tracks = [];
  const dropped = [];
  for (const t of list) {
    const k = songKey(t);
    const dur = t.analysis?.duration ?? 0;
    const twins = seen.get(k) || [];
    if (k !== '|' && twins.some((d) => Math.abs(d - dur) < 4)) {
      dropped.push(t);
      continue;
    }
    seen.set(k, [...twins, dur]);
    tracks.push(t);
  }
  return { tracks, dropped };
}
