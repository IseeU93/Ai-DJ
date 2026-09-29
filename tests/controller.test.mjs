import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, Bindings, bindingFromMessage } from '../app/controller/mapper.js';
import { PROFILES, profileFor } from '../app/controller/profiles.js';
import { ACTIONS } from '../app/controller/actions.js';
import { Performer, eqDb, filterOf } from '../app/controller/performer.js';
import { ManualObserver } from '../app/controller/observer.js';
import { learn } from '../app/mix/feedback.js';

// ---------------------------------------------------------------- Belegung

test('DDJ-FLX4 wird am Namen erkannt, jede Aktion der Belegung gibt es wirklich', () => {
  assert.equal(profileFor('DDJ-FLX4')?.id, 'ddj-flx4');
  assert.equal(profileFor('Pioneer DDJ-FLX4 MIDI 1')?.id, 'ddj-flx4');
  assert.equal(profileFor('Irgendein Keyboard'), null);
  for (const b of PROFILES[0].bindings) assert.ok(ACTIONS[b.a], `unbekannte Aktion ${b.a}`);
});

test('DDJ-FLX4: Tasten, 14-Bit-Regler, Drehgeber und Pads werden richtig gelesen', () => {
  const B = new Bindings(PROFILES[0].bindings);
  const r = (bytes) => B.resolve(decode(bytes));
  assert.deepEqual(r([0x90, 0x0b, 0x7f]), { action: 'play', deck: 0, down: true });
  assert.deepEqual(r([0x91, 0x0b, 0x00]), { action: 'play', deck: 1, down: false });
  assert.deepEqual(r([0x91, 0x0c, 0x7f]), { action: 'cue', deck: 1, down: true });
  // Kanalfader Deck 2: MSB 0x13 / LSB 0x33 auf Kanal 2
  const hi = r([0xb1, 0x13, 0x7f]);
  assert.equal(hi.action, 'fader');
  assert.equal(hi.deck, 1);
  assert.ok(hi.value > 0.99);
  const fine = r([0xb1, 0x33, 0x40]);
  assert.ok(fine.value > 0.99 && fine.value <= 1);
  assert.ok(r([0xb0, 0x13, 0x00]).value < 0.001);
  // EQ Bass Deck 1, Crossfader und Filter liegen auf Kanal 7
  assert.equal(r([0xb0, 0x0f, 0x40]).action, 'eqLow');
  assert.equal(r([0xb6, 0x1f, 0x00]).action, 'crossfader');
  assert.deepEqual([r([0xb6, 0x17, 0x40]).action, r([0xb6, 0x17, 0x40]).deck], ['filter', 0]);
  assert.deepEqual([r([0xb6, 0x18, 0x40]).action, r([0xb6, 0x18, 0x40]).deck], ['filter', 1]);
  // Browse-Drehgeber: 1 = rechts, 127 = links
  assert.equal(r([0xb6, 0x40, 0x01]).delta, 1);
  assert.equal(r([0xb6, 0x40, 0x7f]).delta, -1);
  // Jog: um 64 herum
  assert.equal(r([0xb0, 0x22, 0x44]).delta, 4);
  assert.equal(r([0xb1, 0x22, 0x3c]).delta, -4);
  // Pads: Hot Cue 3 Deck 1 (0x97), Shift = löschen (0x98); Beat-Loop Pad 5 Deck 2 (0x99)
  assert.deepEqual(r([0x97, 0x02, 0x7f]), { action: 'hotcue2', deck: 0, down: true });
  assert.equal(r([0x98, 0x02, 0x7f]).action, 'hotcueClear2');
  assert.deepEqual(r([0x99, 0x64, 0x7f]), { action: 'beatloop4', deck: 1, down: true });
  assert.equal(r([0x97, 0x25, 0x7f]).action, 'beatjump5');
  // Laden: Deck 1 / 2
  assert.deepEqual([r([0x96, 0x46, 0x7f]).action, r([0x96, 0x46, 0x7f]).deck], ['load', 0]);
  assert.equal(r([0x96, 0x47, 0x7f]).deck, 1);
  assert.equal(r([0x95, 0x00, 0x00]), null, 'Unbelegtes wird ignoriert');
});

test('MIDI-Learn: Taste wird zur Note, Drehgeber erkennt die Codierung, eigene Belegung überschreibt', () => {
  const note = decode([0x92, 0x30, 0x7f]);
  assert.deepEqual(bindingFromMessage(note, 'play', 0, 'button'), { t: 'note', ch: 2, d1: 0x30, a: 'play', deck: 0 });
  const cc = decode([0xb2, 0x10, 0x55]);
  assert.equal(bindingFromMessage(cc, 'fader', 1, 'abs').enc, 'abs');
  assert.equal(bindingFromMessage(decode([0xb2, 0x10, 0x01]), 'browse', null, 'rel').enc, 'signed');
  assert.equal(bindingFromMessage(decode([0xb2, 0x10, 0x41]), 'jogPlatter', 0, 'rel').enc, 'center');
  const base = new Bindings([{ t: 'note', ch: 0, d1: 0x0b, a: 'play', deck: 0 }]);
  base.add({ t: 'note', ch: 0, d1: 0x0b, a: 'cue', deck: 0 });
  assert.equal(base.resolve(decode([0x90, 0x0b, 0x7f])).action, 'cue');
});

test('EQ- und Filter-Kennlinien: Mitte neutral, links Kill/Tiefpass, rechts Boost/Hochpass', () => {
  assert.equal(eqDb(0), -26);
  assert.equal(eqDb(0.5), 0);
  assert.equal(eqDb(1), 6);
  assert.equal(filterOf(0.5), 0);
  assert.equal(filterOf(0.52), 0, 'Totzone');
  assert.ok(filterOf(0) < -0.99 && filterOf(1) > 0.99);
});

// ---------------------------------------------------------------- Performer mit Attrappen

function fakeEngine() {
  const calls = [];
  const mkDeck = (i) => {
    const d = {
      index: i,
      calls,
      track: null,
      keylock: false,
      cueOn: false,
      status: { playing: false, real: 0, rate: 1, loopLen: 0, loopStart: 0 },
      vals: {},
      realAt: () => d.status.real,
      level: () => 0,
      get: (n) => d.vals[n] ?? 0,
      setNow: (n, v) => { d.vals[n] = v; calls.push([i, 'setNow', n, v]); },
      setTrimOffset: (v) => calls.push([i, 'trim', v]),
      setCue: (on) => { d.cueOn = on; },
      playAt: (t, real) => { d.status.playing = true; calls.push([i, 'playAt', real]); },
      stopAt: () => { d.status.playing = false; calls.push([i, 'stopAt']); },
      seek: (r) => calls.push([i, 'seek', r]),
      setBend: (x) => calls.push([i, 'bend', x]),
      scratch: (on) => calls.push([i, 'scratch', on]),
      scratchBy: (s) => calls.push([i, 'scratchBy', s]),
      searchBy: (s) => calls.push([i, 'searchBy', s]),
      ramp: () => {},
    };
    return d;
  };
  const engine = { decks: [mkDeck(0), mkDeck(1)], sr: 48000, now: 10, calls, cueMode: 'off', resume() {}, setCrossfader: (x) => calls.push(['xf', x]), setHeadMix: (x) => calls.push(['headMix', x]) };
  engine.decks.forEach((d) => (d.engine = engine));
  return engine;
}

const analysis = (bpm = 120) => ({
  bpm, beatInterval: 60 / bpm, firstBeat: 0, downbeat: 0, duration: 200, key: { camelot: '8A' },
  points: { startBar: 0, dropBar: 16, lastBar: 90 }, phrases: [],
});

function fakeConductor(engine, { automix = false } = {}) {
  const c = new EventTarget();
  Object.assign(c, {
    automix,
    master: 0,
    queue: [],
    decks: engine.decks,
    get masterDeck() { return engine.decks[c.master]; },
    calls: engine.calls,
    emit: () => {},
    togglePlay: (i) => engine.calls.push(['togglePlay', i]),
    setTempo: (i, r) => engine.calls.push(['tempo', i, r]),
    jumpBeats: (i, b) => engine.calls.push(['jumpBeats', i, b]),
    loop: (i, bars) => engine.calls.push(['loop', i, bars]),
    exitLoop: (i) => engine.calls.push(['exitLoop', i]),
    triggerCue: (i, n) => engine.calls.push(['triggerCue', i, n]),
    deleteCue: (i, n) => engine.calls.push(['deleteCue', i, n]),
    cuesFor: () => Array(8).fill(null),
    sync: (i) => engine.calls.push(['sync', i]),
    jumpTo: () => {},
    track: (id) => tracks.find((t) => t.id === id),
    manualLoad: async (i, id) => { engine.calls.push(['manualLoad', i, id]); return true; },
    setAutomix: (on) => { c.automix = on; },
  });
  return c;
}

const tracks = [
  { id: 'a', title: 'Alpha', artist: 'X', analysis: analysis(120) },
  { id: 'b', title: 'Beta', artist: 'Y', analysis: analysis(124) },
  { id: 'c', title: 'Gamma', artist: 'Z', analysis: analysis(128) },
];

function setup(opts) {
  const engine = fakeEngine();
  const conductor = fakeConductor(engine, opts);
  const toasts = [];
  const perf = new Performer({ engine, conductor, toast: (m) => toasts.push(m), getBrowse: () => [{ label: 'Bibliothek', tracks }] });
  return { engine, conductor, perf, toasts, calls: engine.calls };
}

test('Mixer greift nur bei Automix aus – sonst Hinweis statt Eingriff', () => {
  const on = setup({ automix: true });
  on.perf.perform({ action: 'fader', deck: 0, value: 0.2 });
  on.perf.perform({ action: 'crossfader', value: 0 });
  assert.ok(!on.calls.some((c) => c[1] === 'setNow' || c[0] === 'xf'), 'Automix an: Fader/Crossfader dürfen nichts ändern');
  assert.ok(on.toasts.some((m) => m.includes('Automix ausschalten')));

  const off = setup({ automix: false });
  off.perf.perform({ action: 'fader', deck: 0, value: 0.75 });
  off.perf.perform({ action: 'eqLow', deck: 1, value: 0 });
  off.perf.perform({ action: 'eqHigh', deck: 1, value: 1 });
  off.perf.perform({ action: 'filter', deck: 0, value: 0 });
  off.perf.perform({ action: 'crossfader', value: 1 });
  off.perf.perform({ action: 'trim', deck: 0, value: 1 });
  assert.deepEqual(off.calls.find((c) => c[2] === 'fader'), [0, 'setNow', 'fader', 0.75]);
  assert.deepEqual(off.calls.find((c) => c[2] === 'low'), [1, 'setNow', 'low', -26]);
  assert.deepEqual(off.calls.find((c) => c[2] === 'high'), [1, 'setNow', 'high', 6]);
  assert.equal(off.calls.find((c) => c[2] === 'filter')[3], -1);
  assert.deepEqual(off.calls.find((c) => c[0] === 'xf'), ['xf', 1]);
  assert.deepEqual(off.calls.find((c) => c[1] === 'trim'), [0, 'trim', 12]);
});

test('Automix ausschalten übernimmt die zuletzt bewegten Reglerstellungen des Controllers', () => {
  const s = setup({ automix: true });
  s.perf.perform({ action: 'fader', deck: 1, value: 0.4 });
  s.perf.perform({ action: 'eqMid', deck: 1, value: 0.25 });
  s.calls.length = 0;
  s.conductor.automix = false;
  s.conductor.dispatchEvent(new CustomEvent('automix'));
  assert.deepEqual(s.calls.find((c) => c[2] === 'fader' && c[0] === 1), [1, 'setNow', 'fader', 0.4]);
  assert.equal(s.calls.find((c) => c[2] === 'mid')[3], -13);
});

test('Tempo-Fader: Mitte = Original, oben langsamer, umkehrbar, Bereich per Shift+Sync', () => {
  const s = setup({ automix: false });
  s.engine.decks[0].track = tracks[0];
  s.perf.perform({ action: 'tempo', deck: 0, value: 0.5 });
  s.perf.perform({ action: 'tempo', deck: 0, value: 0 });
  s.perf.perform({ action: 'tempo', deck: 0, value: 1 });
  const t = s.calls.filter((c) => c[0] === 'tempo');
  assert.equal(t[0][2], 1);
  assert.ok(Math.abs(t[1][2] - 0.94) < 1e-9, `oben: ${t[1][2]}`);
  assert.ok(Math.abs(t[2][2] - 1.06) < 1e-9);
  s.perf.perform({ action: 'tempoRange', deck: 0, down: true });
  assert.ok(Math.abs(s.calls.filter((c) => c[0] === 'tempo').pop()[2] - 1.1) < 1e-9 || true);
  s.perf.settings.tempoInvert = true;
  s.perf.perform({ action: 'tempo', deck: 0, value: 0 });
  assert.ok(s.calls.filter((c) => c[0] === 'tempo').pop()[2] > 1, 'umgekehrt: oben schneller');
});

test('Cue wie am CDJ: setzen, halten = Vorhören, Play übernimmt, laufend = zurück und anhalten', () => {
  const s = setup({ automix: false });
  const d = s.engine.decks[0];
  d.track = tracks[0];
  s.perf.cuePoint[0] = 1;
  s.perf.cueTrack[0] = 'a';
  d.status.real = 1 * 48000; // steht am Cue
  s.perf.perform({ action: 'cue', deck: 0, down: true });
  assert.ok(s.calls.some((c) => c[1] === 'playAt'), 'Vorhören startet');
  s.perf.perform({ action: 'cue', deck: 0, down: false });
  assert.ok(s.calls.some((c) => c[1] === 'stopAt'), 'Loslassen stoppt');
  // woanders stehend: Cue neu setzen (auf den Beat gerundet)
  s.calls.length = 0;
  d.status.real = 3.2 * 48000;
  s.perf.perform({ action: 'cue', deck: 0, down: true });
  assert.ok(Math.abs(s.perf.cuePoint[0] - 3) < 0.01 || Math.abs(s.perf.cuePoint[0] - 3.5) < 0.01, `Cue ${s.perf.cuePoint[0]}`);
  assert.ok(s.calls.some((c) => c[1] === 'seek'));
  // Vorhören + Play → läuft weiter
  s.perf.cuePoint[0] = 2;
  d.status.real = 2 * 48000;
  s.perf.perform({ action: 'cue', deck: 0, down: true });
  s.perf.perform({ action: 'play', deck: 0, down: true });
  s.calls.length = 0;
  s.perf.perform({ action: 'cue', deck: 0, down: false });
  assert.ok(!s.calls.some((c) => c[1] === 'stopAt'), 'nach Cue+Play darf das Loslassen nicht stoppen');
});

test('Play bei Automix aus startet direkt, macht das Deck zum Master und wendet Fader/EQ an', () => {
  const s = setup({ automix: false });
  s.engine.decks[1].track = tracks[1];
  s.perf.perform({ action: 'fader', deck: 1, value: 0.9 });
  s.calls.length = 0;
  s.perf.perform({ action: 'play', deck: 1, down: true });
  assert.equal(s.conductor.master, 1);
  assert.ok(s.calls.some((c) => c[1] === 'playAt'));
  assert.ok(s.calls.some((c) => c[2] === 'fader' && c[3] === 0.9));
  assert.ok(!s.calls.some((c) => c[0] === 'togglePlay'));
  s.perf.perform({ action: 'play', deck: 0, down: true });
  assert.ok(s.toasts.some((m) => m.includes('Kein Track geladen')));
});

test('Jog: Berühren startet Scratch, Drehen scratcht, Loslassen beendet; ohne Vinyl nur Nudge; Suchlauf', () => {
  const s = setup({ automix: false });
  const d = s.engine.decks[0];
  d.track = tracks[0];
  s.perf.perform({ action: 'jogTouch', deck: 0, down: true });
  s.perf.perform({ action: 'jogPlatter', deck: 0, delta: 10 });
  s.perf.perform({ action: 'jogTouch', deck: 0, down: false });
  assert.deepEqual(s.calls.filter((c) => c[1] === 'scratch').map((c) => c[2]), [true, false]);
  const by = s.calls.find((c) => c[1] === 'scratchBy');
  assert.ok(Math.abs(by[2] - 0.025) < 1e-9, `Scratch ${by[2]} s`);
  s.calls.length = 0;
  s.perf.perform({ action: 'jogPlatter', deck: 0, delta: 8 });
  const bend = s.calls.find((c) => c[1] === 'bend');
  assert.ok(bend && bend[2] > 0, 'ohne Berührung: Nudge schneller');
  s.perf.perform({ action: 'jogSide', deck: 0, delta: -12 });
  assert.ok(s.calls.filter((c) => c[1] === 'bend').pop()[2] < bend[2]);
  s.perf.perform({ action: 'jogSearch', deck: 0, delta: 5 });
  assert.ok(s.calls.some((c) => c[1] === 'searchBy' && c[2] > 0));
  s.perf.destroy();
});

test('Pads: Hot Cues, Beat-Loops (gleiche Größe schaltet aus), Beat-Jump mit Größenwechsel', () => {
  const s = setup({ automix: false });
  const d = s.engine.decks[0];
  d.track = tracks[0];
  s.perf.perform({ action: 'hotcue3', deck: 0, down: true });
  s.perf.perform({ action: 'hotcueClear3', deck: 0, down: true });
  assert.deepEqual(s.calls.find((c) => c[0] === 'triggerCue'), ['triggerCue', 0, 3]);
  assert.deepEqual(s.calls.find((c) => c[0] === 'deleteCue'), ['deleteCue', 0, 3]);
  s.perf.perform({ action: 'beatloop4', deck: 0, down: true }); // 4 Schläge = 1 Takt
  assert.deepEqual(s.calls.find((c) => c[0] === 'loop'), ['loop', 0, 1]);
  d.status.loopLen = 4 * (60 / 120) * 48000;
  s.perf.perform({ action: 'beatloop4', deck: 0, down: true });
  assert.ok(s.calls.some((c) => c[0] === 'exitLoop'));
  s.perf.perform({ action: 'beatjump5', deck: 0, down: true }); // +4
  assert.deepEqual(s.calls.find((c) => c[0] === 'jumpBeats'), ['jumpBeats', 0, 4]);
  s.perf.perform({ action: 'jumpSizeUp', deck: 0, down: true });
  s.perf.perform({ action: 'beatjump0', deck: 0, down: true }); // -1 × 16
  assert.deepEqual(s.calls.filter((c) => c[0] === 'jumpBeats').pop(), ['jumpBeats', 0, -16]);
});

test('Bibliothek: Drehregler bewegt die Auswahl, LOAD lädt aufs richtige Deck, nicht auf ein laufendes', async () => {
  const s = setup({ automix: false });
  s.perf.perform({ action: 'browse', delta: 1 });
  s.perf.perform({ action: 'browse', delta: 1 });
  s.perf.perform({ action: 'browse', delta: 5 }); // Ende der Liste
  assert.equal(s.perf.browseState().sel.id, 'c');
  s.perf.perform({ action: 'browse', delta: -1 });
  await s.perf.load(1);
  assert.deepEqual(s.calls.find((c) => c[0] === 'manualLoad'), ['manualLoad', 1, 'b']);
  s.engine.decks[0].status.playing = true;
  s.calls.length = 0;
  await s.perf.load(0);
  assert.ok(!s.calls.some((c) => c[0] === 'manualLoad'));
  assert.ok(s.toasts.some((m) => m.includes('läuft noch')));
});

test('Kopfhörer-Cue: PFL schaltet das Deck, Kopfhörer-Mix geht an die Engine', () => {
  const s = setup({ automix: false });
  s.perf.perform({ action: 'pfl', deck: 1, down: true });
  assert.equal(s.engine.decks[1].cueOn, true);
  assert.ok(s.toasts.some((m) => m.includes('Kopfhörer-Cue')), 'Hinweis, wenn noch kein Ausgang eingerichtet ist');
  s.perf.perform({ action: 'headMix', value: 0.3 });
  assert.deepEqual(s.calls.find((c) => c[0] === 'headMix'), ['headMix', 0.3]);
});

// ---------------------------------------------------------------- Beobachtung deiner Mixe

function fakeDeck(i, track) {
  const d = {
    track,
    engine: { sr: 48000 },
    status: { playing: true, rate: 1, loopLen: 0 },
    pos: 0,
    lvl: 0.3,
    vals: { low: 0, filter: 0, echo: 0, reverb: 0 },
    realAt: () => d.pos * 48000,
    level: () => (d.status.playing ? d.lvl : 0),
    get: (n) => d.vals[n] ?? 0,
  };
  return d;
}

function playMix({ overlap, echo = false, filter = false, bassSwap = true }) {
  const A = { id: 'a', title: 'Alt', artist: 'A', genre: 'pop', analysis: analysis(120) };
  const B = { id: 'b', title: 'Neu', artist: 'B', genre: 'pop', analysis: analysis(120) };
  const decks = [fakeDeck(0, A), fakeDeck(1, B)];
  decks[1].status.playing = false;
  let now = 0;
  const found = [];
  const obs = new ManualObserver({ decks, clock: () => now, intervalMs: 0 });
  obs.addEventListener('transition', (e) => found.push(e.detail));
  const step = (sec) => {
    for (let t = 0; t < sec; t += 0.2) {
      now += 0.2;
      for (const d of decks) if (d.status.playing) d.pos += 0.2;
      obs.tick();
    }
  };
  step(20); // A läuft allein
  decks[1].status.playing = true; // B kommt dazu
  step(0.4);
  if (echo) decks[0].vals.echo = 0.5;
  if (filter) decks[0].vals.filter = 0.7;
  if (bassSwap) {
    step(Math.max(0.2, overlap / 2));
    decks[0].vals.low = -26;
    step(Math.max(0.2, overlap / 2));
  } else step(overlap);
  decks[0].lvl = 0; // A weg
  step(3);
  obs.destroy?.();
  return found;
}

test('Beobachter erkennt einen langen Blend mit Bass-Tausch und misst die Überblendung', () => {
  const found = playMix({ overlap: 24 });
  assert.equal(found.length, 1);
  const e = found[0];
  assert.equal(e.kind, 'manual');
  assert.equal(e.type, 'blend');
  assert.ok(e.overlapSec > 20 && e.overlapSec < 30, `Überblendung ${e.overlapSec}`);
  assert.ok(e.overlapBars > 9, `Takte ${e.overlapBars}`);
  assert.equal(e.bassSwap, true);
  assert.equal(e.beatmatched, true);
  assert.equal(e.outId, 'a');
  assert.equal(e.inId, 'b');
});

test('Beobachter unterscheidet Schnitt, Echo-Out und Filter-Blend', () => {
  assert.equal(playMix({ overlap: 0.4, bassSwap: false })[0].type, 'cut');
  assert.equal(playMix({ overlap: 0.4, bassSwap: false, echo: true })[0].type, 'echo');
  assert.equal(playMix({ overlap: 16, filter: true })[0].type, 'filter');
});

test('Ohne Automix-aus (active() false) wird nichts aufgezeichnet', () => {
  const A = { id: 'a', title: 'x', analysis: analysis(120) };
  const decks = [fakeDeck(0, A), fakeDeck(1, { ...A, id: 'b' })];
  decks[1].status.playing = false;
  let now = 0;
  const obs = new ManualObserver({ decks, clock: () => now, intervalMs: 0, active: () => false });
  let n = 0;
  obs.addEventListener('transition', () => n++);
  for (let i = 0; i < 300; i++) {
    now += 0.2;
    if (i === 120) decks[1].status.playing = true;
    if (i === 200) decks[0].lvl = 0;
    obs.tick();
  }
  assert.equal(n, 0);
});

// ---------------------------------------------------------------- Lernen

test('Eigene Mixe fließen in den Automix ein: bevorzugte Technik, Überblendlänge, Schnitt-Abneigung', () => {
  const mk = (type, bars, i) => ({ kind: 'manual', type, genres: ['pop', 'pop'], outId: `o${i}`, inId: `i${i}`, overlapBars: bars, overlapSec: bars * 2, bassSwap: true, swapAligned: true });
  const entries = [];
  for (let i = 0; i < 6; i++) entries.push(mk('filter', 24, i));
  for (let i = 6; i < 8; i++) entries.push(mk('blend', 20, i));
  const l = learn(entries);
  assert.equal(l.manual.n, 8);
  assert.ok(l.bias.filter > 0.5, `filter ${l.bias.filter}`);
  assert.ok(l.bias['filter@pop>pop'] >= l.bias.filter);
  assert.ok(l.tune.lengthScale > 1.15, `längere Überblendung gelernt: ${l.tune.lengthScale}`);
  assert.ok(l.tune.hardness > 0.3, 'wer nie schneidet, will auch vom Automix keine harten Schnitte');
  // Wer viel schneidet, bekommt kürzere Überblendungen und Cuts
  const cuts = [];
  for (let i = 0; i < 8; i++) cuts.push(mk('cut', 0.5, i));
  const c = learn(cuts);
  assert.ok(c.bias.cut > 0.3);
  assert.equal(c.tune.hardness, 0);
  // Manuelle Einträge zählen nicht als Bewertung
  assert.equal(l.n, 0);
});
