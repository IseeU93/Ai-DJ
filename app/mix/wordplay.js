// Wortspiel-Suche: gleiche Wörter oder Reime am Zeilenende des alten und am Zeilenanfang des
// neuen Tracks. Reines JS (testbar in Node).

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'i', 'you', 'me', 'my', 'we', 'it', 'is', 'be', 'so', 'oh', 'yeah', 'uh',
  'der', 'die', 'das', 'und', 'oder', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'ein', 'eine', 'in', 'im', 'zu', 'mit', 'ja', 'nein', 'yo',
]);

export function normWord(w) {
  return w.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}']/gu, '');
}

/** Reim-Schlüssel: letzte Vokalgruppe + folgende Konsonanten ("tonight" -> "ight"). */
export function rhymeKey(w) {
  const m = /[aeiouyäöü]+[^aeiouyäöü]*$/.exec(normWord(w));
  return m ? m[0] : '';
}

const GAP = 0.3; // Sekunden Pause, die eine Zeile begrenzt

/**
 * @returns Kandidaten [{ out, in, kind: 'gleich'|'Reim', score }] – bestes zuerst.
 *   out = Wort am Ende einer Zeile im alten Track, in = Wort am Anfang einer Zeile im neuen.
 */
export function findWordplay(outWords, inWords) {
  const lineEnds = outWords.filter((w, i) => {
    const next = outWords[i + 1];
    return !next || next.start - w.end >= GAP;
  });
  const lineStarts = inWords.filter((w, i) => {
    const prev = inWords[i - 1];
    return !prev || w.start - prev.end >= GAP;
  });
  const out = [];
  for (const wo of lineEnds) {
    const no = normWord(wo.text);
    if (no.length < 3) continue;
    for (const wi of lineStarts) {
      const ni = normWord(wi.text);
      if (ni.length < 3) continue;
      let kind = null;
      let score = 0;
      if (no === ni) {
        kind = 'gleich';
        score = 1;
      } else if (rhymeKey(no) && rhymeKey(no) === rhymeKey(ni) && rhymeKey(no).length >= 2) {
        kind = 'Reim';
        score = 0.6;
      }
      if (!kind) continue;
      if (STOP.has(no) || STOP.has(ni)) score -= 0.5;
      score += Math.min(0.2, (no.length - 3) * 0.05);
      out.push({ out: wo, in: wi, kind, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
