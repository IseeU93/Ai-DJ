// Abgleich zwischen PC und Handy: Bewertungen (👍/👎 für Übergänge, Reihenfolge, Tricks, Laser)
// wandern in beide Richtungen. Track-Bezüge (outId/inId/a/b = volle Dateipfade) werden dafür relativ
// zum Musik-Ordner geschrieben ("rel:Banger/Mr. Brightside.mp3") und auf der anderen Seite wieder
// zum dortigen Pfad – so gilt eine Bewertung auf beiden Geräten für denselben Song.

const ID_FIELDS = ['outId', 'inId', 'a', 'b'];
const BS = String.fromCharCode(92); // Backslash

const norm = (p) => String(p || '').split(BS).join('/').replace(/\/+$/, '');

/** Voller Pfad -> relativ zum Ordner (oder unverändert, wenn er nicht darin liegt). */
export function toRelative(id, root) {
  if (typeof id !== 'string' || !root) return id;
  const r = `${norm(root)}/`;
  const p = norm(id);
  return p.toLowerCase().startsWith(r.toLowerCase()) ? `rel:${p.slice(r.length)}` : id;
}

/** Relativ -> voller Pfad in diesem Ordner (Trennzeichen wie im Ordner: \ unter Windows). */
export function fromRelative(id, root) {
  if (typeof id !== 'string' || !id.startsWith('rel:') || !root) return id;
  const sep = root.includes(BS) ? BS : '/';
  let base = root;
  while (base.endsWith('/') || base.endsWith(BS)) base = base.slice(0, -1);
  return base + sep + id.slice(4).split('/').join(sep);
}

export function exportFeedback(entries, root) {
  return entries.map((e) => {
    const out = { ...e };
    for (const k of ID_FIELDS) if (k in out) out[k] = toRelative(out[k], root);
    return out;
  });
}

export function importFeedback(entries, root) {
  return (entries || []).map((e) => {
    const out = { ...e };
    for (const k of ID_FIELDS) if (k in out) out[k] = fromRelative(out[k], root);
    return out;
  });
}

const entryKey = (e) => [e.time, e.kind || 'transition', e.verdict, e.type, e.trick, e.effect, e.outId, e.inId, e.a, e.b].map((x) => x ?? '').join('|');

/** Beide Listen zusammenführen: jede Bewertung genau einmal, zeitlich sortiert, höchstens `max`. */
export function mergeFeedback(local, incoming, max = 1000) {
  const seen = new Map();
  for (const e of [...(local || []), ...(incoming || [])]) if (e && e.time) seen.set(entryKey(e), e);
  const all = [...seen.values()].sort((x, y) => x.time - y.time);
  return all.slice(-max);
}
