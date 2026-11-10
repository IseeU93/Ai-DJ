// Rhythmus-Muster eines Songs: wo im Takt (16 Schritte) setzt der Bass/die Kick ein?
// Gelesen aus der schon vorhandenen Tiefband-Wellenform (100 Spalten/s) – keine neue Analyse nötig.
// Zwei Songs greifen ineinander, wenn ihre Muster ähnlich sind (Kick auf jedem Schlag gegen
// Kick auf 1 und 3 oder synkopiert → die Beats stolpern übereinander, auch bei gleichem Tempo).

const STEPS = 16;
const cache = new WeakMap();

const beatTime = (a, i) => {
  if (a.beats?.length) {
    const n = a.beats.length;
    if (i < 0) return a.beats[0] + i * a.beatInterval;
    if (i >= n - 1) return a.beats[n - 1] + (i - (n - 1)) * a.beatInterval;
    const f = Math.floor(i);
    return a.beats[f] + (i - f) * (a.beats[f + 1] - a.beats[f]);
  }
  return (a.firstBeat ?? 0) + i * a.beatInterval;
};

/** Anschlagsstärke (Anstieg im Tiefband) an 16 Stellen eines Takts; null, wenn nichts zu lesen ist. */
function barOnsets(a, bar) {
  const w = a.waveform;
  if (!w?.low?.length || !w.rate || a.downbeat === undefined || !a.beatInterval) return null;
  const low = w.low;
  const out = new Float32Array(STEPS);
  const at = (c) => low[Math.max(0, Math.min(low.length - 1, c))];
  for (let k = 0; k < STEPS; k++) {
    const t = beatTime(a, a.downbeat + 4 * bar + k / 4);
    const c = Math.round(t * w.rate);
    // Anstieg: Spitze kurz nach dem Schritt gegen den Pegel kurz davor (±40 ms Toleranz)
    let peak = 0;
    for (let d = 0; d <= 4; d++) peak = Math.max(peak, at(c + d));
    out[k] = Math.max(0, peak - Math.max(at(c - 4), at(c - 3)));
  }
  return out;
}

const normalize = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  if (s < 1e-6) return null;
  const n = Math.sqrt(s);
  return v.map((x) => x / n);
};

/** Mittleres Muster der Takte [from, to). */
export function patternAt(a, from, to) {
  const sum = new Float32Array(STEPS);
  let n = 0;
  for (let b = Math.max(0, Math.floor(from)); b < Math.max(Math.floor(from) + 1, Math.ceil(to)); b++) {
    const o = barOnsets(a, b);
    if (!o) continue;
    // (jeder Takt gleich schwer: sonst bestimmt der lauteste Takt allein)
    const nz = normalize(o);
    if (!nz) continue;
    for (let k = 0; k < STEPS; k++) sum[k] += nz[k];
    n++;
  }
  return n ? normalize(sum) : null;
}

/** Typisches Muster des Hauptteils (für die Reihenfolge – einmal pro Song gerechnet). */
export function globalPattern(a) {
  if (cache.has(a)) return cache.get(a);
  let p = null;
  try {
    const first = a.points?.dropBar ?? a.points?.startBar ?? 0;
    const last = Math.min(a.points?.lastBar ?? first + 32, first + 48);
    p = last > first ? patternAt(a, first, last) : null;
  } catch {
    p = null;
  }
  cache.set(a, p);
  return p;
}

/** Ähnlichkeit zweier Muster, 0..1 (null = nicht lesbar). */
export function similarity(p, q) {
  if (!p || !q) return null;
  let s = 0;
  for (let k = 0; k < STEPS; k++) s += p[k] * q[k];
  return Math.max(0, Math.min(1, s));
}
