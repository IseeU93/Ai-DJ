// Set-Reihenfolge: harmonisch (Camelot), tempo-kompatibel, mit Energie-Bogen über das Set.

export function parseCamelot(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? { n: +m[1], letter: m[2] } : null;
}

/** 0 = perfekt, ~0.1 Nachbar, 0.15 Parallel-Dur/Moll, bis 1 = Clash. */
export function camelotDistance(a, b) {
  const x = parseCamelot(a);
  const y = parseCamelot(b);
  if (!x || !y) return 0.5;
  const step = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.letter === y.letter) {
    if (step === 0) return 0;
    if (step === 1) return 0.1;
    if (step === 2) return 0.4; // "Energy Boost" – geht, aber hörbar
    return Math.min(1, 0.5 + step * 0.08);
  }
  if (step === 0) return 0.15;
  if (step === 1) return 0.35; // diagonal
  return Math.min(1, 0.6 + step * 0.07);
}

/**
 * Tempo-Beziehung zwischen zwei Tracks, inkl. Halb-/Doppeltempo.
 * m = Beats des eingehenden Tracks pro Master-Beat (1, 2 oder 0.5); diff = relative Abweichung.
 */
export function tempoRelation(bpmOut, bpmIn) {
  let best = { m: 1, diff: Infinity, pen: Infinity };
  for (const m of [1, 2, 0.5]) {
    const diff = Math.abs((bpmIn / m) / bpmOut - 1);
    // Halb/Doppel nur, wenn es klar besser passt (sonst bleibt der Groove zu verschieden)
    const pen = m === 1 ? diff : diff + 0.02;
    if (pen < best.pen) best = { m, diff, pen };
  }
  return { m: best.m, diff: best.diff };
}

export const BEATMATCH_LIMIT = 0.08; // bis ±8 % wird per Keylock-Tempo angeglichen

export function transitionCost(a, b) {
  const rel = tempoRelation(a.analysis.bpm, b.analysis.bpm);
  const d = rel.diff;
  const tempo = d <= 0.02 ? d * 5 : d <= BEATMATCH_LIMIT ? 0.1 + (d - 0.02) * 8 : 0.7 + (d - BEATMATCH_LIMIT) * 4;
  const key = camelotDistance(a.analysis.key.camelot, b.analysis.key.camelot);
  const energy = Math.abs((a.energy ?? 0.5) - (b.energy ?? 0.5));
  return tempo + 0.8 * key + 0.3 * energy;
}

/** Energie 0..1 pro Track über Ränge (unabhängig von Mastering-Lautheit). */
export function assignEnergy(tracks) {
  const rank = (key) => {
    const sorted = [...tracks].sort((x, y) => key(x) - key(y));
    const r = new Map();
    sorted.forEach((t, i) => r.set(t, sorted.length > 1 ? i / (sorted.length - 1) : 0.5));
    return r;
  };
  const rInt = rank((t) => t.analysis.intensity);
  const rBpm = rank((t) => t.analysis.bpm);
  const rBass = rank((t) => t.analysis.bassWeight);
  const rBright = rank((t) => t.analysis.brightness);
  for (const t of tracks) {
    t.energy = 0.4 * rInt.get(t) + 0.25 * rBpm.get(t) + 0.2 * rBass.get(t) + 0.15 * rBright.get(t);
  }
}

/** Ziel-Energie an Position p (0..1): ruhiger Einstieg, Peak bei ~70 %, leichtes Ausklingen. */
export function targetEnergy(p) {
  return p < 0.7 ? 0.2 + 0.75 * (p / 0.7) : 0.95 - 0.35 * ((p - 0.7) / 0.3);
}

const ARC_WEIGHT = 1.2;

function totalCost(order, fixedPrefix, costCache) {
  const n = order.length;
  let c = 0;
  for (let i = 0; i < n - 1; i++) c += costCache(order[i], order[i + 1]);
  for (let i = fixedPrefix; i < n; i++) {
    const p = n > 1 ? i / (n - 1) : 0;
    c += ARC_WEIGHT * (order[i].energy - targetEnergy(p)) ** 2;
  }
  return c;
}

/**
 * Baut die Reihenfolge. `fixed` = Tracks, die schon gespielt wurden/laufen (bleiben vorne, in Reihenfolge).
 */
export function buildSetOrder(tracks, fixed = []) {
  const pool = tracks.filter((t) => !fixed.includes(t));
  if (pool.length <= 1) return [...fixed, ...pool];

  const cache = new Map();
  const cost = (a, b) => {
    const k = `${a.id}|${b.id}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = transitionCost(a, b);
      cache.set(k, v);
    }
    return v;
  };

  const total = fixed.length + pool.length;
  // Greedy
  const order = [...fixed];
  const remaining = [...pool];
  if (!order.length) {
    remaining.sort((a, b) => a.energy - b.energy);
    order.push(remaining.shift());
  }
  while (remaining.length) {
    const prev = order[order.length - 1];
    const p = total > 1 ? order.length / (total - 1) : 0;
    let best = 0;
    let bestScore = Infinity;
    remaining.forEach((t, i) => {
      const s = cost(prev, t) + ARC_WEIGHT * (t.energy - targetEnergy(p)) ** 2;
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    });
    order.push(remaining.splice(best, 1)[0]);
  }

  // Lokale Verbesserung: 2-opt + Verschieben einzelner Tracks
  const lock = Math.max(1, fixed.length);
  const n = order.length;
  if (n <= 250) {
    let current = totalCost(order, fixed.length, cost);
    let improved = true;
    let rounds = 0;
    while (improved && rounds++ < 30) {
      improved = false;
      for (let i = lock; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          reverse(order, i, j);
          const c = totalCost(order, fixed.length, cost);
          if (c < current - 1e-9) {
            current = c;
            improved = true;
          } else {
            reverse(order, i, j);
          }
        }
      }
      for (let i = lock; i < n; i++) {
        for (let j = lock; j < n; j++) {
          if (i === j) continue;
          const [t] = order.splice(i, 1);
          order.splice(j, 0, t);
          const c = totalCost(order, fixed.length, cost);
          if (c < current - 1e-9) {
            current = c;
            improved = true;
          } else {
            order.splice(j, 1);
            order.splice(i, 0, t);
          }
        }
      }
    }
  }
  return order;
}

function reverse(a, i, j) {
  while (i < j) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
    i++;
    j--;
  }
}
