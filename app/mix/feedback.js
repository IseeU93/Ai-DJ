// Lernen aus deinen Bewertungen: Nach jedem Übergang 👍/👎 (+ Grund). Daraus werden Vorlieben pro
// Technik (auch pro Genre-Paar) und ein paar Stellschrauben abgeleitet, die der Planer berücksichtigt.
// Alles bleibt lokal (localStorage); das Protokoll lässt sich als Text kopieren und weitergeben.

const STORE = 'automix.feedback';
const MAX = 400;

export const REASONS = {
  early: 'zu früh',
  late: 'zu spät',
  hard: 'zu hart',
  long: 'zu lang',
  short: 'zu kurz',
  vocals: 'Gesang überlappt',
  offbeat: 'nicht im Takt',
  mismatch: 'passt nicht zusammen',
};

export function loadFeedback() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || [];
  } catch {
    return [];
  }
}

export function addFeedback(entry) {
  const all = loadFeedback();
  all.push({ time: Date.now(), ...entry });
  while (all.length > MAX) all.shift();
  try {
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* voll/privat – egal */
  }
  return all;
}

export function clearFeedback() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* egal */
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Aus den Bewertungen: bias (Zuschlag pro Technik bzw. Technik@Genre-Paar) und tune
 * (lengthScale, exitShift, hardness). Neuere Bewertungen zählen mehr.
 */
export function learn(entries = loadFeedback()) {
  const bias = {};
  const count = {};
  const recent = entries.slice(-120);
  recent.forEach((e, i) => {
    const w = 0.5 + (0.5 * (i + 1)) / recent.length; // neuere stärker
    const d = (e.verdict === 'up' ? 0.15 : -0.25) * w;
    bias[e.type] = (bias[e.type] ?? 0) + d;
    const pair = `${e.type}@${e.genres?.[0]}>${e.genres?.[1]}`;
    bias[pair] = (bias[pair] ?? 0) + 1.5 * d;
    for (const r of e.reasons || []) count[r] = (count[r] ?? 0) + w;
  });
  for (const k of Object.keys(bias)) bias[k] = clamp(bias[k], -1.2, 0.6);
  const c = (k) => count[k] ?? 0;
  const tune = {
    lengthScale: clamp(1 - 0.08 * c('long') + 0.08 * c('short'), 0.55, 1.5),
    exitShift: clamp(0.15 * (c('early') - c('late')), -0.8, 0.8),
    hardness: clamp(0.2 * c('hard'), 0, 1.2),
  };
  return { bias, tune, n: entries.length };
}

/** Kurzfassung für die Anzeige: was hat die App aus deinen Bewertungen gelernt? */
export function describeLearned({ bias, tune, n }, names) {
  if (!n) return 'noch keine Bewertungen';
  const parts = [];
  const styles = Object.entries(bias).filter(([k]) => !k.includes('@')).sort((x, y) => y[1] - x[1]);
  const liked = styles.filter(([, v]) => v > 0.1).slice(0, 2).map(([k]) => names[k] || k);
  const disliked = styles.filter(([, v]) => v < -0.1).slice(-2).map(([k]) => names[k] || k);
  if (liked.length) parts.push(`mehr ${liked.join(', ')}`);
  if (disliked.length) parts.push(`weniger ${disliked.join(', ')}`);
  if (tune.lengthScale < 0.95) parts.push('kürzere Übergänge');
  if (tune.lengthScale > 1.05) parts.push('längere Übergänge');
  if (tune.exitShift > 0.1) parts.push('später aussteigen');
  if (tune.exitShift < -0.1) parts.push('früher aussteigen');
  if (tune.hardness > 0.1) parts.push('weniger harte Schnitte');
  return `${n} Bewertungen – ${parts.join(', ') || 'noch keine klare Tendenz'}`;
}
