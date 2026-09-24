// Set-Reihenfolge: harmonisch (Camelot), tempo-kompatibel, mit Energie-Bogen über das Set.

export function parseCamelot(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? { n: +m[1], letter: m[2] } : null;
}

/** Camelot-Code um `semis` Halbtöne verschieben (1 Halbton = 7 Schritte auf dem Wheel). */
export function shiftCamelot(code, semis) {
  const k = parseCamelot(code);
  if (!k || !semis) return code;
  const n = ((((k.n - 1 + 7 * semis) % 12) + 12) % 12) + 1;
  return `${n}${k.letter}`;
}

/**
 * Bester Key-Sync: um wie viele Halbtöne (±2) muss der neue Track verschoben werden,
 * damit er harmonisch zum alten passt? Liefert { semis, dist }.
 */
export function keySync(outKey, inKey, allow = true) {
  let best = { semis: 0, dist: camelotDistance(outKey, inKey) };
  if (!allow || best.dist < 0.3) return best;
  for (const s of [1, -1, 2, -2]) {
    const dist = camelotDistance(outKey, shiftCamelot(inKey, s));
    if (dist + 0.05 * Math.abs(s) < best.dist - 0.15 && dist <= best.dist) best = { semis: s, dist };
  }
  return best;
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
  const A = a.analysis;
  const B = b.analysis;
  const rel = tempoRelation(A.bpm, B.bpm);
  const d = rel.diff;
  const tempo = d <= 0.02 ? d * 5 : d <= BEATMATCH_LIMIT ? 0.1 + (d - 0.02) * 8 : 0.7 + (d - BEATMATCH_LIMIT) * 4;
  // Tonart: Key-Sync kann bis ±2 Halbtöne angleichen (klingt aber nicht ganz so natürlich)
  const ks = keySync(A.key.camelot, B.key.camelot);
  const key = ks.dist + 0.12 * Math.abs(ks.semis);
  const energy = Math.abs((a.energy ?? 0.5) - (b.energy ?? 0.5));
  // Mix-Tauglichkeit: langes Intro beim neuen, sauberes (gesangsfreies) Ende beim alten
  const intro = (B.points?.dropBar ?? 16) - (B.points?.startBar ?? 0);
  const introCost = intro >= 16 ? 0 : intro >= 8 ? 0.1 : 0.25;
  const lastBar = A.points?.lastBar ?? 0;
  const vocalLast = A.points?.vocalLast;
  const tailClean = vocalLast === null || vocalLast === undefined ? 16 : lastBar - vocalLast;
  const tailCost = tailClean >= 8 ? 0 : 0.15;
  const introVocal = B.points?.vocalFirst !== null && B.points?.vocalFirst !== undefined
    && B.points.vocalFirst < (B.points?.dropBar ?? 0);
  const vocalCost = introVocal && tailClean < 8 ? 0.2 : 0;
  const genreCost = genreDistance(a.genre, b.genre);
  return tempo + 0.8 * key + 0.3 * energy + introCost + tailCost + vocalCost + genreCost;
}

// Wie weit Musikrichtungen auseinanderliegen (Pop↔Rap geht gut, Pop↔Uptempo ist ein Bruch)
const GENRE_DIST = {
  'pop|rap': 0.15, 'edm|pop': 0.25, 'edm|rap': 0.35, 'edm|hardstyle': 0.3, 'hardstyle|uptempo': 0.25,
  'edm|uptempo': 0.6, 'hardstyle|pop': 0.6, 'hardstyle|rap': 0.6, 'pop|uptempo': 0.9, 'rap|uptempo': 0.9,
};
export function genreDistance(x, y) {
  if (!x || !y || x === y) return 0;
  return GENRE_DIST[[x, y].sort().join('|')] ?? 0.5;
}

// Hauptkünstler: "A feat. B", "A x B", "A & B", "A, B" -> "a"
const norm = (s) => String(s || '').toLowerCase().replace(/\s+(feat\.?|ft\.?|x)\s.*$|\s*[&,].*$/, '').trim();

/** Einfacher, reproduzierbarer Zufall (für Reshuffle-Varianten). */
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e6) / 1e6;
  };
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

/**
 * Ziel-Energie an Position p (0..1) bei n Tracks: ruhiger Einstieg, Hauptpeak bei ~75 %, leichtes
 * Ausklingen – und darüber Wellen (etwa alle 6–8 Tracks ein kleiner Höhepunkt und etwas Luft),
 * wie DJs ein Set aufbauen, statt stur immer nur lauter zu werden.
 */
export function targetEnergy(p, n = 0) {
  const arc = p < 0.75 ? 0.25 + 0.7 * (p / 0.75) : 0.95 - 0.35 * ((p - 0.75) / 0.25);
  const waves = n >= 12 ? Math.max(1, Math.round(n / 7)) : 0;
  const wave = waves ? 0.1 * Math.sin(2 * Math.PI * waves * p) : 0;
  return Math.max(0, Math.min(1, arc + wave));
}

const ARC_WEIGHT = 1.2;

function totalCost(order, fixedPrefix, costCache) {
  const n = order.length;
  let c = 0;
  for (let i = 0; i < n - 1; i++) c += costCache(order[i], order[i + 1]);
  for (let i = Math.max(0, fixedPrefix - 2); i < n; i++) {
    if (i >= fixedPrefix) {
      const p = n > 1 ? i / (n - 1) : 0;
      c += ARC_WEIGHT * (order[i].energy - targetEnergy(p, n)) ** 2;
    }
    const x = order[i];
    const y = order[i + 1];
    const z = order[i + 2];
    // gleicher Künstler direkt hintereinander (oder mit nur einem Track dazwischen)
    const ax = norm(x.artist);
    if (ax && y && norm(y.artist) === ax) c += 0.6;
    if (ax && z && norm(z.artist) === ax) c += 0.2;
    // Genre-Pingpong (Pop -> Hardstyle -> Pop): lieber Blöcke spielen
    if (x.genre && y && z && y.genre !== x.genre && z.genre === x.genre) c += 0.3;
  }
  return c;
}

/**
 * Baut die Reihenfolge. `fixed` = Tracks, die schon gespielt wurden/laufen (bleiben vorne).
 * `seed` = 0 liefert die beste Reihenfolge; andere Werte liefern gute Alternativen (Reshuffle).
 */
export function buildSetOrder(tracks, fixed = [], seed = 0) {
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
  const rand = seed ? rng(seed) : null;
  const order = [...fixed];
  const remaining = [...pool];
  if (!order.length) {
    remaining.sort((a, b) => a.energy - b.energy);
    // Variante: Start aus den ruhigsten drei
    const k = rand ? Math.floor(rand() * Math.min(3, remaining.length)) : 0;
    order.push(remaining.splice(k, 1)[0]);
  }
  while (remaining.length) {
    const prev = order[order.length - 1];
    const p = total > 1 ? order.length / (total - 1) : 0;
    const ranked = remaining
      .map((t, i) => ({ i, s: cost(prev, t) + ARC_WEIGHT * (t.energy - targetEnergy(p, total)) ** 2 + (norm(t.artist) && norm(t.artist) === norm(prev.artist) ? 0.6 : 0) }))
      .sort((x, y) => x.s - y.s);
    // Variante: unter den (fast) gleich guten Nachfolgern zufällig wählen
    let pick = ranked[0];
    if (rand) {
      const good = ranked.filter((r) => r.s <= ranked[0].s + 0.25).slice(0, 3);
      pick = good[Math.floor(rand() * good.length)];
    }
    order.push(remaining.splice(pick.i, 1)[0]);
  }

  // Lokale Verbesserung: 2-opt + Verschieben einzelner Tracks
  const lock = Math.max(1, fixed.length);
  const n = order.length;
  if (n <= 250) {
    let current = totalCost(order, fixed.length, cost);
    let improved = true;
    let rounds = 0;
    // Zeitbudget: der Knopf soll sofort reagieren, auch bei großen Playlists
    const deadline = (globalThis.performance?.now() ?? Date.now()) + (n > 60 ? 900 : 400);
    const late = () => (globalThis.performance?.now() ?? Date.now()) > deadline;
    const W = n > 60 ? 24 : n; // Züge nur in der Nähe (ein Track wandert selten ans andere Ende)
    while (improved && rounds++ < 30 && !late()) {
      improved = false;
      for (let i = lock; i < n - 1 && !late(); i++) {
        for (let j = i + 1; j < Math.min(n, i + W); j++) {
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
      for (let i = lock; i < n && !late(); i++) {
        for (let j = Math.max(lock, i - W); j < Math.min(n, i + W); j++) {
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
