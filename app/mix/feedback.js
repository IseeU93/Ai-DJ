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

/** Gründe für ein 👎 bei der Reihenfolge ("passte der Song an diese Stelle?"). */
export const ORDER_REASONS = {
  energy: 'Energie passt nicht',
  style: 'Stil passt nicht',
  tempo: 'Tempo-Sprung',
};

/** Gründe für ein 👎 bei der Lasershow. */
export const LASER_REASONS = {
  hectic: 'zu hektisch',
  boring: 'zu langweilig',
  mismatch: 'passt nicht zur Musik',
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
  const all = entries;
  entries = entries.filter((e) => !e.kind || e.kind === 'transition');
  const recent = entries.slice(-120);
  const trackCount = {}; // Gründe pro Song: "zu früh" bei Song X heißt nicht "überall zu früh"
  const add = (k, v) => (bias[k] = (bias[k] ?? 0) + v);
  recent.forEach((e, i) => {
    const w = 0.5 + (0.5 * (i + 1)) / recent.length; // neuere stärker
    const d = (e.verdict === 'up' ? 0.15 : -0.25) * w;
    // Ein Übergang gilt vor allem für genau diese Songs – allgemein nur schwach
    add(e.type, (e.outId ? 0.4 : 1) * d);
    add(`${e.type}@${e.genres?.[0]}>${e.genres?.[1]}`, (e.outId ? 0.8 : 1.5) * d);
    // konsequent pro Song: was bei diesem Song (und genau diesem Paar) schlecht war, kommt nicht wieder
    if (e.outId) add(`${e.type}#out:${e.outId}`, 4 * d);
    if (e.inId) add(`${e.type}#in:${e.inId}`, 3 * d);
    if (e.outId && e.inId) add(`${e.type}#pair:${e.outId}>${e.inId}`, 8 * d);
    for (const r of e.reasons || []) {
      count[r] = (count[r] ?? 0) + (e.outId ? 0.4 : 1) * w;
      // Gründe gelten für den alten Song; "zu hart"/"passt nicht" auch für den neuen
      const ids = [e.outId, ...(['hard', 'mismatch', 'vocals'].includes(r) ? [e.inId] : [])].filter(Boolean);
      for (const id of ids) {
        const tc = (trackCount[id] ||= {});
        tc[r] = (tc[r] ?? 0) + w;
      }
    }
  });
  for (const k of Object.keys(bias)) bias[k] = clamp(bias[k], k.includes('#') ? -5 : -1.5, k.includes('#') ? 1.5 : 0.8);
  const tuneOf = (cnt) => {
    const c = (k) => cnt[k] ?? 0;
    return {
      lengthScale: clamp(1 - 0.08 * c('long') + 0.08 * c('short'), 0.55, 1.5),
      exitShift: clamp(0.15 * (c('early') - c('late')), -0.8, 0.8),
      hardness: clamp(0.3 * c('hard') + 0.15 * c('mismatch'), 0, 2),
    };
  };
  const tune = tuneOf(count);
  const trackTune = {};
  for (const [id, cnt] of Object.entries(trackCount)) trackTune[id] = tuneOf(Object.fromEntries(Object.entries(cnt).map(([k, v]) => [k, 2 * v])));
  return { bias, tune, trackTune, n: entries.length, trick: learnFreestyle(all), laser: learnLaser(all), order: learnOrder(all) };
}

/**
 * Freestyle-Tricks und Teaser: Gewicht pro Trick (Multiplikator auf seine Häufigkeit) und eine
 * Verschiebung der Teaser-Schwelle (👍 -> öfter und an mehr Stellen, 👎 -> seltener bis aus).
 */
export function learnFreestyle(entries = loadFeedback()) {
  const list = entries.filter((e) => e.kind === 'trick').slice(-120);
  const sum = {};
  let teaser = 0;
  list.forEach((e, i) => {
    const w = 0.5 + (0.5 * (i + 1)) / list.length;
    if (e.trick === 'teaser') teaser += (e.verdict === 'up' ? -0.1 : 0.2) * w;
    else sum[e.trick] = (sum[e.trick] ?? 0) + (e.verdict === 'up' ? 0.3 : -0.5) * w;
  });
  const weights = {};
  for (const [k, v] of Object.entries(sum)) weights[k] = clamp(Math.exp(v), 0.03, 3);
  return { weights, teaserShift: clamp(teaser, -0.4, 1.2), n: list.length };
}

/**
 * Reihenfolge: "Passte dieser Song nach dem vorigen?" – gute/schlechte Paare (gilt leicht auch
 * andersherum) und wie stark Energie, Stil und Tempo beim Sortieren zählen.
 */
export function learnOrder(entries = loadFeedback()) {
  const list = entries.filter((e) => e.kind === 'order' && e.a && e.b).slice(-200);
  const pairs = {};
  const features = {};
  const count = {};
  const add = (k, v) => (pairs[k] = (pairs[k] ?? 0) + v);
  const feat = (k, v) => (features[k] = (features[k] ?? 0) + v);
  const eraB = (a, b) => (a && b ? (Math.abs(a - b) >= 25 ? 'far' : Math.abs(a - b) >= 12 ? 'mid' : 'near') : null);
  const danceB = (a, b) => (Math.abs(a - b) >= 0.35 ? 'far' : Math.abs(a - b) >= 0.18 ? 'mid' : 'near');
  for (const e of list) {
    const d = e.verdict === 'up' ? -0.6 : 2; // Kosten: negativ = gutes Paar; 👎 wiegt schwer
    add(`${e.a}>${e.b}`, d);
    add(`${e.b}>${e.a}`, 0.5 * d);
    // verallgemeinern: ähnliche Paare (Familie, Richtung, Epoche, Energie) bekommen einen Teil davon
    const fa = e.fa;
    const fb = e.fb;
    if (fa && fb) {
      const g = 0.25 * d;
      if (fa.fam !== fb.fam) feat(`fam:${fa.fam}>${fb.fam}`, g * 1.4);
      if (fa.genre && fb.genre && fa.genre !== fb.genre) feat(`gen:${fa.genre}>${fb.genre}`, g);
      const era = eraB(fa.year, fb.year);
      if (era && era !== 'near') feat(`era:${era}`, g * (e.reasons?.includes('style') ? 1.2 : 0.8));
      const dance = danceB(fa.dance, fb.dance);
      if (dance !== 'near') feat(`dance:${dance}`, g * (e.reasons?.includes('energy') ? 1.5 : 0.8));
    }
    for (const r of e.reasons || []) count[r] = (count[r] ?? 0) + 1;
  }
  for (const k of Object.keys(pairs)) pairs[k] = clamp(pairs[k], -2, 6);
  for (const k of Object.keys(features)) features[k] = clamp(features[k], -0.6, 2);
  const c = (k) => count[k] ?? 0;
  return {
    pairs,
    features,
    weights: {
      energy: clamp(1 + 0.12 * c('energy'), 1, 2.5),
      genre: clamp(1 + 0.12 * c('style'), 1, 2.5),
      tempo: clamp(1 + 0.12 * c('tempo'), 1, 2.5),
    },
    n: list.length,
  };
}

/**
 * Lasershow: Bewertung pro Effekt (auch pro Musikrichtung und Abschnitt), dazu Tempo und
 * Intensität aus "zu hektisch" / "zu langweilig".
 */
export function learnLaser(entries = loadFeedback()) {
  const list = entries.filter((e) => e.kind === 'laser').slice(-150);
  const scores = {};
  const count = {};
  const add = (k, v) => (scores[k] = (scores[k] ?? 0) + v);
  list.forEach((e, i) => {
    const w = 0.5 + (0.5 * (i + 1)) / list.length;
    const d = (e.verdict === 'up' ? 0.3 : -0.5) * w;
    add(e.effect, d);
    add(`${e.effect}@${e.genre}`, 1.5 * d);
    add(`${e.effect}@${e.phase}`, 1.2 * d);
    if (e.overlay && e.verdict === 'down') add(e.overlay, 0.5 * d);
    for (const r of e.reasons || []) count[r] = (count[r] ?? 0) + w;
  });
  for (const k of Object.keys(scores)) scores[k] = clamp(scores[k], -2, 1.5);
  const c = (k) => count[k] ?? 0;
  return {
    scores,
    speedScale: clamp(1 - 0.08 * c('hectic') + 0.08 * c('boring'), 0.6, 1.4),
    intensityShift: clamp(-0.08 * c('hectic') + 0.08 * c('boring'), -0.4, 0.4),
    n: list.length,
  };
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
