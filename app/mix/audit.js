// Selbstcheck für geplante Übergänge: Der Plan wird in Achteltakten "abgespielt" (nur Rechnung, kein
// Audio) und gemessen, was ein DJ sofort hören würde – zwei Stimmen gleichzeitig, zwei Basslines
// übereinander, ein Loch in der Lautstärke, ein Wechsel neben der Eins, eine abgeschnittene Zeile.
// Der Planer probiert mehrere Techniken, und die mit den wenigsten Problemen gewinnt.

const NEUTRAL = { fader: 1, low: 0, mid: 0, high: 0, filter: 0, vocal: 0, echo: 0 };
const STEP = 0.125;

/** Wert eines Reglers zum Zeitpunkt t (Takte) aus der Schrittliste eines Decks. */
function valueAt(list, t, start) {
  let v = start;
  for (const s of list) {
    if (t < s.at) break;
    const end = s.at + (s.dur || 0);
    if (t >= end || !s.dur) v = s.to;
    else v = v + (s.to - v) * ((t - s.at) / s.dur);
  }
  return v;
}

/**
 * @param plan  Ergebnis des Planers (steps, outBar, inBar, m, type)
 * @param va,vb TrackViews (vocalSmooth, energy, drums, isPhraseStart, end)
 */
export function auditPlan(plan, va, vb) {
  const steps = plan.steps;
  const params = { out: {}, in: {} };
  for (const s of steps) {
    if (!s.param) continue;
    (params[s.deck][s.param] ||= []).push(s);
  }
  for (const d of ['out', 'in']) for (const k of Object.keys(params[d])) params[d][k].sort((x, y) => x.at - y.at);
  const val = (d, k, t) => valueAt(params[d][k] || [], t, d === 'in' && k === 'fader' ? 0 : NEUTRAL[k]);

  const play = steps.find((s) => s.deck === 'in' && s.action === 'play');
  const tPlay = play ? play.at : 0;
  const inOffset = play?.barOffset || 0;
  const stopOut = steps.find((s) => s.deck === 'out' && s.action === 'stop')?.at ?? Infinity;
  const loopFrom = steps.find((s) => s.deck === 'out' && s.action === 'loop')?.at ?? Infinity;
  const t0 = Math.min(0, ...steps.map((s) => s.at));
  const t1 = Math.max(...steps.filter((s) => s.action !== 'rate').map((s) => s.at + (s.dur || 0)));
  const m = plan.m || 1;
  const quietStyle = plan.type === 'echo' || plan.type === 'cut' || plan.type === 'breakdown';

  const outGoneAt = steps.filter((s) => s.deck === 'out' && s.param === 'fader' && s.to <= 0.05).map((s) => s.at + (s.dur || 0));
  const tOutGone = outGoneAt.length ? Math.min(...outGoneAt) : null;
  let vocalClash = 0;
  let bassBoth = 0;
  let gap = 0;
  let sw = null;
  for (let t = t0; t <= t1 + 1e-9; t += STEP) {
    const outOn = t < stopOut;
    const inOn = t >= tPlay;
    const ob = plan.outBar + Math.min(t, loopFrom);
    const ib = plan.inBar + inOffset + (t - tPlay) * m;
    const fo = outOn ? val('out', 'fader', t) : 0;
    const fi = inOn ? val('in', 'fader', t) : 0;
    const thinO = val('out', 'filter', t) > 0.3 ? 0.6 : 1;
    const thinI = val('in', 'filter', t) > 0.3 ? 0.6 : 1;
    // Stimme: Gesang des Tracks x Fader x (Vocal-Cut dämpft die Mitte)
    const vo = fo * thinO * va.vocalSmooth(Math.floor(ob)) * (1 - 0.8 * val('out', 'vocal', t));
    const vi = fi * thinI * vb.vocalSmooth(Math.floor(ib)) * (1 - 0.8 * val('in', 'vocal', t));
    if (vo > 0.3 && vi > 0.3) vocalClash += STEP;
    // Bass: Tiefen nicht gekillt, Fader offen, im Track läuft ein Beat
    const bo = fo > 0.45 && val('out', 'low', t) > -12 && va.drums(Math.floor(ob)) > 0.35;
    const bi = fi > 0.45 && val('in', 'low', t) > -12 && vb.drums(Math.floor(ib)) > 0.35;
    if (bo && bi) bassBoth += STEP;
    // Lautstärke: Summe der Leistung beider Decks (relativ zur jeweiligen Takt-Lautheit)
    const lo = outOn ? 10 ** (va.energy(Math.floor(ob)) / 20) : 0;
    const li = inOn ? 10 ** (vb.energy(Math.floor(ib)) / 20) : 0;
    // Echo-/Hallfahne des alten Tracks klingt nach dem Ausblenden weiter und füllt die Lücke
    let tail = 0;
    if (tOutGone !== null && t > tOutGone) {
      const send = Math.max(val('out', 'echo', tOutGone - 0.1), val('out', 'reverb', tOutGone - 0.1));
      tail = 0.6 * send * Math.exp(-(t - tOutGone) / 0.75) * (10 ** (va.energy(Math.floor(plan.outBar + tOutGone - 0.5)) / 20));
    }
    const level = fo * fo * lo * lo + fi * fi * li * li + tail * tail;
    if (!quietStyle && t > t0 + 0.5 && t < t1 - 0.5 && level < 0.12) gap += STEP;
  }
  // Der hörbare Wechsel ist der Bass-Tausch (neuer Bass geht auf) – ohne Bass-Tausch der Moment,
  // in dem der alte Track verschwindet. Der muss auf der Eins liegen, nicht die Mitte eines Fades.
  const swapStep = steps.find((s) => s.deck === 'in' && s.param === 'low' && s.to > -3 && s.at >= tPlay)
    || steps.find((s) => s.deck === 'out' && s.param === 'fader' && s.to <= 0.05);
  if (swapStep) {
    const t = swapStep.at;
    sw = { t, ob: plan.outBar + Math.min(t, loopFrom), ib: plan.inBar + inOffset + (t - tPlay) * m };
  }

  // Wechsel auf der Eins – in beiden Tracks auf einer 4-Takt-Grenze
  let misaligned = 0;
  if (sw && plan.type !== 'ramp') { // (Rampe: Takte laufen dort nicht gleich schnell – eigene Rechnung)
    const onGrid = (bar, off) => Math.abs(((((bar - off) % 4) + 4) % 4) - 0) < 0.3 || Math.abs(((((bar - off) % 4) + 4) % 4) - 4) < 0.3;
    // Echo/Schnitt ohne Überlappung: ein ganzer Takt (Atempause im Gesang) reicht – die 4er-Phrase
    // zählt nur, wenn beide Tracks hörbar zusammen laufen
    const barOnly = quietStyle; // (auch der kurze Blend im Takt: höchstens 1,5 Takte gemeinsam)
    const wholeBar = Math.abs(sw.ob - Math.round(sw.ob)) < 0.1;
    if (barOnly ? !wholeBar : !onGrid(sw.ob, va.a.phraseOffset || 0)) misaligned += 1;
    // im neuen Track zählt die Phrase nur, wenn danach beide noch zusammen laufen – ist der alte beim
    // Wechsel praktisch weg (Refrain-Wechsel, Echo), fängt der neue einfach an seinem Anfang an
    const gone = steps.filter((s) => s.deck === 'out' && s.param === 'fader' && s.to <= 0.05).map((s) => s.at + (s.dur || 0));
    const together = Math.min(stopOut, t1, gone.length ? Math.min(...gone) : Infinity) - sw.t;
    // (startet der neue an seinem natürlichen Anfang und ist der alte binnen zwei Takten weg, passt es)
    const naturalStart = Math.abs(plan.inBar - (vb.a.points?.startBar ?? 0)) < 0.5 && together <= 2;
    if (plan.beatmatch !== false && together >= 1 && !naturalStart && !onGrid(sw.ib, vb.a.phraseOffset || 0)) misaligned += 0.5;
  }
  // Zeile abgeschnitten: der Gesang des alten Tracks wird unhörbar (Fader, Filter, Vocal-Cut, Loop),
  // während er gerade singt und weitersingen würde – beim Mitsingen das Schlimmste. Gilt für alle
  // Techniken, auch Echo-Out und Drop-Cut.
  let lineCut = 0;
  const sung = (bar) => va.vocal(bar) >= 0.4;
  const audible = (t) => {
    if (t >= stopOut) return 0;
    const f = val('out', 'filter', t);
    const filt = f < -0.4 ? 0.35 : f > 0.3 ? 0.6 : 1; // Tiefpass verschluckt die Stimme, Hochpass dünnt aus
    return val('out', 'fader', t) * filt * (1 - 0.8 * val('out', 'vocal', t));
  };
  let tGone = null;
  for (let t = t0; t <= t1 + 1 + 1e-9; t += STEP) {
    if (audible(t) < 0.3) {
      tGone = t;
      break;
    }
  }
  // ein Loop, der vorher einsetzt, unterbricht die Zeile schon dort
  const tCut = Math.min(tGone ?? Infinity, loopFrom);
  if (Number.isFinite(tCut)) {
    const ob = plan.outBar + tCut;
    const b = Math.floor(ob + 1e-6);
    const frac = ob - b;
    if (va.hasBeats) {
      // Songtext-Scan: auf den Schlag genau – läuft die Zeile über den Moment, in dem der Track weg ist?
      const k = Math.min(3, Math.floor(frac * 4 + 0.15));
      if (va.beatVocal(b, k) >= 0.4 && va.beatVocal(b, k - 1) >= 0.4) lineCut = 1;
    } else if (frac < 0.15 ? sung(b - 1) && sung(b) : sung(b) && frac < 0.9) lineCut = 1;
  }
  // neue Zeile des alten Tracks beginnt, solange er noch hörbar ist -> wird angeschnitten
  const tEnd = Math.min(tGone ?? t1, loopFrom);
  for (let t = Math.max(0, t0); t < tEnd - STEP / 2; t += 0.5) {
    const bar = Math.floor(plan.outBar + t);
    if (va.hasBeats) {
      // eine neue Zeile setzt ein (Schlag davor frei), während der alte Track noch deutlich zu hören ist
      for (let k = 0; k < 2; k++) {
        const x = plan.outBar + t + k * 0.25;
        const bb = Math.floor(x);
        const kk = Math.floor((x - bb) * 4);
        if (audible(t + k * 0.25) >= 0.5 && va.beatVocal(bb, kk) >= 0.5 && va.beatVocal(bb, kk - 1) < 0.3 && plan.outBar + tEnd - x > 0.5) lineCut = 1;
      }
    } else if (audible(t) >= 0.5 && va.vocal(bar) >= 0.5 && va.vocal(bar - 1) < 0.3 && plan.outBar + tEnd - bar < 3) lineCut = 1;
  }

  // Neuer Gesang setzt hart ein: der neue Track ist eben noch kaum zu hören und einen Takt später
  // singt er schon voll – ohne Vorlauf, Einblenden oder Filter. Klingt wie ein Schnitt in fremde
  // Lyrics und zerstört das Gefühl (ein natürlicher Gesangseinsatz nach dem Intro zählt nicht).
  let hardEntry = 0;
  const inAudible = (t) => {
    if (t < tPlay) return 0;
    const f = val('in', 'filter', t);
    // Filter als Verlauf (ein Tiefpass, der sich öffnet, macht die Stimme allmählich hörbar)
    return val('in', 'fader', t) * (f < 0 ? 1 + 0.75 * f : 1 - 0.6 * f);
  };
  const newVoice = (t) => {
    if (t < tPlay) return 0;
    const ib = plan.inBar + inOffset + (t - tPlay) * m;
    return inAudible(t) * (1 - 0.8 * val('in', 'vocal', t)) * vb.vocal(Math.floor(ib));
  };
  // hart = von "gerade hörbar" bis "singt laut" in weniger als einem Dreivierteltakt
  let tHeard = null;
  for (let t = Math.max(t0, tPlay); t <= t1 + 2 + 1e-9; t += STEP) {
    if (tHeard === null && inAudible(t) >= 0.15) tHeard = t;
    if (newVoice(t) >= 0.5) {
      if (tHeard === null || t - tHeard < 0.75) hardEntry = 1;
      break;
    }
  }

  // Übersprungene Hauptteile des alten Tracks (bei Clubmusik: der letzte Drop fehlt dann)
  let skippedMain = 0;
  const endAt = sw ? sw.ob : plan.outBar;
  for (let bar = Math.ceil(endAt); bar < va.end; bar++) if (va.label(bar) === 'main') skippedMain++;
  const shortForm = (plan.genres || []).slice(0, 1).some((g) => g === 'pop' || g === 'rap');
  const skipCost = skippedMain * (shortForm ? 0.004 : 0.02);

  const penalty = vocalClash * 0.35 + Math.max(0, bassBoth - 1) * 0.25 + gap * 0.8 + misaligned * 1.2 + lineCut * 2 + hardEntry * 0.9 + skipCost;
  const issues = [];
  if (vocalClash >= 1) issues.push(`${vocalClash.toFixed(1)} Takte zwei Stimmen gleichzeitig`);
  if (bassBoth > 1) issues.push(`${bassBoth.toFixed(1)} Takte zwei Basslines übereinander`);
  if (gap >= 0.5) issues.push(`${gap.toFixed(1)} Takte Lautstärke-Loch`);
  if (misaligned) issues.push('Wechsel nicht auf der Eins');
  if (lineCut) issues.push('alte Gesangszeile wird abgeschnitten');
  if (hardEntry) issues.push('neuer Gesang setzt hart ein');
  if (!shortForm && skippedMain >= 8) issues.push(`${skippedMain} Takte Hauptteil des alten Tracks übersprungen`);
  return { vocalClash, bassBoth, gap, misaligned, lineCut, hardEntry, skippedMain, penalty, issues };
}
