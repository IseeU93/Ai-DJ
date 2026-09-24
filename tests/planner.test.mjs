import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../app/analysis/analyze.js';
import { planTransition } from '../app/mix/planner.js';
import { assignEnergy, buildSetOrder, camelotDistance, keySync, shiftCamelot, tempoRelation } from '../app/mix/order.js';
import { synthSong } from './synth.mjs';

const SECTIONS = [
  { bars: 16, kick: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 8, pad: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 16, kick: true },
];

const cache = new Map();
function track(id, bpm, root = 57) {
  const k = `${bpm}-${root}`;
  if (!cache.has(k)) {
    const s = synthSong({ bpm, root, sections: SECTIONS, offset: 0.2 });
    cache.set(k, analyzeTrack(s.L, s.R, s.sr));
  }
  return { id, analysis: cache.get(k), energy: 0.5, genre: 'edm' };
}

test('Camelot & Tempo-Beziehungen', () => {
  assert.equal(camelotDistance('8A', '8A'), 0);
  assert.equal(camelotDistance('8A', '9A'), 0.1);
  assert.equal(camelotDistance('12A', '1A'), 0.1);
  assert.equal(camelotDistance('8A', '8B'), 0.15);
  assert.ok(camelotDistance('8A', '2B') > 0.6);
  assert.equal(tempoRelation(87, 174).m, 2);
  assert.equal(tempoRelation(128, 126).m, 1);
});

test('Blend: Outro des alten trifft Intro des neuen, Drop landet am Ende', () => {
  const out = track('a', 128);
  const inc = track('b', 126);
  const plan = planTransition({ out, inc, type: 'blend' });
  assert.equal(plan.beatmatch, true);
  assert.ok(Math.abs(plan.inRate - 128 / 126) < 0.002, `inRate ${plan.inRate}`);
  const a = out.analysis;
  assert.equal(plan.outBar, a.points.outroBar);
  assert.ok(plan.outBar + plan.bars <= a.points.lastBar + 1);
  // Drop des neuen Tracks genau am Übergangsende
  assert.equal(plan.inBar + plan.bars * plan.m, inc.analysis.points.dropBar);
  assert.ok(plan.steps.some((s) => s.param === 'low' && s.deck === 'out' && s.to < -20), 'Bass-Swap fehlt');
});

test('Zu großer Tempo-Sprung -> Echo-Out ohne Beatmatch', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('c', 100) });
  assert.equal(plan.type, 'echo', plan.type);
  assert.equal(plan.beatmatch, false);
  assert.equal(plan.inRate, 1);
});

test('Instrumentale Intros/Outros -> sauberer Blend bevorzugt', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64) });
  assert.equal(plan.type, 'blend', `gewählt: ${plan.type}`);
});

test('Lyrics-Wechsel bei zwei Gesangs-Tracks, wenn schon zweimal geblendet wurde', () => {
  // Gesang des neuen Tracks erst nach seinem Drop -> kein Tausch möglich, sauber auf Blend
  const late = planTransition({ out: track('a', 128), inc: track('b', 128, 64), type: 'vocal' });
  assert.equal(late.type, 'blend', late.reason);
  // Gesang schon im Intro -> Lyrics-Wechsel vor dem Drop
  const vocalIntro = [
    { bars: 16, kick: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true, vocal: true },
    { bars: 16, kick: true },
  ];
  const plan = planTransition({ out: track('a', 128), inc: trackWith('vi', 128, vocalIntro, 64), type: 'vocal' });
  assert.equal(plan.type, 'vocal', plan.reason);
  const tDrop = (plan.inBar < 16 ? 16 - plan.inBar : 0);
  assert.ok(plan.steps.filter((s) => s.deck === 'out').every((s) => s.at + (s.dur || 0) <= tDrop + 1e-9), 'alter Track nach dem Drop');
});

test('Abwechslung: gleicher Typ wird nicht dreimal hintereinander gewählt', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 128, 64), history: ['vocal', 'vocal'] });
  assert.notEqual(plan.type, 'vocal');
});

test('Loop-Mix: loopt eine gesangsfreie Groove-Stelle, Drop des neuen Tracks am Ende', () => {
  const out = track('a', 128);
  const inc = track('b', 127);
  const plan = planTransition({ out, inc, type: 'loop' });
  const loops = plan.steps.filter((s) => s.action === 'loop');
  assert.ok([4, 8].includes(loops[0].bars), `loop ${loops[0].bars}`);
  const a = out.analysis;
  const lb = plan.outBar + loops[0].anchor;
  const voc = Array.from(a.vocals).slice(lb, lb + loops[0].bars);
  assert.ok(Math.max(...voc) < 0.5, `Gesang im Loop ${voc}`);
  assert.equal(plan.inBar + plan.bars * plan.m, inc.analysis.points.dropBar);
  assert.ok(plan.notes.length >= 2);
});

test('Loop-Mix mit Energie-Anstieg endet mit kurzem Loop-Roll in den Drop', () => {
  const out = { ...track('a', 128), energy: 0.3 };
  const inc = { ...track('b', 127), energy: 0.8 };
  const plan = planTransition({ out, inc, type: 'loop' });
  const loops = plan.steps.filter((s) => s.action === 'loop').map((s) => s.bars);
  assert.deepEqual(loops.slice(1), [1, 0.5, 0.25]);
});

test('Frühester Takt: beste Stelle ab dort, auf dem 4-Takt-Raster', () => {
  const out = track('a', 128);
  const plan = planTransition({ out, inc: track('b', 126), type: 'blend', earliestBar: 20.3 });
  assert.equal((plan.outBar - out.analysis.phraseOffset) % 4, 0);
  assert.ok(plan.outBar >= 20.3, `outBar ${plan.outBar}`);
});

test('Mix-Punkt nicht stur am Ende: Drop-Swap, wenn der alte Track noch einen Drop hätte', () => {
  // alter Track: Break (Takt 40-47) und danach letzter Drop bei 48, der neue hat 16 Takte Intro
  const sections = [
    { bars: 16, kick: true },
    { bars: 24, kick: true, bass: true, pad: true },
    { bars: 8, pad: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const out = trackWith('d', 128, sections);
  const plan = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const lastDrop = out.analysis.points.drops.at(-1);
  assert.ok(plan.outBar + plan.bars <= lastDrop, `Mix endet bei ${plan.outBar + plan.bars}, alter Drop bei ${lastDrop}: ${plan.notes.join(' | ')}`);
  assert.ok(plan.notes.some((n) => n.includes('Drop-Swap') || n.includes('Break')), plan.notes.join(' | '));
});

test('Set-Reihenfolge: ruhiger Start, harmonische Nachbarn', () => {
  const keys = ['8A', '3B', '9A', '10A', '4B', '8A', '9A'];
  const tracks = keys.map((k, i) => ({
    id: `t${i}`,
    analysis: {
      bpm: 124 + (i % 3),
      key: { camelot: k },
      intensity: i,
      bassWeight: i,
      brightness: 0,
    },
  }));
  assignEnergy(tracks);
  const order = buildSetOrder(tracks);
  assert.equal(order.length, tracks.length);
  assert.equal(new Set(order).size, tracks.length);
  assert.ok(order[0].energy <= 0.35, `Start-Energie ${order[0].energy}`);
  let clashes = 0;
  for (let i = 1; i < order.length; i++) {
    if (camelotDistance(order[i - 1].analysis.key.camelot, order[i].analysis.key.camelot) > 0.4) clashes++;
  }
  assert.ok(clashes <= 2, `clashes ${clashes}: ${order.map((t) => t.analysis.key.camelot)}`);
});

test('Set-Reihenfolge: laufender Track bleibt vorne', () => {
  const tracks = ['8A', '9A', '10A', '11A'].map((k, i) => ({
    id: `t${i}`, analysis: { bpm: 125, key: { camelot: k }, intensity: i, bassWeight: 0, brightness: 0 },
  }));
  assignEnergy(tracks);
  const order = buildSetOrder(tracks, [tracks[3]]);
  assert.equal(order[0], tracks[3]);
});

test('Erzwungener Blend bei großem Tempo-Sprung wird zu Echo-Out', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('c', 100), type: 'blend' });
  assert.equal(plan.type, 'echo');
  assert.match(plan.reason, /Echo-Out/);
});

test('Erzwungener Blend bei 12 % Tempo-Unterschied wird trotzdem angeglichen', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('d', 113), type: 'blend' });
  assert.equal(plan.type, 'blend');
  assert.equal(plan.beatmatch, true);
});

const SHORT_OUTRO = [
  { bars: 16, kick: true },
  { bars: 32, kick: true, bass: true, pad: true, vocal: true },
  { bars: 4, kick: true },
];

function trackWith(id, bpm, sections, root = 57) {
  const s = synthSong({ bpm, root, sections, offset: 0.2 });
  return { id, analysis: analyzeTrack(s.L, s.R, s.sr), energy: 0.5, genre: 'edm' };
}

test('Blend verlängert ein zu kurzes Outro per Loop auf gesangsfreien Takten', () => {
  const out = trackWith('s', 128, SHORT_OUTRO);
  const plan = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const loop = plan.steps.find((s) => s.action === 'loop');
  assert.ok(loop, 'kein Loop');
  assert.ok(plan.notes.some((n) => n.includes('Loop')), plan.notes.join(' | '));
});

test('Gesang wird abgesenkt, wenn sich zwei Stimmen überlagern würden', () => {
  const vocalIntro = [
    { bars: 16, kick: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  // Normalfall: der Planer steigt erst nach dem Gesang des alten Tracks ein -> kein Konflikt
  const out = trackWith('s', 128, SHORT_OUTRO);
  const inc = trackWith('v', 128, vocalIntro, 64);
  const clean = planTransition({ out, inc, type: 'blend' });
  assert.ok(clean.outBar >= out.analysis.points.vocalLast, `outBar ${clean.outBar}`);
  // "Jetzt mixen" mitten im Gesang: Stimme des neuen Tracks wird abgesenkt
  const now = planTransition({ out, inc, type: 'blend', earliestBar: 20, instant: true });
  assert.ok(now.steps.some((s) => s.param === 'vocal' && s.to === 1), now.notes.join(' | '));
});

test('Jetzt mixen (sofort): nächster Takt – aber nicht mitten im Drop, keine Vorlauf-Schritte', () => {
  const out = track('a', 128);
  for (const type of ['blend', 'loop', 'cut', 'echo', 'filter']) {
    // Takt 34 liegt im Break -> sofort auf dem nächsten Takt
    const now = planTransition({ out, inc: track('b', 126), type, earliestBar: 34.2, instant: true });
    assert.equal(now.outBar, 35, `${type}: outBar ${now.outBar}`);
    // Takt 30 liegt im Drop -> wartet bis zu dessen Ende (Takt 32)
    const plan = planTransition({ out, inc: track('b', 126), type, earliestBar: 30.2, instant: true });
    assert.equal(plan.outBar, 32, `${type}: outBar ${plan.outBar}`);
    assert.ok(plan.steps.every((s) => s.at >= 0), type);
  }
});

test('Übergang passt sich der Intro-Länge des neuen Tracks an', () => {
  const shortIntro = [
    { bars: 8, kick: true },
    { bars: 32, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const out = track('a', 128);
  const long = planTransition({ out, inc: track('b', 128), type: 'blend' });
  const short = planTransition({ out, inc: trackWith('i', 128, shortIntro), type: 'blend' });
  assert.equal(long.bars, 16);
  assert.equal(short.bars, 8);
});

test('Alter Track ist immer vor dem ersten Drop des neuen komplett weg', () => {
  const out = track('a', 128);
  for (const type of ['blend', 'loop', 'filter', 'vocal']) {
    const inc = track('b', 127, 64);
    const plan = planTransition({ out, inc, type });
    const drop = inc.analysis.points.drops.find((d) => d > plan.inBar);
    const tDrop = (drop - plan.inBar) / plan.m;
    const outSteps = plan.steps.filter((s) => s.deck === 'out');
    assert.ok(outSteps.every((s) => s.at + (s.dur || 0) <= tDrop + 1e-9), `${type}: ${JSON.stringify(outSteps.at(-1))} tDrop ${tDrop}`);
    const fades = outSteps.filter((s) => s.param === 'fader');
    assert.equal(fades.at(-1).to, 0, type);
  }
});

test('Reshuffle liefert andere, aber gültige Reihenfolgen', () => {
  const keys = ['8A', '9A', '10A', '8B', '9B', '7A', '8A', '11A'];
  const tracks = keys.map((k, i) => ({ id: `t${i}`, analysis: { bpm: 124 + (i % 3), key: { camelot: k }, intensity: i, bassWeight: i % 4, brightness: 0 } }));
  assignEnergy(tracks);
  const best = buildSetOrder(tracks).map((t) => t.id).join();
  const variants = new Set([1, 2, 3, 4, 5].map((s) => buildSetOrder(tracks, [], s * 7919).map((t) => t.id).join()));
  assert.ok([...variants].some((v) => v !== best), 'keine Variante');
  for (const v of variants) assert.equal(new Set(v.split(',')).size, tracks.length);
});

test('Key-Sync: Tonart-Clash wird per Halbton-Verschiebung harmonisch', () => {
  assert.equal(shiftCamelot('8B', 1), '3B'); // C -> C#
  assert.equal(shiftCamelot('8A', -1), '1A'); // Am -> G#m
  const ks = keySync('8A', '3A'); // Am vs Bbm: 1 Halbton daneben
  assert.equal(ks.semis, -1);
  assert.ok(ks.dist <= 0.1);
  assert.equal(keySync('8A', '9A').semis, 0); // passt schon -> nicht verschieben
});

test('Mittlerer Tempo-Sprung (12 %) -> sauberer Drop-Cut statt Echo', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('d', 113) });
  assert.equal(plan.type, 'cut', plan.type);
});

test('Leises Ausklingen am Ende: kein Loop, der laut/leise springt, Übergang endet vor dem Fade', () => {
  const s = synthSong({ bpm: 128, root: 57, offset: 0.2, sections: [
    { bars: 16, kick: true },
    { bars: 32, kick: true, bass: true, pad: true },
    { bars: 12, kick: true, bass: true, pad: true },
  ] });
  // letzte 12 Takte langsam ausblenden
  const beat = 60 / 128;
  const fadeStart = Math.round((0.2 + 48 * 4 * beat) * s.sr);
  for (let i = fadeStart; i < s.L.length; i++) {
    const g = Math.max(0.02, 1 - (i - fadeStart) / (s.L.length - fadeStart));
    s.L[i] *= g * g;
    s.R[i] *= g * g;
  }
  const out = { id: 'f', analysis: analyzeTrack(s.L, s.R, s.sr), energy: 0.5 };
  const a = out.analysis;
  for (const type of ['blend', 'loop', 'filter']) {
    const plan = planTransition({ out, inc: track('b', 128), type });
    for (const l of plan.steps.filter((x) => x.action === 'loop')) {
      const bar = plan.outBar + l.anchor;
      const e = Array.from(a.barEnergy).slice(bar, bar + Math.max(1, l.bars));
      assert.ok(Math.max(...e) - Math.min(...e) <= 2.5, `${type}: Loop über ungleich laute Takte ${e}`);
    }
    const lastOutBar = plan.outBar + plan.bars;
    assert.ok(a.barEnergy[Math.min(a.barCount - 1, lastOutBar - 1)] > -9 || plan.steps.some((x) => x.action === 'loop'),
      `${type}: Übergang reicht in den Fade (bis Takt ${lastOutBar})`);
  }
});

test('Musikrichtung steuert den Übergang: Hardstyle/Rap kurz, House lang', () => {
  const out = track('a', 128);
  const inc = track('b', 128, 64);
  const house = planTransition({ out, inc, type: 'blend' });
  const hard = planTransition({ out: { ...out, genre: 'hardstyle' }, inc: { ...inc, genre: 'hardstyle' }, type: 'blend' });
  const rap = planTransition({ out: { ...out, genre: 'rap' }, inc: { ...inc, genre: 'rap' } });
  assert.ok(house.bars >= 16, `house ${house.bars}`);
  assert.ok(hard.bars <= 8, `hardstyle ${hard.bars}`);
  assert.ok(rap.bars <= 8, `rap ${rap.bars}`);
  assert.ok(rap.notes.some((n) => n.includes('Rap')));
});

test('Nie mitten in einen vollen Hauptteil reinmixen', () => {
  const out = track('a', 128);
  const plan = planTransition({ out, inc: track('b', 127), type: 'blend' });
  const lab = (bar) => [...out.analysis.phrases].reverse().find((p) => p.bar <= bar)?.label;
  assert.ok(!(lab(plan.outBar) === 'main' && lab(plan.outBar - 1) === 'main'), `Einstieg bei Takt ${plan.outBar}`);
});

test('Niemals mitten im vollen Drop des alten Tracks wechseln (auch nicht bei "Jetzt mixen")', () => {
  const out = track('a', 128);
  const a = out.analysis;
  const full = (bar) => {
    const ph = [...a.phrases].reverse().find((x) => x.bar <= bar);
    return ph?.label === 'main' && a.barDrums[bar] >= 0.55 && a.barEnergy[bar] > -4;
  };
  for (const type of ['blend', 'filter', 'loop']) {
    const plan = planTransition({ out, inc: track('b', 127), type });
    for (let bar = plan.outBar; bar < plan.outBar + plan.bars && bar < a.barCount; bar++) {
      if (!plan.steps.some((s) => s.action === 'loop')) assert.ok(!full(bar), `${type}: Takt ${bar} ist voller Drop`);
    }
  }
  // "Jetzt mixen" mitten im Drop (Takt 42) wartet bis nach dem Drop
  const now = planTransition({ out, inc: track('b', 127), type: 'blend', earliestBar: 42, instant: true });
  assert.ok(!full(now.outBar), `Jetzt-mixen startet in Takt ${now.outBar}`);
});

test('Vocal-Übergabe: letzte Zeile des alten, dann erste Zeile des neuen', () => {
  const pop = [
    { bars: 8, kick: true },
    { bars: 8, kick: true, vocal: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true, vocal: true },
    { bars: 8, kick: true },
  ];
  const out = { ...trackWith('p1', 100, pop), genre: 'pop' };
  const inc = { ...trackWith('p2', 100, pop, 64), genre: 'pop' };
  const plan = planTransition({ out, inc, type: 'handoff' });
  assert.equal(plan.type, 'handoff', plan.reason);
  const hand = plan.steps.find((s) => s.deck === 'in' && s.param === 'vocal' && s.to === 0 && s.at > 0);
  const outFade = plan.steps.find((s) => s.deck === 'out' && s.param === 'fader' && s.to === 0);
  assert.ok(hand && outFade && Math.abs(hand.at - outFade.at) < 0.01, 'Übergabe nicht gleichzeitig');
});

test('Teaser: neuer Track startet einen Takt vorher leise, ohne Bass und Gesang, ohne Lautstärke-Loch', () => {
  const longIntro = [
    { bars: 24, kick: true },
    { bars: 32, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const plan = planTransition({ out: track('a', 128), inc: trackWith('li', 127, longIntro), type: 'blend' });
  const play = plan.steps.find((s) => s.action === 'play');
  assert.equal(play.at, -1);
  assert.equal(play.barOffset, -plan.m);
  const faders = plan.steps.filter((s) => s.deck === 'in' && s.param === 'fader');
  assert.ok(faders.every((s) => !(s.at === 0 && !s.dur && s.to === 0)), 'Fader fällt bei Takt 0 auf 0');
  assert.ok(plan.steps.some((s) => s.at === -1 && s.param === 'low' && s.to < -20));
});

test('Langes ereignisloses Outro wird nicht komplett ausgespielt', () => {
  const longOutro = [
    { bars: 16, kick: true },
    { bars: 32, kick: true, bass: true, pad: true },
    { bars: 32, kick: true },
  ];
  const out = trackWith('lo', 128, longOutro);
  const plan = planTransition({ out, inc: track('b', 128), type: 'blend' });
  assert.ok(plan.outBar <= 48 + 8, `wartet bis Takt ${plan.outBar} (Hauptteil endet bei 48, Track bei 80)`);
});

test('Teaser ohne Vorlauf-Material: erster Takt wird leise angeteasert', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('b', 127), type: 'blend' });
  if (plan.inBar - plan.m >= 0) return; // hier gibt es doch Vorlauf
  const f = plan.steps.filter((s) => s.deck === 'in' && s.param === 'fader' && s.dur);
  assert.ok(f.some((s) => s.at === 0 && s.to <= 0.3), 'kein leiser erster Takt');
});

test('Nie im Build-up mixen – weder im alten noch über den Build-up des neuen', () => {
  // alter Track: Break -> Build-up (steigende Drums) -> Drop -> Outro
  const withBuild = [
    { bars: 16, kick: true },
    { bars: 24, kick: true, bass: true, pad: true },
    { bars: 8, pad: true },
    { bars: 8, kick: true, pad: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true },
  ];
  const out = trackWith('bu', 128, withBuild);
  const a = out.analysis;
  const buildBars = [];
  for (const ph of a.phrases) if (ph.label === 'build') for (let b = ph.bar; b < ph.bar + ph.bars; b++) buildBars.push(b);
  for (const type of ['blend', 'filter', 'loop']) {
    const plan = planTransition({ out, inc: track('b', 128), type });
    for (let bar = Math.floor(plan.outBar); bar < plan.outBar + plan.bars; bar++) {
      assert.ok(!buildBars.includes(bar), `${type}: mixt im Build-up (Takt ${bar}), Build ${buildBars}`);
    }
  }
  // neuer Track mit Build-up vor dem Drop: alter Track ist vorher weg
  const inc = trackWith('bi', 128, [{ bars: 16, kick: true }, { bars: 8, kick: true, pad: true }, { bars: 24, kick: true, bass: true, pad: true }, { bars: 8, kick: true }]);
  const b = inc.analysis;
  const build = b.phrases.find((ph) => ph.label === 'build');
  if (build) {
    const plan = planTransition({ out: track('a', 128), inc, type: 'blend' });
    const tBuild = (build.bar - plan.inBar) / plan.m;
    if (tBuild >= 4) {
      const outEnd = Math.max(...plan.steps.filter((s) => s.deck === 'out').map((s) => s.at + (s.dur || 0)));
      assert.ok(outEnd <= tBuild + 1e-9, `alter Track läuft bis ${outEnd}, Build-up ab ${tBuild}`);
    }
  }
});

test('Einblend-Pegel folgt der Lautheit: leises Intro unter lautem Outro wird lauter eingeblendet', () => {
  const loudOutro = [{ bars: 16, kick: true }, { bars: 32, kick: true, bass: true, pad: true }, { bars: 16, kick: true, bass: true, pad: true, snare: true }];
  const quietIntro = [{ bars: 16, pad: true }, { bars: 32, kick: true, bass: true, pad: true }, { bars: 16, kick: true }];
  const plan = planTransition({ out: trackWith('lo2', 128, loudOutro), inc: trackWith('qi', 128, quietIntro), type: 'blend' });
  const fadeIn = plan.steps.find((s) => s.deck === 'in' && s.param === 'fader' && s.dur && s.to > 0.3);
  assert.ok(fadeIn.to >= 0.85, `Einblend-Pegel ${fadeIn.to}`);
});

test('Starke Tempo-Anpassung hält die Überlappung kurz', () => {
  const plan = planTransition({ out: track('a', 128), inc: track('d', 120), type: 'blend' });
  assert.ok(plan.bars <= 8, `bars ${plan.bars}`);
});

test('Nicht während kräftigem Gesang wegmischen und keinen späteren Refrain überspringen', () => {
  const lateChorus = [
    { bars: 16, kick: true },
    { bars: 16, kick: true, bass: true, pad: true, vocal: true },
    { bars: 8, pad: true },
    { bars: 16, kick: true, bass: true, pad: true },
    { bars: 16, kick: true, vocal: true },
    { bars: 16, kick: true },
  ];
  const out = trackWith('lc', 128, lateChorus);
  const a = out.analysis;
  const vs = (bar) => ((a.vocals[bar - 1] ?? 0) + 2 * (a.vocals[bar] ?? 0) + (a.vocals[bar + 1] ?? 0)) / 4;
  for (const type of ['blend', 'filter']) {
    const plan = planTransition({ out, inc: track('b', 128), type });
    for (let bar = Math.floor(plan.outBar); bar < plan.outBar + plan.bars && bar < a.barCount; bar++) {
      assert.ok(vs(bar) < 0.6, `${type}: mischt bei kräftigem Gesang weg (Takt ${bar})`);
    }
    assert.ok(plan.outBar >= (a.points.vocalLast ?? 0) - 1, `${type}: überspringt Gesang (Mix ab ${plan.outBar}, Gesang bis ${a.points.vocalLast})`);
  }
});

// Pop-Song wie "Blank Space": kurzes Intro, Gesang fast durchgehend, Refrains, Bridge, kurzes Outro
const POP = [
  { bars: 4, kick: true, pad: true },
  { bars: 16, kick: true, bass: true, vocal: true },
  { bars: 8, kick: true, bass: true, pad: true, vocal: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 16, kick: true, bass: true, vocal: true },
  { bars: 8, kick: true, bass: true, pad: true, vocal: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 8, pad: true, vocal: true },
  { bars: 16, kick: true, bass: true, pad: true, vocal: true },
  { bars: 4, kick: true, pad: true },
];
function popTrack(id, bpm, root) {
  const k = `pop-${bpm}-${root}`;
  if (!cache.has(k)) {
    const s = synthSong({ bpm, root, sections: POP, offset: 0.2, seed: root });
    cache.set(k, analyzeTrack(s.L, s.R, s.sr));
  }
  return { id, analysis: cache.get(k), energy: 0.5, genre: 'pop' };
}

test('Pop: Refrain-Wechsel nach ~2/3 des Songs, neuer Song von vorn, nie zwei Stimmen', () => {
  const out = popTrack('p1', 96, 57);
  const inc = popTrack('p2', 98, 60);
  const plan = planTransition({ out, inc });
  const E = out.analysis.points.lastBar + 1;
  assert.equal(plan.type, 'chorus', `gewählt: ${plan.type}`);
  const swap = plan.outBar + plan.bars;
  assert.ok(swap / E > 0.55 && swap / E < 0.88, `Wechsel bei Takt ${swap} von ${E}`);
  assert.equal(plan.inBar, inc.analysis.points.startBar ?? 0, 'neuer Song startet nicht am Anfang');
  // neuer Gesang bleibt stumm, solange der alte Track noch voll da ist
  const vocalOn = plan.steps.find((s) => s.deck === 'in' && s.param === 'vocal' && s.to === 0);
  const outGone = plan.steps.find((s) => s.deck === 'out' && s.param === 'fader' && s.to === 0);
  assert.ok(vocalOn.at >= outGone.at, 'zwei Stimmen gleichzeitig');
});

test('Set-Reihenfolge: gleicher Künstler nicht direkt hintereinander, keine Genre-Pingpongs', () => {
  const base = track('x', 128).analysis;
  const mk = (id, artist, genre, energy) => ({ id, artist, genre, energy, analysis: base });
  const list = [
    mk(1, 'Taylor Swift', 'pop', 0.3), mk(2, 'Taylor Swift', 'pop', 0.35), mk(3, 'Taylor Swift feat. X', 'pop', 0.4),
    mk(4, 'Dua Lipa', 'pop', 0.5), mk(5, 'Ed Sheeran', 'pop', 0.45), mk(6, 'Angerfist', 'uptempo', 0.95),
    mk(7, 'Dr. Peacock', 'uptempo', 0.9), mk(8, 'Harris', 'pop', 0.55), mk(9, 'Weeknd', 'pop', 0.6),
  ];
  const order = buildSetOrder(list);
  for (let i = 0; i + 1 < order.length; i++) {
    const a = order[i].artist.split(' feat')[0];
    assert.notEqual(a, order[i + 1].artist.split(' feat')[0], `Künstler doppelt bei ${i}`);
  }
  const genres = order.map((t) => t.genre);
  const switches = genres.filter((g, i) => i && g !== genres[i - 1]).length;
  assert.ok(switches <= 2, `Genre-Wechsel: ${genres.join(' ')}`);
});

test('Set-Reihenfolge bleibt auch bei 150 Tracks schnell', () => {
  const base = track('x', 128).analysis;
  const list = Array.from({ length: 150 }, (_, i) => ({
    id: i, artist: `A${i % 40}`, genre: ['pop', 'edm', 'rap'][i % 3], energy: (i * 37 % 100) / 100,
    analysis: { ...base, bpm: 100 + (i * 13) % 40, key: { camelot: `${(i % 12) + 1}${i % 2 ? 'A' : 'B'}` } },
  }));
  const t0 = performance.now();
  buildSetOrder(list);
  buildSetOrder(list, [], 3);
  const ms = performance.now() - t0;
  assert.ok(ms < 8000, `${ms.toFixed(0)} ms`);
});

test('Freie Techniken: Mashup, Mashup andersrum, Loop-Roll liefern echte Pläne', () => {
  const out = track('a', 128);
  const inc = track('b', 127);
  for (const type of ['mashup', 'mashin', 'roll']) {
    const plan = planTransition({ out, inc, type });
    assert.equal(plan.type, type, `${type} fiel zurück: ${plan.reason}`);
    assert.ok(plan.steps.some((s) => s.action === 'play' && s.deck === 'in'));
    assert.ok(plan.steps.some((s) => s.action === 'stop' && s.deck === 'out'));
  }
  const roll = planTransition({ out, inc, type: 'roll' });
  const loops = roll.steps.filter((s) => s.action === 'loop').map((s) => s.bars);
  assert.deepEqual(loops, [0.25, 0.125, 0.0625], 'Roll wird nicht schneller');
  const mash = planTransition({ out, inc, type: 'mashup' });
  assert.ok(mash.steps.some((s) => s.deck === 'out' && s.param === 'low' && s.to <= -20), 'alter Beat nicht weggefiltert');
  assert.ok(mash.steps.some((s) => s.deck === 'in' && s.param === 'vocal' && s.to === 1), 'neue Stimme nicht stumm');
});

import { planTrick } from '../app/mix/freestyle.js';

test('Freestyle: Hin und her wechselt den Groove mehrmals, Tricks lösen sich auf der Eins auf', () => {
  const out = track('a', 128);
  const inc = track('b', 127);
  const plan = planTransition({ out, inc, type: 'pingpong' });
  assert.equal(plan.type, 'pingpong', plan.reason);
  const inBass = plan.steps.filter((s) => s.deck === 'in' && s.param === 'low').map((s) => s.to);
  assert.ok(inBass.filter((v) => v === 0).length >= 2 && inBass.includes(-26), `Bass pendelt nicht: ${inBass}`);
  // Freestyle wählt öfter mal etwas anderes als den Standard-Blend
  const types = new Set();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    types.add(planTransition({ out: { ...out, id: `o${id}` }, inc: { ...inc, id }, freestyle: true }).type);
  }
  assert.ok(types.size >= 2, `immer ${[...types]}`);
  const a = out.analysis;
  for (let d = 0; d < 1; d += 0.1) {
    const t = planTrick(a, 10, d);
    if (!t) continue;
    assert.ok(t.bar >= 12 && a.phrases.some((ph) => ph.bar === t.bar), 'Trick nicht an Phrasengrenze');
    const last = t.steps[t.steps.length - 1];
    assert.equal(last.at, 0, 'Trick endet nicht auf der Eins');
  }
});
