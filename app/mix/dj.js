// Der zentrale DJ: hört sich jeden möglichen Übergang für genau dieses Songpaar vorher an (nur
// Rechnung, kein Audio) und entscheidet danach – nicht nach einer festen Rangliste der Techniken.
// Die Techniken des Planers sind nur noch seine Handgriffe; welche er nimmt und wie lang, ergibt sich
// daraus, was an dieser Stelle der beiden Songs zu hören wäre:
//   - trägt die Summe durchgehend, oder entsteht ein Loch bzw. ein Berg?
//   - liegen beide Songs im selben Frequenzband übereinander (klingt nach bloßem Überblenden), oder
//     teilen sie sich den Raum (Bass vom einen, Höhen vom anderen)?
//   - gibt es eine klare Übergabe, und liegt sie auf einer Phrasen-Eins?
//   - wird der neue angekündigt, hängt der alte danach noch lange nach?
//   - springt der Pegel zwischen "vorher" und "nachher"?
// Dazu kommen die harten Fehler aus dem Selbstcheck (zwei Stimmen, abgeschnittene Zeile …) und –
// schwach gewichtet – Geschmack: Einstellung weich/hart, gelernte Bewertungen, Abwechslung.

import { patternAt, similarity } from './rhythm.js';

const S = 0.25; // Auflösung in Takten
const W = [0.45, 0.35, 0.2]; // Anteil von Bass, Mitten, Höhen an der Wucht
const CENT = [80, 1000, 6000];
const NEUTRAL = { fader: 1, low: 0, mid: 0, high: 0, filter: 0, vocal: 0, trim: 0 };
const lin = (db) => 10 ** (db / 10);
const dB = (x) => 10 * Math.log10(x + 1e-9);

function valueAt(list, t, start) {
  let v = start;
  for (const s of list) {
    if (t < s.at) break;
    const end = s.at + (s.dur || 0);
    if (t >= end || !s.dur) v = s.to;
    else v += (s.to - v) * ((t - s.at) / s.dur);
  }
  return v;
}

/** Was der Track in diesem Takt in den drei Bändern spielt (Leistung, Summe = Takt-Lautheit). */
function content(v, bar) {
  const b = Math.floor(bar);
  if (b < 0 || b >= (v.a.barCount ?? v.end + 64)) return [0, 0, 0];
  const raw = [W[0] * lin(v.bass(b)), W[1] * lin(v.midBand(b)), W[2] * lin(v.high(b))];
  const sum = raw[0] + raw[1] + raw[2] || 1;
  const e = lin(v.energy(b));
  return raw.map((x) => (e * x) / sum);
}

/**
 * Hört einen Plan ab. Liefert Messwerte, eine Note (höher = klingt mehr nach DJ) und in Worten,
 * was zu hören wäre.
 */
export function listen(plan, va, vb) {
  const steps = plan.steps;
  const params = { out: {}, in: {} };
  for (const s of steps) if (s.param && params[s.deck]) (params[s.deck][s.param] ||= []).push(s);
  for (const d of ['out', 'in']) for (const k of Object.keys(params[d])) params[d][k].sort((x, y) => x.at - y.at);
  const val = (d, k, t) => valueAt(params[d][k] || [], t, d === 'in' && k === 'fader' ? 0 : NEUTRAL[k]);
  const play = steps.find((s) => s.deck === 'in' && s.action === 'play');
  const tPlay = play ? play.at : 0;
  const inOffset = play?.barOffset || 0;
  const m = plan.m || 1;
  const stopOut = steps.find((s) => s.deck === 'out' && s.action === 'stop')?.at ?? Infinity;
  const loopStep = steps.find((s) => s.deck === 'out' && s.action === 'loop');
  const loopFrom = loopStep?.at ?? Infinity;
  const outAt = (t) => {
    if (!loopStep?.bars) return plan.outBar + Math.min(t, loopFrom);
    const start = loopStep.anchor ?? loopFrom;
    const rel = t - start;
    return plan.outBar + (rel < loopStep.bars ? t : start + (rel % loopStep.bars));
  };
  const inAt = (t) => plan.inBar + inOffset + (t - tPlay) * m;
  const gains = (d, t) => {
    const fd = val(d, 'fader', t);
    const f = val(d, 'filter', t);
    // (Stimm-Filter der Engine: −20 dB um 1,3 kHz und −14 dB um 3,2 kHz – ein tiefer Einschnitt, kein sanfter)
    const eq = [val(d, 'low', t), val(d, 'mid', t) - 15 * val(d, 'vocal', t), val(d, 'high', t) - 4 * val(d, 'vocal', t)];
    const hp = f > 0 ? 20 * 250 ** Math.min(1, f) : 0;
    const lp = f < 0 ? 22000 * (180 / 22000) ** Math.min(1, -f) : 1e9;
    const tr = lin(val(d, 'trim', t));
    return CENT.map((c, b) => fd * fd * tr * lin(eq[b] - (c < hp ? 12 * Math.log2(hp / c) : 0) - (c > lp ? 12 * Math.log2(c / lp) : 0)));
  };
  const ts = steps.filter((s) => s.action !== 'rate');
  const t0 = Math.min(0, tPlay, ...ts.map((s) => s.at));
  const t1 = Math.min(Math.max(...ts.map((s) => s.at + (s.dur || 0)), plan.bars || 0), t0 + 48);
  const mean = (v, from, to) => {
    let s = 0;
    let n = 0;
    for (let b = Math.floor(from); b < Math.ceil(to); b++, n++) s += lin(v.energy(Math.max(0, b)));
    return s / Math.max(1, n);
  };
  const before = dB(mean(va, plan.outBar + t0 - 2, plan.outBar + t0));
  const after = dB(mean(vb, inAt(t1), inAt(t1) + 2 * m));

  const row = [];
  for (let t = t0; t < t1 - 1e-9; t += S) {
    const tc = t + S / 2;
    const oOn = tc < stopOut;
    const iOn = tc >= tPlay;
    const co = oOn ? content(va, outAt(tc)) : [0, 0, 0];
    const ci = iOn ? content(vb, inAt(tc)) : [0, 0, 0];
    const go = gains('out', tc);
    const gi = gains('in', tc);
    let po = 0;
    let pi = 0;
    let both = 0;
    let lowBoth = 0;
    let rawO = 0;
    let rawI = 0;
    for (let b = 0; b < 3; b++) {
      const o = co[b] * go[b];
      const i = ci[b] * gi[b];
      po += o;
      pi += i;
      // zwei Bässe übereinander wummern immer; Mitten reiben sich je nach Tonart; Höhen stören kaum
      if (b === 0) lowBoth += Math.min(o, i);
      else both += Math.min(o, i) * (b === 2 ? 0.5 : 1);
      rawO += co[b];
      rawI += ci[b];
    }
    // Gesang: singt gerade einer – und ist er auch zu hören (Fader, Mitten, Stimm-Filter)?
    const so = oOn ? va.vocalSmooth(Math.floor(outAt(tc))) : 0;
    const si = iOn ? vb.vocalSmooth(Math.floor(inAt(tc))) : 0;
    const voc = (so >= 0.4 && go[1] >= 0.1) || (si >= 0.4 && gi[1] >= 0.1);
    const natural = so >= 0.4 || si >= 0.4; // (singt dort überhaupt jemand – auch wenn der Mix ihn wegdrückt?)
    row.push({ t, voc, natural, po, pi, share: pi / (po + pi + 1e-9), mud: (2 * both) / (po + pi + 1e-9), lowMud: (2 * lowBoth) / (po + pi + 1e-9), lvl: dB(po + pi), avail: dB(Math.max(rawO, rawI)) });
  }
  const n = row.length;
  // --- Übergabe: ab wann führt der neue (und bleibt vorn)?
  let iX = n;
  for (let i = n - 1; i >= 0 && row[i].share >= 0.5; i--) iX = i;
  const tX = iX < n ? row[iX].t : t1;
  let iA = iX;
  while (iA > 0 && row[iA - 1].share > 0.25) iA--;
  let iB = iX;
  while (iB < n && row[iB].share < 0.75) iB++;
  const width = (iB - iA) * S; // so lange ist unklar, wer führt
  // --- Gesangsloch: Strecke, in der keiner singt (oder die Stimme weggefiltert ist), obwohl die
  //     Songs drumherum Gesang haben. Zu lange Instrumental-Teile klingen nach Automatik, nicht nach Party.
  let sungAround = false;
  for (let b = 1; b <= 8 && !sungAround; b++) sungAround = va.vocalSmooth(Math.floor(plan.outBar + t0 - b)) >= 0.4 || vb.vocalSmooth(Math.floor(inAt(t1) + (b - 1) * m)) >= 0.4;
  // (vom Mix verschluckter Gesang zählt voll; ein Instrumentalteil, der in beiden Songs so steht,
  // nur halb – den hört man auch, wenn ein DJ die Songs einfach spielt)
  let vocGap = 0;
  let vocGapMix = 0;
  if (sungAround) {
    let run = 0;
    let runMix = 0;
    for (const r of row) {
      run = r.voc ? 0 : run + S;
      runMix = r.voc ? 0 : runMix + (r.natural ? S : S / 2);
      vocGap = Math.max(vocGap, run);
      vocGapMix = Math.max(vocGapMix, runMix);
    }
  }
  // --- Phrase: Übergabe auf einer 4er-Eins des alten Tracks?
  const ob = outAt(tX) - (va.a.phraseOffset || 0);
  const off = ((ob % 4) + 4) % 4;
  let onPhrase = Math.min(off, 4 - off) < 0.3;
  const onBar = Math.abs(ob - Math.round(ob)) < 0.15;
  // … und beim neuen: Ein DJ legt den neuen so an, dass beide Songs zugleich eine neue Phrase
  // beginnen. Sonst wechselt der neue seinen Abschnitt mitten in der Phrase des alten (holpert).
  const ib = inAt(tX) - (vb.a.phraseOffset || 0);
  const inOff = ((ib % 4) + 4) % 4;
  let inPhrase = Math.min(inOff, 4 - inOff) < 0.3;
  // Lange Blends: Der DJ legt beide Songs auf ihrer Phrasen-Eins übereinander und lässt sie laufen –
  // wo genau die Lautstärke kippt, liegt dann zwischen den Takten, ohne dass es holpert.
  const at4 = (x) => { const o = ((x % 4) + 4) % 4; return Math.min(o, 4 - o) < 0.3; };
  const locked = (plan.bars || 0) >= 8 && plan.beatmatch !== false && at4(plan.outBar + t0 - (va.a.phraseOffset || 0)) && at4(inAt(t0) - (vb.a.phraseOffset || 0));
  if (locked) { inPhrase = true; onPhrase = true; }
  // --- Ankündigung: Takte vor der Übergabe, in denen man den neuen schon hört
  let lead = 0;
  for (let i = 0; i < iX; i++) if (row[i].share >= 0.1) lead += S;
  // … und wie präsent er direkt vor der Übergabe ist: kommt er aus dem Nichts, "ploppt" er rein
  let pre = 0;
  let preN = 0;
  for (let i = Math.max(0, iX - 8); i < iX; i++, preN++) pre += row[i].share;
  pre = preN ? pre / preN : 0;
  // --- Nachhängen: alter noch deutlich da, obwohl der neue längst führt
  let linger = 0;
  for (let i = iB; i < n; i++) if (row[i].share < 0.8 && row[i].po > lin(before - 14)) linger += S;
  // --- Pegel: Loch und Berg (natürlich leise Stellen der Songs sind kein Loch)
  let hole = 0;
  let bump = 0;
  let mud = 0;
  let lowMud = 0;
  let weave = 0; // Takte, in denen beide hörbar zusammen laufen, ohne sich im Weg zu stehen
  const floor = Math.min(before, after);
  const ceil = Math.max(before, after);
  for (const r of row) {
    if (r.lvl < floor - 4 && r.lvl < r.avail - 4) hole += S;
    if (r.lvl > Math.max(ceil, r.avail) + 2.5) bump += S;
    if (r.po > 0 && r.pi > 0) {
      mud += S * r.mud;
      lowMud += S * r.lowMud;
      if (Math.min(r.share, 1 - r.share) >= 0.08 && r.lowMud < 0.15 && r.lvl >= floor - 4) weave += S;
    }
  }
  const step = after - before;
  // (Tempo-Rampe: die Takte des alten laufen dort nicht gleich schnell – eigene Rechnung im Planer)
  const solo = plan.type === 'echo' || plan.type === 'cut' || plan.type === 'breakdown' || plan.type === 'endfade' || plan.type === 'ramp';
  // (ohne Beatmatch laufen zwei Beats gegeneinander: jedes Übereinander zählt doppelt; passen die
  // Tonarten nicht, reiben sich die Mitten)
  // (im Takt und in passender Tonart ist Übereinander genau das Verweben, das man hören will –
  // teuer wird es erst, wenn sich die Harmonien reiben oder die Beats gegeneinander laufen)
  const tonal = (plan.keyDist ?? 0) >= 0.5 ? 1 : (plan.keyDist ?? 0) >= 0.3 ? 0.6 : 0.25; // (Camelot-Abstand 0..1)
  const loose = plan.beatmatch === false && plan.type !== 'ramp' ? 2 : 1;
  const mudCost = loose * (0.22 * mud * tonal + 0.35 * lowMud);
  const weaveGain = plan.beatmatch === false ? 0 : 0.07 * Math.min(weave, 12);
  // Rhythmus: laufen beide Songs übereinander, sollen ihre Kicks/Bässe ineinandergreifen (gleiches
  // Muster im Takt). Ein Bass-Tausch (kaum Überlagerung) macht auch ungleiche Muster unkritisch.
  let rhythm = null;
  let rhythmCost = 0;
  if (!solo && plan.beatmatch !== false && (lowMud > 0.3 || weave >= 2)) {
    rhythm = similarity(patternAt(va.a, outAt(tX - 2), outAt(tX + 2)), patternAt(vb.a, inAt(tX - 2), inAt(tX + 2)));
    if (rhythm !== null) rhythmCost = Math.min(0.5, (0.5 * lowMud + 0.08 * Math.min(weave, 8)) * Math.max(0, 0.8 - rhythm));
  }
  // (im Takt gemischt soll der neue in den zwei Takten vor der Übergabe schon da sein – ~15 % und mehr)
  const popCost = solo || plan.beatmatch === false || plan.type === 'chorus' ? 0 : 0.3 * Math.max(0, 1 - pre / 0.15) + 0.4 * Math.max(0, 1 - pre / 0.3);
  const widthCost = Math.max(0, width - 2) * 0.12;
  // (Echo-Out, Schnitt, Breakdown: kein gemeinsames Laufen – ob die Stelle passt, prüft der Selbstcheck)
  const phrase = solo ? 0 : (onPhrase ? 0.4 : onBar ? 0 : -0.5) + (plan.beatmatch === false ? 0 : inPhrase ? 0.15 : -0.45);
  const leadGain = plan.beatmatch === false ? 0 : 0.1 * Math.min(lead, 4);
  const lingerCost = 0.1 * Math.max(0, linger - 1);
  const stepCost = Math.min(0.9, Math.max(0, Math.abs(step) - 5) * 0.08);
  // (Echo-/Hallfahne des alten füllt beim Echo-Out und Schnitt einen Teil der Lücke)
  const tail = plan.type === 'echo' || plan.type === 'cut';
  // Ließen sich die Beats angleichen, ist ein Abbruch (Echo-Out, Schnitt, Ausblenden) die schwächere
  // Lösung: ein DJ mischt dann – er bricht nur ab, wenn das Mischen selbst nicht sauber geht
  const abortCost = plan.canMatch && (plan.type === 'echo' || plan.type === 'cut' || plan.type === 'endfade') ? 0.6 : 0;
  // --- Effekte: zu dick aufgetragen klingt es künstlich (Echo-/Hallfahne, tiefer Filter, stark
  //     ausgedünnter alter Song, solange er noch führt)
  const outMax = (k, until = Infinity) => Math.max(0, ...steps.filter((s) => s.deck === 'out' && s.param === k && s.at <= until).map((s) => Math.abs(s.to)));
  const outMin = (k) => Math.min(0, ...steps.filter((s) => s.deck === 'out' && s.param === k && s.at < tX - 0.6 && s.to > -20).map((s) => s.to));
  const fxEcho = Math.max(0, outMax('echo') - 0.25);
  const fxVerb = Math.max(0, outMax('reverb') - 0.3);
  const fxFilter = Math.max(0, outMax('filter', tX + 0.5) - 0.25);
  const fxThin = Math.max(0, -6 - outMin('mid')) * 0.04 + Math.max(0, -8 - outMin('high')) * 0.02;
  const inMax = (k) => Math.max(0, ...steps.filter((s) => s.deck === 'in' && s.param === k).map((s) => Math.abs(s.to)));
  const fxInFilter = Math.max(0, inMax('filter') - 0.4);
  const fxFlanger = Math.max(outMax('flanger'), inMax('flanger'));
  const fxCost = Math.min(1, 0.8 * fxEcho + 0.5 * fxVerb + 1.1 * fxFilter + fxThin + 0.4 * fxInFilter + 0.6 * fxFlanger);
  const vocCost = Math.min(1, Math.max(0, vocGapMix - 2) * 0.15);
  const score = 2 - abortCost + phrase + leadGain + weaveGain - popCost - (tail ? 0.2 : 0.5) * hole - 0.3 * bump - mudCost - widthCost - lingerCost - stepCost - fxCost - vocCost - rhythmCost;

  const heard = [];
  heard.push(width <= 1 ? `klare Übergabe bei Takt ${+tX.toFixed(1)}` : `Übergabe über ${+width.toFixed(1)} Takte um Takt ${+tX.toFixed(1)}`);
  if (onPhrase) heard.push('auf der Phrasen-Eins');
  if (weave >= 2) heard.push(`${+weave.toFixed(0)} Takte sauber verwoben`);
  if (lead >= 1) heard.push(`neuer ${+lead.toFixed(0)} Takte vorher zu hören`);
  const bad = [];
  if (hole >= (tail ? 2 : 1)) bad.push(`${+hole.toFixed(1)} Takte Loch`);
  if (bump >= 1) bad.push(`${+bump.toFixed(1)} Takte zu laut`);
  if (lowMud >= 1) bad.push(`${+lowMud.toFixed(1)} Takte zwei Bässe übereinander`);
  if (mud * tonal * loose >= 2) bad.push(`${+mud.toFixed(1)} Takte reiben sich beide Songs`);
  if (popCost > 0.3) bad.push('neuer kommt aus dem Nichts');
  if (width > 4) bad.push('lange unklar, wer führt');
  if (!solo && !onPhrase && !onBar) bad.push('Übergabe neben der Eins');
  if (!solo && plan.beatmatch !== false && !inPhrase) bad.push('neuer setzt neben seiner Phrase ein');
  if (linger > 2) bad.push('alter hängt nach');
  if (rhythmCost > 0.15) bad.push('Beats greifen nicht ineinander');
  if (fxCost > 0.2) bad.push('Effekte zu dick aufgetragen');
  if (vocGapMix > 3) bad.push(`${+vocGap.toFixed(1)} Takte ohne Gesang`);
  if (Math.abs(step) > 6) bad.push(`Pegel ${step > 0 ? 'springt hoch' : 'fällt ab'} (${step > 0 ? '+' : ''}${step.toFixed(0)} dB)`);
  return { score, rows: row.map((r) => ({ t: r.t, lvl: r.lvl, po: r.po, pi: r.pi, avail: r.avail })), floor, ceil, fxCost, rhythm, rhythmCost, vocGap, tX, width, onPhrase, inPhrase, inPos: inAt(tX), lead, linger, hole, bump, mud, lowMud, weave, pre, step, heard, bad, curve: row.map((r) => [r.t, r.share]) };
}

/** Echte Fehler (ohne den Hinweis auf übersprungene Hauptteile – das ist Geschmack, kein Fehler). */
const flaws = (plan) => plan.audit.issues.filter((i) => !i.includes('Hauptteil')).length;

/** Gesamturteil des DJs über einen abgehörten Kandidaten. */
export function judge(plan, va, vb, tasteWeight = 0.35) {
  const ear = listen(plan, va, vb);
  const a = plan.audit;
  // Geschmack: die Vorlieben des Planers zählen nur schwach – was du selbst bewertet hast (👍/👎), voll
  const learned = plan.learned ?? 0;
  const taste = tasteWeight * Math.max(-2.5, Math.min(2.5, (plan.score ?? 0) - learned)) + learned;
  // Ein Song, der vor seiner Mitte verlassen wird, wurde nicht gespielt, sondern angespielt
  const dur = va.a.duration || 0;
  const played = dur ? (plan.outBar * 240) / (va.a.bpm || 120) / dur : 1;
  const early = played < 0.5 ? Math.min(2.5, (0.5 - played) * 12) : 0;
  if (early > 0.3) ear.bad.push('alter Song würde nur angespielt');
  // (Freestyle will Effekte und Tricks: dort zählt „dick aufgetragen" nicht als Fehler)
  const total = ear.score + (tasteWeight >= 1 ? ear.fxCost : 0) - early + taste - 2 * a.penalty - (flaws(plan) ? 1.2 : 0) - (a.lineCut ? 3 : 0);
  return { ear, total };
}

/**
 * Wählt unter den abgehörten Kandidaten und schreibt in die Notizen, was der DJ gehört hat und
 * was er warum verworfen hat. `label(type)` liefert den Namen einer Technik.
 */
export function decide(cands, va, vb, label, tasteWeight = 0.35) {
  let best = null;
  for (const c of cands) {
    c.dj = judge(c, va, vb, tasteWeight);
    if (!best || c.dj.total > best.dj.total + 1e-9) best = c;
  }
  if (!best) return null;
  const seen = new Set([best.type]);
  const rejected = [];
  for (const c of [...cands].sort((x, y) => y.dj.total - x.dj.total)) {
    if (seen.has(c.type) || rejected.length >= 2) continue;
    seen.add(c.type);
    const why = [...c.audit.issues.filter((i) => !i.includes('Hauptteil')), ...c.dj.ear.bad][0];
    rejected.push(`${label(c.type)}${why ? ` (${why})` : ''}`);
  }
  best.notes.push(`DJ hört: ${best.dj.ear.heard.join(', ')}${best.dj.ear.bad.length ? ` – ${best.dj.ear.bad.join(', ')}` : ''}`);
  if (rejected.length) best.notes.push(`DJ verwirft: ${rejected.join('; ')}`);
  best.djScore = +best.dj.total.toFixed(2);
  // alles, was der DJ erwogen hat (für Anzeige und Auswertung)
  best.considered = [...cands].sort((x, y) => y.dj.total - x.dj.total).map((c) => ({ type: c.type, bars: c.bars, total: +c.dj.total.toFixed(2), ear: +c.dj.ear.score.toFixed(2), bad: c.dj.ear.bad, issues: c.audit.issues }));
  return best;
}

/**
 * Wie schwach ist dieser (fertig geplante) Übergang aus Sicht des DJs? 0 = klingt gut. Für die
 * Set-Reihenfolge: Songs, zwischen denen selbst der beste Übergang schwach bleibt, sollen nicht
 * nebeneinander stehen.
 */
export function mixCostOf(plan) {
  if (plan?.djScore === undefined) return 0;
  // (zwei Songs, deren Beats sich nicht angleichen lassen, kann auch ein DJ nur abbrechen statt
  // mischen – solche Nachbarn gehören nicht nebeneinander, wenn es irgendwie anders geht)
  const unmixable = plan.beatmatch === false && plan.type !== 'ramp' ? 1.2 : 0;
  // (richtig schwache Übergänge wiegen überproportional: lieber drei mittelgute als einen schlechten)
  const weak = Math.max(0, 1.2 - plan.djScore) * 0.8;
  return Math.max(0, Math.min(4.5, (2.3 - plan.djScore) * 0.8 + weak + unmixable));
}

const ADAPT_TYPES = new Set(['blend', 'filter', 'handoff', 'loop']);
const stepOf = (at, deck, param, to, dur) => ({ at, deck, param, to, dur });

/** Griff „Platz machen": der alte nimmt Mitten/Höhen zurück, der neue kommt offener (EQ-Tausch). */
function roomGrips(plan, va) {
  const ear = plan.dj.ear;
  const tX = ear.tX;
  if (tX < 3 || ear.pre >= 0.3) return [];
  const before = (s) => s.at < tX - 0.6;
  // läuft schon ein EQ-Tausch am alten Deck, wird nicht doppelt gedreht
  if (plan.steps.some((s) => s.deck === 'out' && s.param === 'mid' && before(s) && s.to < -2)) return [];
  // singt der alte in der zweiten Hälfte noch, bleibt seine Stimme vorn: nur wenig Platz machen
  let sung = 0;
  for (let t = Math.floor(tX / 2); t < tX; t++) sung = Math.max(sung, va.vocalSmooth(Math.floor(plan.outBar + t)));
  const depths = sung >= 0.5 ? [-3] : [-4, -7, -10];
  const tA = Math.max(1, Math.floor(tX / 2));
  const dur = Math.max(0.5, tX - 0.5 - tA);
  const out = [];
  for (const d of depths) {
    for (const open of [0, 1, 2]) {
      let steps = plan.steps.map((s) => ({ ...s }));
      steps.push(stepOf(tA, 'out', 'mid', d, dur));
      if (!steps.some((s) => s.deck === 'out' && s.param === 'high' && before(s) && s.to < -2)) steps.push(stepOf(tA, 'out', 'high', d - 2, dur));
      if (open) steps = steps.map((s) => (s.deck === 'in' && (s.param === 'mid' || s.param === 'high') && before(s) && s.to < 0 && s.to > -20 ? { ...s, to: open === 2 ? s.to / 4 : s.to / 2 } : s));
      // ganz offen: auch der Einstiegs-Filter des neuen ist nur halb zu
      if (open === 2) steps = steps.map((s) => (s.deck === 'in' && s.param === 'filter' && before(s) && s.to < 0 ? { ...s, to: s.to / 2 } : s));
      out.push({ steps, text: `alter Track macht ab Takt ${tA} in Mitten und Höhen Platz (${d} dB)${open === 2 ? ', der neue kommt fast offen herein' : open ? ', der neue kommt offener herein' : ''}` });
    }
  }
  return out;
}

/**
 * Griff „Bass-Tausch auf die Eins": Ein über einen halben Takt gezogener Bass-Wechsel lässt die
 * Übergabe neben die Eins rutschen (und kurz beide oder keinen Bass hören). Ein DJ tauscht den Bass
 * mit einem Griff genau auf der Eins.
 */
function crispGrips(plan) {
  const lows = plan.steps.filter((s) => s.param === 'low' && (s.dur || 0) > 0.15 && Math.abs(s.at - Math.round(s.at)) < 0.01);
  const out = [];
  for (const o of lows.filter((s) => s.deck === 'out' && s.to <= -20)) {
    const i = lows.find((s) => s.deck === 'in' && s.to > -3 && s.at === o.at);
    if (!i) continue;
    const steps = plan.steps.map((s) => (s === o || s === i ? { ...s, dur: 0.05 } : { ...s }));
    out.push({ steps, text: `Bass-Tausch mit einem Griff genau auf der Eins (Takt ${o.at}) statt über ${o.dur} Takte gezogen` });
  }
  return out;
}

/**
 * Griff „Pegel ausgleichen": Entsteht im Übergang ein Loch (Summe deutlich leiser als davor/danach,
 * obwohl die Songs mehr hergeben) oder ein Berg, hebt/senkt der DJ den führenden Song um höchstens
 * 3 dB – wie am Gain-Regler nachgezogen. Der Sprung zwischen „vorher" und „nachher" bleibt (ein Drop
 * darf laut sein), nur die Delle in der Mitte wird gefüllt.
 */
function levelGrips(plan) {
  const ear = plan.dj.ear;
  if (!ear.rows || plan.steps.some((s) => s.param === 'trim')) return [];
  const per = { out: [], in: [] };
  let up = 0;
  let down = 0;
  for (const r of ear.rows) {
    if (r.po + r.pi < 1e-6) continue;
    let db = 0;
    if (r.lvl < ear.floor - 4 && r.lvl < r.avail - 4) {
      db = Math.min(3, ear.floor - 2 - r.lvl);
      up++;
    } else if (r.lvl > Math.max(ear.ceil, r.avail) + 2.5) {
      db = -Math.min(3, r.lvl - Math.max(ear.ceil, r.avail) - 1.5);
      down++;
    }
    if (db !== 0) per[r.po >= r.pi ? 'out' : 'in'].push([r.t, +db.toFixed(1)]);
  }
  const steps = plan.steps.map((s) => ({ ...s }));
  for (const d of ['out', 'in']) {
    const list = per[d];
    list.forEach(([t, db], i) => {
      steps.push(stepOf(t, d, 'trim', db, 0.25));
      const next = list[i + 1];
      if (!next || next[0] > t + 0.3) steps.push(stepOf(t + 0.25, d, 'trim', 0, 0.5));
    });
  }
  if (!up && !down) return [];
  return [{ steps, text: `Pegel gleicht der DJ aus (${up ? 'Loch angehoben' : ''}${up && down ? ', ' : ''}${down ? 'Berg abgesenkt' : ''}, höchstens 3 dB)` }];
}

/**
 * Griff „Einstieg verschieben"": den neuen ein paar Takte früher oder später im Song ansetzen, damit
 * zur Übergabe auch bei ihm eine Phrase beginnt (Intro-Takte überspringen oder einen Takt Vorlauf).
 */
function shiftGrips(plan, vb) {
  const ear = plan.dj.ear;
  if (ear.inPhrase || plan.beatmatch === false) return [];
  const start = vb.a.points?.startBar ?? 0;
  const out = [];
  for (const d of [-3, -2, -1, 1, 2, 3, 4, 5, 6, 7]) {
    const nb = plan.inBar + d;
    if (nb < start || nb > vb.end * 0.35) continue;
    const ib = ear.inPos + d - (vb.a.phraseOffset || 0);
    const off = ((ib % 4) + 4) % 4;
    if (Math.min(off, 4 - off) >= 0.3) continue;
    out.push({ inBar: nb, steps: plan.steps.map((s) => ({ ...s })), text: `neuer setzt ${d > 0 ? `${d} Takte später im Song` : `${-d} Takte früher im Song`} ein, damit beide Songs zugleich eine neue Phrase beginnen` });
  }
  return out;
}

/** Griff „weniger ist mehr": Echo/Hall, Filter und das Ausdünnen des alten Songs zurücknehmen. */
function gentleGrips(plan) {
  const tX = plan.dj.ear.tX;
  const has = (f) => plan.steps.some(f);
  const fx = (s) => s.deck === 'out' && (s.param === 'echo' || s.param === 'reverb') && s.to > 0.25;
  const fil = (s) => s.deck === 'out' && s.param === 'filter' && Math.abs(s.to) > 0.25 && s.at <= tX + 0.5;
  const thin = (s) => s.deck === 'out' && s.at < tX - 0.6 && ((s.param === 'mid' && s.to < -6 && s.to > -20) || (s.param === 'high' && s.to < -8 && s.to > -20));
  const out = [];
  const map = (f, g) => plan.steps.map((s) => (f(s) ? g(s) : { ...s }));
  if (has(fx)) out.push({ steps: map(fx, (s) => ({ ...s, to: +(s.to * 0.5).toFixed(2) })), text: 'Echo und Hall nur halb so stark' });
  if (has(fil)) out.push({ steps: map(fil, (s) => ({ ...s, to: +(s.to * 0.55).toFixed(2) })), text: 'Filter am alten Track nur halb so weit zugedreht' });
  const finIn = (s) => s.deck === 'in' && s.param === 'filter' && Math.abs(s.to) > 0.4;
  if (has(finIn)) out.push({ steps: map(finIn, (s) => ({ ...s, to: +(s.to * 0.5).toFixed(2) })), text: 'Filter am neuen nur halb so weit zu' });
  const vc = (s) => s.param === 'vocal' && s.to > 0.3;
  if (has(vc)) out.push({ steps: map(vc, (s) => ({ ...s, to: 0.3 })), text: 'Stimmen bleiben hörbar (Stimm-Filter nur leicht)' });
  if (has(vc)) out.push({ steps: map(vc, (s) => ({ ...s, to: 0 })), text: 'Stimmen werden nicht weggefiltert' });
  if (has(thin)) out.push({ steps: map(thin, (s) => ({ ...s, to: s.param === 'mid' ? -6 : -8 })), text: 'alter Track wird weniger stark ausgedünnt' });
  return out;
}

/**
 * Griff „auf der Eins voll da": Übernimmt der neue Song, steht er sofort – Bass und Fader mit einem
 * Griff statt über einen halben Takt gezogen, und sein Stimm-Filter ist in dem Moment offen. Sonst
 * klingt die Übergabe hohl und leise.
 */
function entryGrips(plan) {
  const tX = Math.round(plan.dj.ear.tX * 4) / 4;
  const near = (s) => s.at >= tX - 0.15 && s.at <= tX + 0.3;
  const slow = (s) => s.deck === 'in' && near(s) && (s.dur || 0) > 0.3 && ((s.param === 'low' && s.to > -3) || (s.param === 'fader' && s.to >= 0.95));
  const voc = (s) => s.deck === 'in' && s.param === 'vocal' && s.to === 0 && s.at > tX - 0.15 && s.at <= tX + 1.5 && (s.at > tX + 0.05 || (s.dur || 0) > 0.15);
  const hasSlow = plan.steps.some(slow);
  const hasVoc = plan.steps.some(voc);
  const out = [];
  // (ein Schlag statt ein halber Takt – ein harter Schnitt wäre wieder zu abrupt)
  const quick = (steps) => steps.map((s) => (slow(s) ? { ...s, dur: 0.25 } : { ...s }));
  const open = (steps) => steps.map((s) => (voc(s) ? { ...s, at: tX, dur: 0.1 } : { ...s }));
  if (hasSlow) out.push({ steps: quick(plan.steps), text: `der neue steht auf der Eins (Takt ${tX}) innerhalb eines Schlags voll da` });
  if (hasVoc) out.push({ steps: open(plan.steps), text: `Stimm-Filter des neuen geht schon zur Übergabe (Takt ${tX}) auf` });
  if (hasSlow && hasVoc) out.push({ steps: open(quick(plan.steps)), text: `der neue steht auf der Eins (Takt ${tX}) innerhalb eines Schlags voll da, sein Stimm-Filter ist dabei schon offen` });
  return out;
}

/**
 * Der DJ stellt einen Übergang selbst nach, statt ihn nur fertig zu übernehmen: Er probiert seine
 * Griffe am Mischpult, prüft jede Fassung erneut (`recheck` = Selbstcheck des Planers), hört sie ab
 * und behält nur, was besser klingt – Griff für Griff, bis nichts mehr besser wird.
 */
export function adapt(plan, va, vb, recheck, tasteWeight = 0.35) {
  if (!plan.dj?.ear) return plan;
  const mixable = ADAPT_TYPES.has(plan.type) && plan.beatmatch !== false;
  let best = plan;
  const done = [];
  for (let round = 0; round < 4; round++) {
    const base = best;
    let how = null;
    for (const v of [...shiftGrips(base, vb), ...gentleGrips(base), ...entryGrips(base), ...levelGrips(base), ...(mixable ? [...crispGrips(base), ...roomGrips(base, va)] : [])]) {
      const steps = [...v.steps].sort((x, y) => x.at - y.at);
      const alt = recheck({ ...base, ...(v.inBar !== undefined ? { inBar: v.inBar } : {}), steps, notes: [...base.notes], audit: undefined, dj: undefined });
      alt.dj = judge(alt, va, vb, tasteWeight);
      // (nie einen neuen Fehler einbauen: zwei Stimmen, abgeschnittene Zeile, Loch …)
      if (alt.audit.issues.length > base.audit.issues.length || alt.audit.penalty > base.audit.penalty + 0.05) continue;
      if (alt.dj.total > best.dj.total + 0.05) {
        best = alt;
        how = v;
      }
    }
    if (!how) break;
    if (!done.includes(how.text)) done.push(how.text);
  }
  if (best === plan) return plan;
  const ear = plan.dj.ear;
  const heard = `DJ hört: ${best.dj.ear.heard.join(', ')}${best.dj.ear.bad.length ? ` – ${best.dj.ear.bad.join(', ')}` : ''}`;
  const i = best.notes.findIndex((n) => n.startsWith('DJ hört:'));
  if (i >= 0) best.notes[i] = heard;
  else best.notes.push(heard);
  const gain = best.dj.ear.pre > ear.pre + 0.02 ? ` – der neue ist vor der Übergabe zu ${Math.round(best.dj.ear.pre * 100)} % statt ${Math.round(ear.pre * 100)} % zu hören` : '';
  best.notes.push(`DJ passt an: ${done.join('; ')}${gain}`);
  best.djScore = +best.dj.total.toFixed(2);
  best.adapted = true;
  return best;
}
