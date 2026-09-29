// Verbindet alles: MIDI-Geräte → Belegung (Profil + eigene MIDI-Learn-Zuweisungen) → Performer,
// dazu LEDs am Gerät, die Beobachtung deiner manuellen Übergänge und die Einstellungen.
import { MidiHub } from './midi.js';
import { Bindings, bindingFromMessage } from './mapper.js';
import { Performer } from './performer.js';
import { ManualObserver } from './observer.js';
import { ACTIONS } from './actions.js';
import { deviceKey } from './profiles.js';
import { addFeedback } from '../mix/feedback.js';

const STORE = 'automix.controller';

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

export class ControllerHost extends EventTarget {
  constructor({ engine, conductor, toast = () => {}, getBrowse, onLearned = () => {} }) {
    super();
    this.engine = engine;
    this.conductor = conductor;
    this.toast = toast;
    this.onLearned = onLearned;
    this.store = { autoManual: true, tempoInvert: false, cue: { mode: 'off', deviceId: '' }, headVol: 0.8, bindings: {}, ...loadStore() };
    this.hub = new MidiHub();
    this.performer = new Performer({ engine, conductor, toast, getBrowse, settings: this.store });
    this.bindings = new Map(); // device.id -> Bindings
    this.learning = null; // { action, deck }
    this.lastMessage = null;
    this.recent = []; // letzte MIDI-Nachrichten (Anzeige)
    this.known = new Set();
    this.ledCache = new Map();

    this.observer = new ManualObserver({
      decks: engine.decks,
      active: () => !conductor.automix,
    });
    this.observer.addEventListener('transition', (e) => this.onManualTransition(e.detail));

    this.hub.addEventListener('ports', () => this.onPorts());
    this.hub.addEventListener('message', (e) => this.onMessage(e.detail.device, e.detail.msg));
    this.ledTimer = setInterval(() => this.updateLeds(), 120);
    engine.setHeadVolume(this.store.headVol);
  }

  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.store));
    } catch {
      /* egal */
    }
  }

  set(name, value) {
    this.store[name] = value;
    this.performer.settings[name] = value;
    this.save();
    this.dispatchEvent(new CustomEvent('change'));
  }

  // ------------------------------------------------------------------ Verbindung

  async connect() {
    const ok = await this.hub.connect();
    this.dispatchEvent(new CustomEvent('change'));
    return ok;
  }

  onPorts() {
    for (const dev of this.hub.list()) {
      if (!this.bindings.has(dev.id)) this.bindings.set(dev.id, this.buildBindings(dev));
      if (dev.connected && !this.known.has(dev.id)) {
        this.known.add(dev.id);
        this.deviceAdded(dev);
      }
    }
    for (const id of [...this.known]) if (!this.hub.devices.has(id)) this.known.delete(id);
    this.dispatchEvent(new CustomEvent('change'));
  }

  deviceAdded(dev) {
    const usable = dev.profile || (this.store.bindings[deviceKey(dev.name)] || []).length;
    if (!usable) return; // ein beliebiges MIDI-Gerät (Keyboard …) meldet sich erst, wenn es belegt wird
    this.toast(`${dev.profile?.name || dev.name} verbunden`);
    if (this.store.autoManual && this.conductor.automix) {
      this.conductor.setAutomix(false);
      this.toast('Automix ausgeschaltet – du mixt jetzt selbst (Fader, EQ, Crossfader am Controller). Automix-Schalter oben schaltet zurück.');
    }
    this.ledCache.delete(dev.id);
  }

  buildBindings(dev) {
    const user = this.store.bindings[deviceKey(dev.name)] || [];
    return new Bindings([...(dev.profile?.bindings || []), ...user]);
  }

  rebuild() {
    for (const dev of this.hub.list()) this.bindings.set(dev.id, this.buildBindings(dev));
  }

  // ------------------------------------------------------------------ Nachrichten

  describe(msg) {
    const n = { note: 'Note', cc: 'CC', pitch: 'Pitch' }[msg.type];
    return `${n} Kanal ${msg.ch + 1} · ${msg.type === 'pitch' ? msg.d2 : `0x${msg.d1.toString(16).toUpperCase().padStart(2, '0')}`} · Wert ${msg.type === 'pitch' ? '' : msg.d2}`;
  }

  onMessage(dev, msg) {
    this.lastMessage = { device: dev.name, text: this.describe(msg), at: Date.now() };
    if (msg.type !== 'cc' || !this.learning) {
      // (Regler-Rauschen nicht im Protokoll fluten)
      this.recent.unshift(this.lastMessage.text);
      this.recent.length = Math.min(this.recent.length, 6);
    }
    this.dispatchEvent(new CustomEvent('message'));

    if (this.learning) return this.learn(dev, msg);
    const ev = this.bindings.get(dev.id)?.resolve(msg);
    if (!ev) return;
    try {
      this.performer.perform(ev);
    } catch (err) {
      console.error('Controller-Aktion', ev.action, err);
    }
  }

  // ------------------------------------------------------------------ MIDI-Learn

  startLearn(action, deck = null) {
    this.learning = { action, deck };
    this.dispatchEvent(new CustomEvent('change'));
  }

  cancelLearn() {
    this.learning = null;
    this.dispatchEvent(new CustomEvent('change'));
  }

  learn(dev, msg) {
    const { action, deck } = this.learning;
    // Noten: erst beim Drücken; CC: erste Bewegung. Loslassen (Note aus) ignorieren.
    if (msg.type === 'note' && !msg.on) return;
    const spec = ACTIONS[action];
    const b = bindingFromMessage(msg, action, spec.perDeck ? deck : null, spec.kind);
    if (!b) return;
    if (spec.kind === 'button' && b.t === 'cc') return; // Tasten sind Noten – ein Regler ist hier nicht gemeint
    const key = deviceKey(dev.name);
    const list = (this.store.bindings[key] ||= []).filter((x) => !(x.a === action && (x.deck ?? null) === (b.deck ?? null)));
    list.push(b);
    this.store.bindings[key] = list;
    this.save();
    this.rebuild();
    this.learning = null;
    this.toast(`„${spec.label}“${spec.perDeck ? ` (Deck ${deck + 1})` : ''} belegt: ${this.describe(msg)}`);
    this.dispatchEvent(new CustomEvent('change'));
  }

  clearUserBindings(dev) {
    delete this.store.bindings[deviceKey(dev.name)];
    this.save();
    this.rebuild();
    this.dispatchEvent(new CustomEvent('change'));
  }

  // ------------------------------------------------------------------ LEDs

  updateLeds() {
    const devs = this.hub.list().filter((d) => d.profile?.leds && d.output && d.connected);
    if (!devs.length) return;
    const st = this.performer.state();
    for (const dev of devs) {
      const L = dev.profile.leds;
      const cache = this.ledCache.get(dev.id) || new Map();
      this.ledCache.set(dev.id, cache);
      const led = (key, ch, note, on) => {
        if (cache.get(key) === on) return;
        cache.set(key, on);
        this.hub.send(dev, [0x90 | ch, note, on ? 0x7f : 0]);
      };
      for (const k of [0, 1]) {
        const s = st[k];
        led(`play${k}`, L.play.ch(k), L.play.note, s.playing);
        led(`cue${k}`, L.cue.ch(k), L.cue.note, s.loaded && (s.atCue || this.performer.previewing[k]));
        led(`pfl${k}`, L.pfl.ch(k), L.pfl.note, s.pfl);
        led(`reloop${k}`, L.reloop.ch(k), L.reloop.note, s.looping);
        led(`loopin${k}`, L.loopIn.ch(k), L.loopIn.note, s.looping);
        led(`loopout${k}`, L.loopOut.ch(k), L.loopOut.note, s.looping);
        for (let p = 0; p < 8; p++) led(`pad${k}${p}`, L.pad.ch(k), L.pad.note(p), !!s.cueSet[p]);
        // VU-Meter: 0..127 aus dem Spitzenpegel
        const vu = Math.max(0, Math.min(127, Math.round(Math.sqrt(s.level) * 127)));
        const vk = `vu${k}`;
        if (Math.abs((cache.get(vk) ?? -9) - vu) >= 3) {
          cache.set(vk, vu);
          this.hub.send(dev, [0xb0 | L.vu.ch(k), L.vu.cc, vu]);
        }
      }
    }
  }

  // ------------------------------------------------------------------ Lernen aus deinen Mixen

  onManualTransition(entry) {
    addFeedback(entry);
    this.recentMixes = [entry, ...(this.recentMixes || [])].slice(0, 5);
    const names = { blend: 'Blend', cut: 'Schnitt', filter: 'Filter-Blend', echo: 'Echo-Out', loop: 'Loop-Ausstieg' };
    this.toast(`Dein Übergang gemerkt: ${names[entry.type] || entry.type}, ${Math.round(entry.overlapSec)} s Überblendung`);
    this.onLearned(entry);
    this.dispatchEvent(new CustomEvent('change'));
  }

  // ------------------------------------------------------------------ Kopfhörer

  /** Kopfhörer-Ausgang einrichten: mode 'off' | 'device' | 'multi'. */
  async setCueOutput(mode, deviceId = '') {
    const ok = await this.engine.setCueOutput(mode, deviceId);
    if (!ok) {
      this.toast(mode === 'multi' ? 'Diese Soundkarte bietet keine 4 Kanäle im Browser – „Zweites Gerät“ nutzen' : 'Kopfhörer-Ausgabe nicht möglich');
      this.store.cue = { mode: 'off', deviceId: '' };
    } else this.store.cue = { mode, deviceId };
    this.save();
    this.dispatchEvent(new CustomEvent('change'));
    return ok;
  }

  setHeadVolume(v) {
    this.store.headVol = v;
    this.engine.setHeadVolume(v);
    this.save();
  }

  /** Nach dem Start die gemerkte Kopfhörer-Einstellung wiederherstellen. */
  async restore() {
    const c = this.store.cue;
    if (c?.mode && c.mode !== 'off') await this.setCueOutput(c.mode, c.deviceId).catch(() => {});
  }
}
