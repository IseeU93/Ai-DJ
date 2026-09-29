// Der Performer führt die Aktionen eines DJ-Controllers aus: Transport, Cue, Loops, Hot Cues, Jog
// (Scratch/Nudge/Suchlauf), Tempo-Fader, den ganzen Mixer (Kanalfader, Crossfader, 3-Band-EQ, Filter,
// Trim), Kopfhörer-Cue, Beat-FX/Effekt-Pads und das Durchblättern/Laden aus der Bibliothek.
//
// Der Mixer-Teil ist nur aktiv, wenn Automix aus ist ("du mixt"): dann sind die Regler am Gerät die
// Wahrheit und werden bei jedem Track-Laden neu auf die Decks angewendet. Transport, Loops, Pads und
// Bibliothek funktionieren immer.
import { ACTIONS, PAD_LOOP, PAD_JUMP } from './actions.js';
import { beatToSeconds, secondsToBeat, barToSeconds } from '../mix/planner.js';

export const RANGES = [0.06, 0.1, 0.16, 0.25]; // Tempo-Fader-Bereich (±)
export const FX_LIST = ['Echo', 'Hall', 'Flanger', 'Gate 1/8', 'Gate 1/16', 'Filter-Riser'];
const EQ_MIN = -26;
const EQ_MAX = 6;
const TICK_SEC = 0.0025; // Musikzeit pro Jog-Schritt beim Scratchen (33⅓ U/min bei 720 Schritten)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Drehregler 0..1 → dB (Mitte = 0, ganz links = Kill). */
export function eqDb(v) {
  return (v <= 0.5 ? EQ_MIN * (1 - v / 0.5) : EQ_MAX * ((v - 0.5) / 0.5)) || 0; // (|| 0: kein -0)
}

/** Filter-Knopf 0..1 → -1 (Tiefpass) … 0 … +1 (Hochpass), mit kleiner Totzone in der Mitte. */
export function filterOf(v) {
  const f = (v - 0.5) * 2;
  const a = Math.abs(f);
  return a < 0.05 ? 0 : Math.sign(f) * ((a - 0.05) / 0.95);
}

export class Performer extends EventTarget {
  constructor({ engine, conductor, toast = () => {}, getBrowse = () => [], settings = {} }) {
    super();
    this.engine = engine;
    this.conductor = conductor;
    this.toast = toast;
    this.getBrowse = getBrowse; // () => [{ label, tracks }]
    this.settings = { tempoInvert: false, ...settings };

    // zuletzt am Gerät gesehene Reglerstellungen (0..1) – bei Automix aus die Wahrheit für den Mixer
    this.hw = { fader: [null, null], trim: [null, null], eqHigh: [null, null], eqMid: [null, null], eqLow: [null, null], filter: [null, null], tempo: [null, null], crossfader: null };
    this.cuePoint = [0, 0];
    this.cueTrack = [null, null];
    this.previewing = [false, false];
    this.scratching = [false, false];
    this.vinyl = [true, true];
    this.bend = [0, 0];
    this.shift = [false, false];
    this.tempoRange = [0, 0];
    this.jumpBase = [1, 1];
    this.censor = [null, null];
    this.fx = { sel: 0, on: false, level: 0.6, target: [true, true], timer: null };
    this.browse = { src: 0, index: 0 };
    this.lastHint = 0;

    this.bendTimer = setInterval(() => this.decayBend(), 30);
    this.bendTimer.unref?.(); // (Node-Tests dürfen enden)
    conductor.addEventListener('decks', () => this.onDecks());
    conductor.addEventListener('automix', () => this.applyAllMixer());
  }

  get mixerActive() {
    return !this.conductor.automix;
  }

  get decks() {
    return this.engine.decks;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  destroy() {
    clearInterval(this.bendTimer);
    this.clearFxTimer();
  }

  // ------------------------------------------------------------------ Eingang

  perform(ev) {
    const spec = ACTIONS[ev.action];
    if (!spec) return;
    const i = ev.deck;
    if (spec.perDeck && i !== 0 && i !== 1) return;
    const pad = /^(hotcue|hotcueClear|beatloop|beatjump|fxpad)(\d)$/.exec(ev.action);
    if (pad) {
      if (!ev.down) return;
      return this.pad(pad[1], +pad[2], i);
    }
    switch (ev.action) {
      case 'play': return ev.down && this.play(i);
      case 'cue': return this.cue(i, !!ev.down);
      case 'cueStart': return ev.down && this.cueStart(i);
      case 'censor': return this.doCensor(i, !!ev.down);
      case 'sync': return ev.down && this.conductor.sync(i);
      case 'tempoRange': return ev.down && this.cycleRange(i);
      case 'keylock': return ev.down && this.conductor.setKeylock(i, !this.decks[i].keylock);
      case 'shift': this.shift[i] = !!ev.down; return;
      case 'load': return ev.down && this.load(i);
      case 'browse': return this.browseMove(ev.delta || 0);
      case 'browseFast': return this.browseMove((ev.delta || 0) * 10);
      case 'browsePress': return ev.down && this.browseSource();
      case 'loopIn': return ev.down && this.conductor.loopIn(i);
      case 'loopOut': return ev.down && this.conductor.loopOut(i);
      case 'reloop': return ev.down && this.conductor.reloop(i);
      case 'loopExit': return ev.down && this.conductor.exitLoop(i);
      case 'loopHalf': return ev.down && this.conductor.loopScale(i, 0.5);
      case 'loopDouble': return ev.down && this.conductor.loopScale(i, 2);
      case 'jumpBack': return ev.down && this.conductor.jumpBeats(i, -16);
      case 'jumpFwd': return ev.down && this.conductor.jumpBeats(i, 16);
      case 'jumpSizeDown': if (ev.down) { this.jumpBase[i] = 1; this.toast('Beat-Jump: 1 · 2 · 4 · 8 Schläge'); } return;
      case 'jumpSizeUp': if (ev.down) { this.jumpBase[i] = 16; this.toast('Beat-Jump: 16 · 32 · 64 · 128 Schläge'); } return;
      case 'pfl': return ev.down && this.togglePfl(i);
      case 'jogTouch': return this.jogTouch(i, !!ev.down);
      case 'jogPlatter': return this.jogPlatter(i, ev.delta || 0, true);
      case 'jogPlatterFree': return this.jogPlatter(i, ev.delta || 0, false);
      case 'jogSide': return this.nudge(i, ev.delta || 0);
      case 'jogSearch': return this.decks[i].track && this.decks[i].searchBy((ev.delta || 0) * 0.12);
      case 'fader': case 'trim': case 'eqHigh': case 'eqMid': case 'eqLow': case 'filter': case 'crossfader':
        return this.mixer(ev.action, i, ev.value);
      case 'tempo': return this.tempo(i, ev.value);
      case 'headMix': return this.engine.setHeadMix(ev.value);
      case 'headVol': return this.engine.setHeadVolume(ev.value * 1.2);
      case 'masterVol': return this.engine.setMasterVolume(ev.value);
      case 'fxOn': return ev.down && this.fxToggle();
      case 'fxOff': return ev.down && this.fxSet(false);
      case 'fxNext': return ev.down && this.fxSelect(1);
      case 'fxPrev': return ev.down && this.fxSelect(-1);
      case 'fxLevel': this.fx.level = clamp(ev.value, 0, 1); return this.fx.on && this.fxApply();
      case 'fxTarget': return ev.down && this.fxTarget(i);
      case 'fxTargetBoth': if (ev.down) { this.fx.target = [true, true]; this.fx.on && this.fxApply(); this.emit('fx'); } return;
    }
  }

  // ------------------------------------------------------------------ Transport

  play(i) {
    const d = this.decks[i];
    if (!d.track) return this.toast('Kein Track geladen – mit LOAD einen Titel aus der Bibliothek laden');
    this.engine.resume();
    if (this.previewing[i]) {
      this.previewing[i] = false; // Cue gehalten + Play: weiterlaufen lassen
      return;
    }
    if (!this.mixerActive) return this.conductor.togglePlay(i);
    if (d.status.playing) {
      d.stopAt(this.engine.now);
    } else {
      const c = this.conductor;
      if (!c.masterDeck.status.playing) c.master = i;
      this.applyMixerDeck(i);
      d.playAt(this.engine.now + 0.03);
    }
    this.conductor.emit('decks');
  }

  /** Cue-Punkt des Tracks: gemerkt, sonst Songanfang. */
  cuePointOf(i) {
    const d = this.decks[i];
    const id = d.track?.id ?? null;
    if (id !== this.cueTrack[i]) {
      this.cueTrack[i] = id;
      const a = d.track?.analysis;
      this.cuePoint[i] = a ? Math.max(0, barToSeconds(a, a.points.startBar ?? 0)) : 0;
    }
    return this.cuePoint[i];
  }

  /**
   * CDJ-Verhalten: läuft der Track → zurück zum Cue und anhalten; steht er irgendwo → Cue dort setzen;
   * steht er am Cue → gedrückt halten = Vorhören, loslassen = zurück.
   */
  cue(i, down) {
    const d = this.decks[i];
    if (!d.track) return;
    const sr = this.engine.sr;
    const now = this.engine.now;
    const cue = this.cuePointOf(i);
    if (down) {
      this.engine.resume();
      if (d.status.playing) {
        d.stopAt(now);
        setTimeout(() => d.seek(cue * sr), 60);
        this.previewing[i] = false;
      } else {
        const pos = d.realAt(now) / sr;
        if (Math.abs(pos - cue) < 0.08) {
          this.previewing[i] = true;
          if (!this.conductor.masterDeck.status.playing) this.conductor.master = i;
          d.playAt(now + 0.02, cue * sr);
        } else {
          const a = d.track.analysis;
          this.cuePoint[i] = Math.max(0, beatToSeconds(a, Math.round(secondsToBeat(a, pos))));
          d.seek(this.cuePoint[i] * sr);
          this.emit('cue', { deck: i });
        }
      }
    } else if (this.previewing[i]) {
      this.previewing[i] = false;
      d.stopAt(now);
      setTimeout(() => d.seek(cue * sr), 60);
    }
  }

  cueStart(i) {
    const d = this.decks[i];
    if (!d.track) return;
    const a = d.track.analysis;
    this.cuePoint[i] = Math.max(0, barToSeconds(a, a.points.startBar ?? 0));
    this.cueTrack[i] = d.track.id;
    this.conductor.jumpTo(i, this.cuePoint[i]);
  }

  /** Censor: solange gedrückt läuft der Track rückwärts, beim Loslassen dort weiter, wo er ohne Censor wäre. */
  doCensor(i, down) {
    const d = this.decks[i];
    if (!d.track) return;
    if (down && !this.censor[i]) {
      d.scratch(true);
      const t0 = performance.now();
      const timer = setInterval(() => d.scratchBy(-0.02 * (d.status.rate || 1)), 20);
      this.censor[i] = { t0, timer };
    } else if (!down && this.censor[i]) {
      const { t0, timer } = this.censor[i];
      clearInterval(timer);
      const held = (performance.now() - t0) / 1000;
      d.scratchBy(2 * held * (d.status.rate || 1)); // zurück auf die Stelle, an der er ohne Censor wäre
      setTimeout(() => d.scratch(false), 40);
      this.censor[i] = null;
    }
  }

  cycleRange(i) {
    this.tempoRange[i] = (this.tempoRange[i] + 1) % RANGES.length;
    this.toast(`Tempo-Bereich Deck ${i + 1}: ±${Math.round(RANGES[this.tempoRange[i]] * 100)} %`);
    if (this.hw.tempo[i] !== null) this.tempo(i, this.hw.tempo[i]);
    this.emit('tempo', { deck: i });
  }

  /** Tempo-Fader: oben = langsamer (umkehrbar), Mitte = Originaltempo. */
  tempo(i, v) {
    if (v === undefined || v === null) return;
    this.hw.tempo[i] = v;
    const d = this.decks[i];
    if (!d.track) return;
    const pos = (v * 2 - 1) * (this.settings.tempoInvert ? -1 : 1);
    const p = Math.abs(pos) < 0.012 ? 0 : pos;
    this.conductor.setTempo(i, 1 + p * RANGES[this.tempoRange[i]]);
    this.emit('tempo', { deck: i });
  }

  // ------------------------------------------------------------------ Jog

  jogTouch(i, down) {
    const d = this.decks[i];
    if (!d.track) return;
    if (down && this.vinyl[i] && !this.scratching[i]) {
      this.scratching[i] = true;
      d.scratch(true);
    } else if (!down && this.scratching[i]) {
      this.scratching[i] = false;
      d.scratch(false);
    }
  }

  jogPlatter(i, delta, vinylMode) {
    const d = this.decks[i];
    if (!d.track || !delta) return;
    this.vinyl[i] = vinylMode;
    if (!vinylMode && this.scratching[i]) {
      this.scratching[i] = false;
      d.scratch(false);
    }
    if (this.scratching[i]) d.scratchBy(delta * TICK_SEC);
    else this.nudge(i, delta);
  }

  nudge(i, delta) {
    const d = this.decks[i];
    if (!d.track || !delta) return;
    this.bend[i] = clamp(this.bend[i] + delta * 0.006, -0.2, 0.2);
    d.setBend(this.bend[i]);
  }

  decayBend() {
    for (const i of [0, 1]) {
      if (!this.bend[i]) continue;
      this.bend[i] *= 0.55;
      if (Math.abs(this.bend[i]) < 0.004) this.bend[i] = 0;
      this.decks[i].setBend(this.bend[i]);
    }
  }

  // ------------------------------------------------------------------ Pads

  pad(kind, n, i) {
    const d = this.decks[i];
    const c = this.conductor;
    if (kind === 'hotcue') return c.triggerCue(i, n);
    if (kind === 'hotcueClear') return c.deleteCue(i, n);
    if (kind === 'beatjump') return c.jumpBeats(i, PAD_JUMP[n] * this.jumpBase[i]);
    if (kind === 'fxpad') return this.fxPad(i, n);
    if (kind === 'beatloop') {
      const beats = PAD_LOOP[n];
      const st = d.status;
      const a = d.track?.analysis;
      if (!a) return;
      const want = beats * a.beatInterval * this.engine.sr;
      if (st.loopLen > 0 && Math.abs(st.loopLen - want) < want * 0.05) return c.exitLoop(i);
      c.loop(i, beats / 4);
    }
  }

  /** Sampler-Pads spielen One-Shot-Effekte auf dem Deck (und Riser/Downlifter auf dem Master). */
  fxPad(i, n) {
    const d = this.decks[i];
    const e = this.engine;
    const now = e.now + 0.01;
    const bpm = (d.track?.analysis?.bpm || 120) * (d.status.rate || 1);
    const beat = 60 / bpm;
    switch (n) {
      case 0: return e.sweep(now, now + 4 * beat, { dir: 'up', level: 0.12 });
      case 1: return e.sweep(now, now + 2 * beat, { dir: 'down', level: 0.08 });
      case 2:
        d.setEchoTime(beat * 0.75);
        d.ramp('echo', now, 0, now + 0.01, 0.6);
        d.ramp('echo', now + beat * 0.95, 0.6, now + beat * 1.05, 0);
        return;
      case 3:
        d.ramp('reverb', now, 0, now + 0.05, 0.75);
        d.ramp('reverb', now + beat * 1.9, 0.75, now + beat * 2.1, 0);
        return;
      case 4: return d.gateAt(now, now + 2 * beat, beat / 2, { depth: 1, duty: 0.5 });
      case 5: return d.gateAt(now, now + beat, beat / 4, { depth: 1, duty: 0.5 });
      case 6:
        d.ramp('flanger', now, 0, now + 2 * beat, 0.9);
        d.ramp('flanger', now + 2 * beat, 0.9, now + 4 * beat, 0);
        return;
      case 7: {
        const back = this.hw.filter[i] === null ? 0 : filterOf(this.hw.filter[i]);
        d.ramp('filter', now, 0, now + 4 * beat, 0.9);
        d.ramp('filter', now + 4 * beat, 0.9, now + 4 * beat + 0.02, this.mixerActive ? back : 0);
      }
    }
  }

  // ------------------------------------------------------------------ Mixer

  mixer(name, i, v) {
    if (v === undefined || v === null) return;
    if (name === 'crossfader') this.hw.crossfader = v;
    else this.hw[name][i] = v;
    if (!this.mixerActive) return this.hintAutomix();
    this.applyMixer(name, i);
    this.emit('mixer', { name, deck: i });
  }

  /** Einen Reglerwert aus dem Gerätespeicher auf die Engine anwenden. */
  applyMixer(name, i) {
    const e = this.engine;
    if (name === 'crossfader') {
      if (this.hw.crossfader !== null) e.setCrossfader(this.hw.crossfader);
      return;
    }
    const v = this.hw[name]?.[i];
    if (v === null || v === undefined) return;
    const d = this.decks[i];
    switch (name) {
      case 'fader': return d.setNow('fader', v);
      case 'trim': return d.setTrimOffset((v - 0.5) * 24);
      case 'eqHigh': return d.setNow('high', eqDb(v));
      case 'eqMid': return d.setNow('mid', eqDb(v));
      case 'eqLow': return d.setNow('low', eqDb(v));
      case 'filter': return d.setNow('filter', filterOf(v));
    }
  }

  applyMixerDeck(i) {
    for (const n of ['fader', 'trim', 'eqHigh', 'eqMid', 'eqLow', 'filter']) this.applyMixer(n, i);
    this.applyMixer('crossfader', 0);
  }

  /** Alles vom Gerät übernehmen (beim Ausschalten von Automix bzw. nach dem Laden eines Tracks). */
  applyAllMixer() {
    if (!this.mixerActive) return;
    this.applyMixerDeck(0);
    this.applyMixerDeck(1);
    const known = ['fader', 'eqLow', 'crossfader'].some((n) => (Array.isArray(this.hw[n]) ? this.hw[n].some((x) => x !== null) : this.hw[n] !== null));
    if (known) this.toast('Du mixt: Regler des Controllers übernommen');
    else this.toast('Du mixt: Fader und Regler am Controller einmal bewegen, dann greifen sie');
    this.emit('mixer', {});
  }

  onDecks() {
    if (!this.mixerActive) return;
    for (const i of [0, 1]) {
      const id = this.decks[i].track?.id ?? null;
      if (id !== this.mixTrack?.[i]) {
        (this.mixTrack ||= [null, null])[i] = id;
        if (id) this.applyMixerDeck(i);
      }
    }
  }

  hintAutomix() {
    if (Date.now() - this.lastHint < 10000) return;
    this.lastHint = Date.now();
    this.toast('Automix ist an – für manuelles Mixen Automix ausschalten, dann greifen Fader, EQ und Crossfader');
  }

  togglePfl(i) {
    const d = this.decks[i];
    d.setCue(!d.cueOn);
    this.emit('pfl', { deck: i, on: d.cueOn });
    if (d.cueOn && this.engine.cueMode === 'off') this.toast('Kopfhörer-Cue ist noch nicht eingerichtet (Controller-Fenster → Kopfhörer)');
  }

  // ------------------------------------------------------------------ Beat-FX

  fxSelect(dir) {
    this.fx.sel = (this.fx.sel + dir + FX_LIST.length) % FX_LIST.length;
    if (this.fx.on) {
      this.fxClear();
      this.fxApply();
    }
    this.toast(`Beat-FX: ${FX_LIST[this.fx.sel]}`);
    this.emit('fx');
  }

  fxTarget(i) {
    const only = this.fx.target[i] && !this.fx.target[1 - i];
    this.fx.target = only ? [true, true] : [i === 0, i === 1];
    if (this.fx.on) {
      this.fxClear();
      this.fxApply();
    }
    this.emit('fx');
  }

  fxToggle() {
    this.fxSet(!this.fx.on);
  }

  fxSet(on) {
    if (on === this.fx.on && !on) return;
    this.fx.on = on;
    if (on) this.fxApply();
    else this.fxClear();
    this.emit('fx');
  }

  clearFxTimer() {
    clearInterval(this.fx.timer);
    this.fx.timer = null;
  }

  fxApply() {
    const name = FX_LIST[this.fx.sel];
    const lvl = this.fx.level;
    this.clearFxTimer();
    for (const k of [0, 1]) {
      if (!this.fx.target[k]) continue;
      const d = this.decks[k];
      const beat = 60 / ((d.track?.analysis?.bpm || 120) * (d.status.rate || 1));
      if (name === 'Echo') {
        d.setEchoTime(beat * 0.75);
        d.setNow('echo', 0.15 + lvl * 0.65);
      } else if (name === 'Hall') d.setNow('reverb', 0.1 + lvl * 0.8);
      else if (name === 'Flanger') d.setNow('flanger', 0.3 + lvl * 0.7);
      else if (name === 'Filter-Riser') d.ramp('filter', this.engine.now, d.get('filter'), this.engine.now + 4 * beat, 0.3 + lvl * 0.6);
    }
    if (name.startsWith('Gate')) {
      const div = name.endsWith('8') ? 2 : 4;
      const arm = () => {
        for (const k of [0, 1]) {
          if (!this.fx.target[k]) continue;
          const d = this.decks[k];
          const beat = 60 / ((d.track?.analysis?.bpm || 120) * (d.status.rate || 1));
          const t = this.engine.now + 0.02;
          d.gateAt(t, t + 1.3, beat / div, { depth: 0.4 + lvl * 0.6, duty: 0.5 });
        }
      };
      arm();
      this.fx.timer = setInterval(arm, 1000);
    }
  }

  fxClear() {
    this.clearFxTimer();
    for (const k of [0, 1]) {
      const d = this.decks[k];
      d.resetGate();
      d.setNow('echo', 0);
      d.setNow('reverb', 0);
      d.setNow('flanger', 0);
      const f = this.hw.filter[k];
      d.setNow('filter', this.mixerActive && f !== null ? filterOf(f) : 0);
    }
  }

  // ------------------------------------------------------------------ Bibliothek

  sources() {
    return this.getBrowse() || [];
  }

  currentList() {
    const s = this.sources();
    if (!s.length) return { label: '', tracks: [] };
    return s[this.browse.src % s.length];
  }

  browseMove(delta) {
    if (!delta) return;
    const list = this.currentList();
    if (!list.tracks.length) return;
    this.browse.index = clamp(this.browse.index + Math.round(delta), 0, list.tracks.length - 1);
    this.emit('browse', this.browseState());
  }

  browseSource() {
    const n = this.sources().length;
    if (n < 2) return;
    this.browse.src = (this.browse.src + 1) % n;
    this.browse.index = 0;
    this.emit('browse', this.browseState());
  }

  browseState() {
    const list = this.currentList();
    const idx = clamp(this.browse.index, 0, Math.max(0, list.tracks.length - 1));
    return { label: list.label, index: idx, count: list.tracks.length, tracks: list.tracks, sel: list.tracks[idx] || null };
  }

  async load(i) {
    const st = this.browseState();
    if (!st.sel) return this.toast('Erst mit dem Drehregler einen Titel auswählen');
    if (this.decks[i].status.playing) return this.toast(`Deck ${i + 1} läuft noch – erst anhalten`);
    const ok = await this.conductor.manualLoad(i, st.sel.id).catch((err) => {
      this.toast(`Laden fehlgeschlagen: ${err.message || err}`);
      return null;
    });
    if (ok) this.toast(`Deck ${i + 1}: ${st.sel.title}`);
    else if (ok === false) this.toast('Laden gerade nicht möglich (Übergang läuft oder Deck belegt)');
  }

  // ------------------------------------------------------------------ Anzeige/LED

  /** Zustand für LEDs und die Oberfläche. */
  state() {
    return [0, 1].map((i) => {
      const d = this.decks[i];
      const st = d.status;
      const cues = d.track ? this.conductor.cuesFor(d.track) : [];
      return {
        playing: !!st.playing,
        loaded: !!d.track,
        looping: st.loopLen > 0,
        pfl: d.cueOn,
        synced: false,
        cueSet: cues.map((c) => !!c),
        level: d.track ? d.level() : 0,
        atCue: d.track ? Math.abs(d.realAt(this.engine.now) / this.engine.sr - this.cuePointOf(i)) < 0.08 : false,
        range: RANGES[this.tempoRange[i]],
      };
    });
  }
}
