import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckCore } from '../app/audio/deck-core.js';

const SR = 48000;

function sine(freq, seconds, sr = SR) {
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sr);
  return a;
}

function render(core, frames, from = 0) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let f = 0; f < frames; f += 128) {
    const n = Math.min(128, frames - f);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    core.process(l, r, from + f, n);
    L.set(l, f);
    R.set(r, f);
  }
  return { L, R };
}

function zeroCrossFreq(a, sr, from, to) {
  let c = 0;
  for (let i = from + 1; i < to; i++) if (a[i - 1] <= 0 && a[i] > 0) c++;
  return (c * sr) / (to - from);
}

test('keylock bei rate 1 ist transparent', () => {
  const src = sine(440, 2);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.schedulePlay(0, 0);
  const { L } = render(core, SR);
  let maxErr = 0;
  for (let i = DECLICK_PAD; i < SR - 10; i++) maxErr = Math.max(maxErr, Math.abs(L[i] - src[i]));
  assert.ok(maxErr < 1e-4, `maxErr ${maxErr}`);
});
const DECLICK_PAD = 256;

test('keylock: Tempo +6% ändert Dauer, nicht Tonhöhe', () => {
  const src = sine(1000, 4);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.scheduleRate(0, 1.06, 0);
  core.schedulePlay(0, 0);
  const { L } = render(core, SR * 2);
  const st = core.status(SR * 2);
  assert.ok(Math.abs(st.v - SR * 2 * 1.06) < core.N, `virtual ${st.v}`);
  const f = zeroCrossFreq(L, SR, SR / 2, SR * 2);
  assert.ok(Math.abs(f - 1000) < 8, `freq ${f}`);
});

test('vinyl-modus: Tempo +6% hebt Tonhöhe', () => {
  const src = sine(1000, 4);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.setKeylock(false);
  core.scheduleRate(0, 1.06, 0);
  core.schedulePlay(0, 0);
  const { L } = render(core, SR);
  const f = zeroCrossFreq(L, SR, SR / 4, SR);
  assert.ok(Math.abs(f - 1060) < 8, `freq ${f}`);
});

test('loop-segment wiederholt Bereich ohne Sprünge', () => {
  // Rampe als Signal: real-Position direkt ablesbar
  const n = SR * 4;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * 0.5;
  const core = new DeckCore(SR);
  core.load(src, src);
  core.schedulePlay(0, 0);
  const loopStart = SR / 2;
  const loopLen = SR / 4; // exakt 50 Perioden von 200 Hz -> nahtlos
  core.addSegment(loopStart, loopStart, loopLen);
  render(core, SR * 2);
  const st = core.status(SR * 2);
  assert.equal(st.loopLen, loopLen);
  assert.ok(st.real >= loopStart - core.N && st.real < loopStart + loopLen + 1, `real ${st.real}`);
  assert.ok(Math.abs(st.v - SR * 2) < core.N, `virtual ${st.v}`);
});

test('loop exit: lineares Segment danach läuft weiter', () => {
  const src = sine(300, 4);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.schedulePlay(0, 0);
  core.addSegment(SR / 2, SR / 2, SR / 4); // Loop ab 0.5 s
  core.addSegment(SR, SR / 2 + SR / 4, 0); // nach 2 Zyklen weiter bei Loop-Ende
  render(core, SR * 1.5);
  const st = core.status(SR * 1.5);
  assert.equal(st.loopLen, 0);
  const expected = SR / 2 + SR / 4 + (st.v - SR);
  assert.ok(Math.abs(st.real - expected) < 2, `real ${st.real} erwartet ${expected}`);
});

test('geplanter Start beginnt exakt am Frame', () => {
  const src = new Float32Array(SR).fill(0.5);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.setKeylock(false);
  core.schedulePlay(1000, 0);
  const { L } = render(core, 2000);
  assert.equal(L[999], 0);
  assert.ok(L[1000] > 0);
});

test('keylock: saubere Wiedergabe bei -3 % (kaum Obertöne/Knackser)', () => {
  // Akkord aus drei Tönen: Stretch darf keine starken Sprünge zwischen Samples erzeugen
  const n = SR * 3;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    src[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 277 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t);
  }
  const core = new DeckCore(SR);
  core.load(src, src);
  core.scheduleRate(0, 0.97, 0);
  core.schedulePlay(0, 0);
  const { L } = render(core, SR * 2);
  let maxStep = 0;
  for (let i = SR / 10; i < SR * 2; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
  // Quelle: max. Sampleschritt ~ 2π·330/48000·0.7 ≈ 0.03
  assert.ok(maxStep < 0.06, `maxStep ${maxStep}`);
  const f = zeroCrossFreq(L, SR, SR / 2, SR * 2);
  const fs = zeroCrossFreq(src, SR, SR / 2, SR * 2);
  assert.ok(Math.abs(f - fs) < 3, `freq ${f} vs ${fs}`);
});

test('Key-Sync: +2 Halbtöne ändern Tonhöhe, nicht Tempo', () => {
  const src = sine(1000, 4);
  const core = new DeckCore(SR);
  core.load(src, src);
  core.setPitch(2 ** (2 / 12));
  core.schedulePlay(0, 0);
  const { L } = render(core, SR * 2);
  const st = core.status(SR * 2);
  assert.ok(Math.abs(st.v - SR * 2) < core.N, `virtual ${st.v}`);
  const f = zeroCrossFreq(L, SR, SR / 2, SR * 2);
  assert.ok(Math.abs(f - 1000 * 2 ** (2 / 12)) < 10, `freq ${f}`);
});

test('keylock: nach Tempo-Rampe zurück auf 1 wieder 1:1 transparent (kein "Geflatter")', () => {
  // Musik-ähnliches Signal: Akkord + Kick-ähnliche Impulse, damit die Nahtsuche echte Arbeit hat
  const n = SR * 6;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = t % 0.5;
    src[i] = 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 331 * t) + 0.5 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * 60 * beat);
  }
  const core = new DeckCore(SR);
  core.load(src, src);
  core.scheduleRate(0, 1.04, 0);
  core.scheduleRate(SR, 1, SR / 2); // wie nach einem Übergang: zurück aufs Originaltempo
  core.schedulePlay(0, 0);
  const { L } = render(core, SR * 4);
  // im letzten Abschnitt (Tempo 1) muss der Track wieder unverändert laufen: gleicher Versatz überall
  const from = SR * 3;
  let best = null;
  for (let d = -SR; d < SR; d++) {
    let err = 0;
    for (let i = from; i < from + 2000; i += 7) err += Math.abs(L[i] - src[i + d]);
    if (!best || err < best.err) best = { d, err };
  }
  let maxErr = 0;
  for (let i = from; i < SR * 4; i++) maxErr = Math.max(maxErr, Math.abs(L[i] - src[i + best.d]));
  assert.ok(maxErr < 1e-4, `nach der Rampe nicht transparent: maxErr ${maxErr.toFixed(4)} (Versatz ${best.d})`);
});
