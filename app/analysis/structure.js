// Song-Aufbau wie ein DJ ihn hört: Abschnitte (Intro, Strophe, Refrain, Build-up, Drop, Breakdown,
// Outro) mit Energie-Stufe 1–10 und die Cue-Punkte, an denen man ein- und aussteigt.
// Arbeitet nur auf den Takt-Kurven der vorhandenen Analyse (keine Neuanalyse nötig).
//
// Abschnitte entstehen nicht aus einem starren 8-Takt-Raster, sondern dort, wo sich der Song hörbar
// ändert (Lautstärke, Bass, Schlagzeug, Gesang) – immer auf einer 4-Takt-Grenze der Phrasen.
// 8 und 16 Takte sind bevorzugt, 4-Takt-Verlängerungen (Auftakte, doppelte Pre-Chorus) erlaubt.

const W = { e: 1 / 3.5, b: 1 / 5, d: 2.5, v: 2.2, c: 1.1 }; // Gewichte: ~1 Einheit = hörbarer Unterschied
const SPLIT = 5.5; // Preis pro Abschnitt (größer = längere Abschnitte)
const MAX_LEN = 32;

function curves(a, opts = {}) {
  const n = Math.max(1, Math.min(a.barCount ?? Infinity, (a.points?.lastBar ?? a.barCount - 1) + 1));
  const get = (arr, i, def) => (arr && Number.isFinite(arr[i]) ? arr[i] : def);
  const E = new Float64Array(n), B = new Float64Array(n), D = new Float64Array(n), V = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    E[i] = Math.max(-24, Math.min(3, get(a.barEnergy, i, -6)));
    B[i] = Math.max(-24, Math.min(3, get(a.barBass, i, -6)));
    D[i] = get(a.barDrums, i, 0.5);
    // Gesang leicht geglättet (einzelne Ausreißer-Takte sind keine Zeile)
    V[i] = (get(a.vocals, i - 1, get(a.vocals, i, 0)) + 2 * get(a.vocals, i, 0) + get(a.vocals, i + 1, get(a.vocals, i, 0))) / 4;
  }
  // Klebt die Gesangskurve bei Clubmusik fast überall oben (dichte Synths, Arpeggios), trägt sie
  // keine Zeilen-Information: dann zählt nur, was deutlich über dem Grundpegel liegt (bei Pop/Rap
  // wird dagegen wirklich fast durchgehend gesungen)
  const sorted = Array.from(V).sort((x, y) => x - y);
  const base = sorted[Math.floor(sorted.length * 0.3)] ?? 0;
  if (opts.club && base > 0.4) for (let i = 0; i < n; i++) V[i] = Math.max(0, (V[i] - base) / Math.max(0.15, 1 - base));
  // Harmonie pro Takt (nur neuere Analysen): 12 Halbtöne, normiert
  let C = null;
  if (a.barChroma && a.barChroma.length >= n * 12) {
    C = Array.from({ length: n }, (_, i) => {
      const v = Array.from(a.barChroma.subarray ? a.barChroma.subarray(i * 12, i * 12 + 12) : a.barChroma.slice(i * 12, i * 12 + 12));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
  return { n, E, B, D, V, C };
}

/** Abschnittsgrenzen per dynamischer Programmierung: möglichst gleichförmige Abschnitte, wenige Schnitte. */
function segment({ n, E, B, D, V, C }, offset) {
  const dims = [E, B, D, V].map((arr, k) => Float64Array.from(arr, (x) => x * [W.e, W.b, W.d, W.v][k]));
  if (C) for (let k = 0; k < 12; k++) dims.push(Float64Array.from(C, (v) => v[k] * W.c));
  const ps = dims.map((x) => { const s = new Float64Array(n + 1); for (let i = 0; i < n; i++) s[i + 1] = s[i] + x[i]; return s; });
  const pq = dims.map((x) => { const s = new Float64Array(n + 1); for (let i = 0; i < n; i++) s[i + 1] = s[i] + x[i] * x[i]; return s; });
  const cost = (i, j) => {
    let c = 0;
    for (let k = 0; k < dims.length; k++) {
      const s = ps[k][j] - ps[k][i];
      c += pq[k][j] - pq[k][i] - (s * s) / (j - i);
    }
    return c;
  };
  // mögliche Grenzen: Songanfang, Phrasen-Versatz, dann alle 4 Takte, Songende
  const pos = [0];
  for (let b = offset % 4 || 4; b < n; b += 4) if (b > 0 && (b - offset) % 4 === 0) pos.push(b);
  if (offset > 0 && offset % 4 && !pos.includes(offset)) pos.push(offset);
  pos.sort((x, y) => x - y);
  if (pos[pos.length - 1] !== n) pos.push(n);
  const lenPen = (len, from) => {
    if (len >= 8 && len % 8 === 0 && (from - offset) % 8 === 0) return 0;
    if (len % 8 === 0) return 0.6;
    return len === 4 ? 1.6 : 1.1; // 4er-Stücke und 12er nur, wenn sich der Song wirklich ändert
  };
  const best = new Float64Array(pos.length).fill(Infinity);
  const prev = new Int32Array(pos.length).fill(-1);
  best[0] = 0;
  for (let j = 1; j < pos.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const len = pos[j] - pos[i];
      if (len > MAX_LEN && i < j - 1) break;
      // Anfangs-/Endstücke (vor dem Phrasenraster, Songende) sind frei in der Länge
      const edge = i === 0 || j === pos.length - 1;
      const c = best[i] + cost(pos[i], pos[j]) + SPLIT + (edge ? 0 : lenPen(len, pos[i]));
      if (c < best[j]) { best[j] = c; prev[j] = i; }
    }
  }
  const cuts = [];
  for (let j = pos.length - 1; j > 0; j = prev[j]) cuts.push([pos[prev[j]], pos[j]]);
  return cuts.reverse();
}

const avg = (arr, i, j) => { let s = 0; for (let k = i; k < j; k++) s += arr[k]; return s / Math.max(1, j - i); };

/**
 * @returns {{ sections: Array<{from:number,to:number,bars:number,role:string,level:number,energy:number,bass:number,drums:number,vocal:number}>,
 *   cues: { mixIn:number, introEnd:number, firstPeak:number|null, lastPeakEnd:number|null, outroStart:number, end:number, hooks:number[] },
 *   vocalSong: boolean }}
 */
/** @param opts.club Clubmusik (EDM/Hardstyle/Uptempo): Gesangskurve gegen Synth-Flächen absichern */
export function trackStructure(a, opts = {}) {
  const c = curves(a, opts);
  const { n, E, B, D, V } = c;
  const offset = ((a.phraseOffset ?? 0) % 8 + 8) % 8;
  const secs = segment(c, offset).map(([from, to]) => ({
    from, to, bars: to - from,
    energy: avg(E, from, to), bass: avg(B, from, to), drums: avg(D, from, to), vocal: avg(V, from, to),
    rise: avg(E, from + ((to - from) >> 1), to) - avg(E, from, from + ((to - from) >> 1)),
  }));
  let vocalBars = 0;
  for (let i = 0; i < n; i++) if (V[i] >= 0.45) vocalBars++;
  // (Clubmusik wird über Energie gelesen – Drop, Breakdown, Build-up –, nicht über Strophe/Refrain)
  const vocalSong = !opts.club && vocalBars / n >= 0.25;
  // Höhepunkt-Pegel des Songs: lautester Bereich mit Schlagzeug (gewichtet nach Länge)
  const loud = secs.filter((s) => s.drums > 0.35).map((s) => s.energy).sort((x, y) => y - x);
  const top = loud.length ? loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.2))] : 0;
  const basses = secs.filter((s) => s.drums > 0.35).map((s) => s.bass).sort((x, y) => y - x);
  const topBass = basses.length ? basses[Math.min(basses.length - 1, Math.floor(basses.length * 0.2))] : 0;
  // Wiederkehr (nur mit Harmonie-Daten): wie ähnlich kommt dieser Teil später/früher noch einmal?
  // Der Refrain ist der Teil, der am häufigsten genau so wiederkommt.
  if (c.C) {
    const cos = (x, y) => x.reduce((t, v, k) => t + v * y[k], 0);
    for (const s of secs) {
      let best = 0;
      for (const t of secs) {
        if (t === s || t.bars < 4 || (t.from < s.to && s.from < t.to)) continue;
        const len = Math.min(s.bars, t.bars, 16);
        let sim = 0;
        for (let k = 0; k < len; k++) sim += cos(c.C[s.from + k], c.C[t.from + k]);
        best = Math.max(best, sim / len);
      }
      s.recur = best;
    }
    const rs = secs.map((x) => x.recur).sort((x, y) => x - y);
    const med = rs[rs.length >> 1];
    for (const s of secs) s.recur = Math.max(-1, Math.min(1, (s.recur - med) * 8)); // relativ zum Song
  } else for (const s of secs) s.recur = 0;

  const sungIdx = secs.map((s, i) => (s.vocal >= 0.4 ? i : -1)).filter((i) => i >= 0);
  const firstSung = vocalSong ? sungIdx[0] ?? -1 : -1;
  const lastSung = vocalSong ? sungIdx[sungIdx.length - 1] ?? -1 : -1;
  secs.forEach((s, i) => {
    // Höhepunkt = laut, mit Schlagzeug UND voller Bassline (Intro mit Kick, aber ohne Bass, ist keiner)
    const hi = s.energy >= top - 2.5 && s.drums > 0.35 && s.bass > -8 && s.bass >= topBass - 4;
    // Pause/Breakdown: Schlagzeug weg – oder (Clubmusik) Bassline weg und deutlich leiser
    if ((s.drums < 0.25 && s.energy < top - 5) || (!hi && s.bass < topBass - 6 && s.energy < top - 3)) s.role = 'break';
    else if (vocalSong && s.vocal < 0.35) s.role = 'groove'; // Instrumental-Teil im Gesangssong (Solo, Hook-Riff)
    else if (hi) s.role = vocalSong ? 'chorus' : 'drop';
    else s.role = vocalSong && s.vocal >= 0.4 ? 'verse' : 'groove';
    // Gesangssong: alles Instrumentale vor der ersten Zeile ist Intro, nach der letzten Outro
    if (vocalSong && firstSung >= 0 && i < firstSung && s.vocal < 0.35) s.role = 'intro';
  });
  // Gesangssongs: Refrain = die stärksten, am häufigsten wiederkehrenden Gesangsabschnitte
  if (vocalSong) {
    const sung = secs.filter((s) => s.vocal >= 0.4 && s.drums > 0.3);
    const score = (s) => s.energy + 3 * s.vocal + 0.15 * s.bass + 2.5 * s.recur;
    const max = Math.max(...sung.map(score));
    if (sung.length >= 3) for (const s of sung) s.role = score(s) >= max - 1.5 ? 'chorus' : 'verse';
  }
  const peak = (s) => s.role === 'chorus' || s.role === 'drop';
  // (Clubmusik: alles vor dem ersten Drop ist Intro/Build-up – dort wird gemischt)
  const firstMain = secs.findIndex((s) => peak(s) || (vocalSong && s.role === 'verse' && s.drums > 0.3));
  let lastPeak = -1;
  secs.forEach((s, i) => { if (peak(s) || (vocalSong && i === lastSung)) lastPeak = Math.max(lastPeak, i); });
  secs.forEach((s, i) => {
    if (s.role === 'intro') return;
    if (firstMain >= 0 && i < firstMain && (s.vocal < 0.35 || !vocalSong)) s.role = 'intro';
    else if (lastPeak >= 0 && i > lastPeak && (s.vocal < 0.35 || s.energy < top - 4) && secs.slice(i).every((x) => !peak(x))) s.role = 'outro';
    else if (s.role === 'break') s.role = 'breakdown';
  });
  // Build-up: steigt in einen Höhepunkt, Bass noch nicht voll da
  secs.forEach((s, i) => {
    const nx = secs[i + 1];
    if (!nx || !peak(nx) || peak(s) || s.role === 'outro') return;
    if ((s.rise > 1.5 || s.drums < nx.drums - 0.15) && s.bass < nx.bass - 4) s.role = 'build';
  });
  for (const s of secs) {
    // Energie-Stufe 1–10 (wie in DJ-Software): Lautheit relativ zum Höhepunkt + Schlagzeug
    s.level = Math.max(1, Math.min(10, Math.round(10 + (s.energy - top) * 0.45 - (1 - Math.min(1, s.drums / 0.6)) * 3)));
    for (const k of ['energy', 'bass', 'drums', 'vocal', 'rise', 'recur']) s[k] = +s[k].toFixed(2);
  }

  const start = a.points?.startBar ?? 0;
  const introSecs = secs.filter((s) => s.role === 'intro' || (s.role === 'build' && s.to <= (secs[firstMain]?.from ?? 0)));
  const introEnd = firstMain >= 0 ? secs[firstMain].from : start;
  const lastPeakEnd = lastPeak >= 0 ? secs[lastPeak].to : null;
  const outro = secs.find((s, i) => i > lastPeak && s.role === 'outro');
  const cues = {
    mixIn: start,
    introEnd: Math.max(start, introSecs.length ? introSecs[introSecs.length - 1].to : introEnd),
    firstPeak: secs.find(peak)?.from ?? null,
    lastPeakEnd,
    outroStart: outro ? outro.from : lastPeakEnd ?? n,
    end: n,
    hooks: secs.filter((s) => s.role === 'chorus').map((s) => s.from),
  };
  return { sections: secs, cues, vocalSong };
}

/** Kurzbeschreibung für Anzeige/Debug, z. B. "Intro 16 · Strophe 16 · Refrain 8 …". */
export const ROLE_NAMES = {
  intro: 'Intro', verse: 'Strophe', chorus: 'Refrain', drop: 'Drop', build: 'Build-up',
  breakdown: 'Breakdown', groove: 'Groove', outro: 'Outro', break: 'Pause',
};
export function describeStructure(st) {
  return st.sections.map((s) => `${ROLE_NAMES[s.role] ?? s.role} ${s.bars}`).join(' · ');
}
