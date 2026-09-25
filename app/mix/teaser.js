// Teaser: Gegen Ende des laufenden Tracks spielt der DJ einmal kurz den Hook des nächsten Tracks
// an – 2 Takte, im Takt, ohne Bass, an einer Stelle, an der der alte Track gerade Luft lässt
// (Break, Instrumental-Teil, keine Stimme). Danach läuft der alte weiter, der Übergang kommt später.

const at = (arr, i, d = 0) => (arr && i >= 0 && i < arr.length && Number.isFinite(arr[i]) ? arr[i] : d);
const mean = (arr, b0, b1, d = 0) => {
  let s = 0;
  let n = 0;
  for (let i = Math.floor(b0); i < b1; i++) {
    s += at(arr, i, d);
    n++;
  }
  return n ? s / n : d;
};

function labelAt(t, bar) {
  let lab = 'intro';
  for (const ph of t.phrases || []) if (ph.bar <= bar) lab = ph.label;
  return lab;
}

/** Wiedererkennbarste Stelle des neuen Tracks: erster Refrain/Hook, sonst erste Zeile, sonst Drop. */
export function teaserSource(b) {
  const start = b.points?.startBar ?? 0;
  for (const ph of b.phrases || []) {
    if (ph.bar < start + 8) continue;
    if (ph.label === 'main' && ph.vocal >= 0.4 && ph.energy > -3) return { bar: ph.bar, what: 'Refrain' };
  }
  if (b.points?.vocalFirst !== null && b.points?.vocalFirst !== undefined) {
    return { bar: Math.floor(b.points.vocalFirst / 4) * 4, what: 'erste Zeile' };
  }
  if (b.points?.dropBar !== undefined) return { bar: b.points.dropBar, what: 'Drop' };
  return null;
}

/**
 * Sucht die Teaser-Stelle im alten Track `a` vor dem geplanten Ausstieg `outBar`.
 * Liefert { bar, bars, inFrom, what } (Takte des alten Tracks, inFrom = Takt im neuen) oder null.
 */
export function planTeaser(a, b, outBar, nowBar, bars = 2, minScore = 0.6) {
  const src = teaserSource(b);
  if (!src) return null;
  const off = a.phraseOffset || 0;
  let best = null;
  const from = Math.max(Math.ceil(nowBar) + 4, outBar - 40);
  for (let end = outBar - 8; end >= from + bars; end--) {
    if ((((end - off) % 4) + 4) % 4 !== 0) continue; // endet genau auf einer 4er-Grenze
    const b0 = end - bars;
    const vocal = mean(a.vocals, b0 - 1, end + 1);
    if (vocal >= 0.35) continue; // nie über eine Stimme des alten Tracks
    const energy = mean(a.barEnergy, b0, end, -6);
    const drums = mean(a.barDrums, b0, end, 0.5);
    const lab = labelAt(a, b0);
    if (lab === 'main' && energy > -2 && drums > 0.6) continue; // nicht mitten in den vollen Drop
    let sc = 1 - vocal * 2;
    if (lab === 'break') sc += 0.8;
    else if (lab === 'build' || lab === 'intro') sc += 0.3;
    if ((((end - off) % 8) + 8) % 8 === 0) sc += 0.3; // Phrasenende
    sc -= Math.max(0, energy + 3) * 0.1; // lieber in ruhigere Stellen
    sc -= Math.abs(outBar - end - 16) * 0.01; // grob 16 Takte vor dem Übergang ist ideal
    if (!best || sc > best.sc) best = { sc, bar: b0, bars, inFrom: src.bar, what: src.what };
  }
  return best && best.sc > minScore ? best : null;
}
