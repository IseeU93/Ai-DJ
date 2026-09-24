// Musikrichtung: automatische Einordnung + Übergangs-Profile je Richtung.

export const GENRES = {
  pop: 'Pop',
  rap: 'Rap',
  edm: 'House/EDM',
  hardstyle: 'Hardstyle',
  uptempo: 'Uptempo',
};

/**
 * Schätzt die Musikrichtung aus der Analyse. Heuristik über Tempo, "Four-on-the-floor"
 * (Kick auf jedem Schlag), Bassanteil und Gesangsdichte – keine Magie, aber für die
 * Wahl der Mix-Technik gut genug; lässt sich pro Track/Ordner überschreiben.
 */
export function detectGenre(a) {
  const bpm = a.bpm;
  const ff = a.fourFloor ?? 0.5;
  const voc = a.vocals?.length ? Array.from(a.vocals).reduce((s, v) => s + v, 0) / a.vocals.length : 0;
  const bass = a.bassWeight ?? -10;
  if (bpm >= 165 && ff >= 0.6) return 'uptempo';
  if (bpm >= 142 && bpm < 165 && ff >= 0.6 && bass > -12) return 'hardstyle';
  if (ff < 0.55 && voc >= 0.25 && (bpm < 108 || bpm >= 130)) return 'rap';
  if (ff >= 0.6 && bpm >= 115 && bpm < 142) return 'edm';
  return 'pop';
}

/**
 * Übergangs-Profile:
 *  lengths  – erlaubte Überlappungen (Takte)
 *  swap     – Dauer des Bass-/Kick-Wechsels (Takte)
 *  styles   – Vorlieben je Technik (Zuschlag auf die Bewertung)
 *  vocal    – wie stark Gesang geschützt wird
 */
export const PROFILES = {
  edm: { lengths: [32, 16, 8], swap: 0.25, vocal: 1, styles: { blend: 0.2, filter: 0.1, loop: 0.1, vocal: 0, handoff: -0.2, cut: -0.4, echo: -0.3 } },
  pop: { lengths: [16, 8], swap: 0.5, vocal: 1.6, styles: { blend: 0.1, filter: 0.15, vocal: 0.15, handoff: 0.35, loop: -0.4, cut: -0.1, echo: -0.3 } },
  hardstyle: { lengths: [8, 4], swap: 0.25, vocal: 1.2, styles: { blend: 0.1, filter: 0, loop: -0.3, vocal: -0.5, cut: 0.35, echo: -0.2 } },
  uptempo: { lengths: [8, 4], swap: 0.25, vocal: 1, styles: { blend: 0, filter: -0.1, loop: -0.4, vocal: -0.6, cut: 0.5, echo: -0.2 } },
  rap: { lengths: [8, 4], swap: 0.5, vocal: 2, styles: { blend: -0.1, filter: 0.1, handoff: 0.5, loop: -0.5, vocal: -0.4, cut: 0.45, echo: -0.2 } },
};

/** Profil für einen Übergang zwischen zwei Richtungen (das vorsichtigere gewinnt). */
export function combineProfiles(gOut, gIn) {
  const a = PROFILES[gOut] || PROFILES.pop;
  const b = PROFILES[gIn] || PROFILES.pop;
  const maxL = Math.min(Math.max(...a.lengths), Math.max(...b.lengths));
  const styles = {};
  for (const k of new Set([...Object.keys(a.styles), ...Object.keys(b.styles)])) {
    styles[k] = ((a.styles[k] ?? 0) + (b.styles[k] ?? 0)) / 2;
  }
  // Richtungswechsel (z. B. Pop -> Hardstyle): lieber klarer, kurzer Wechsel
  if (gOut !== gIn) styles.cut = (styles.cut ?? 0) + 0.15;
  return {
    lengths: [32, 16, 8, 4].filter((x) => x <= maxL && x >= Math.min(maxL, Math.max(Math.min(...a.lengths), Math.min(...b.lengths)))),
    swap: Math.max(a.swap, b.swap),
    vocal: Math.max(a.vocal, b.vocal),
    styles,
  };
}
