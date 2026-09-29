// Web-MIDI-Zugang: findet angeschlossene DJ-Controller (USB), meldet Ein-/Ausstecken und gibt die
// Nachrichten decodiert weiter. Zu jedem Eingang wird der gleichnamige Ausgang für die LEDs gesucht.
import { decode } from './mapper.js';
import { profileFor } from './profiles.js';

export class MidiHub extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.devices = new Map(); // input.id -> { id, name, manufacturer, profile, input, output }
    this.error = null;
  }

  get supported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  /** Zugriff anfordern (fragt evtl. nach Erlaubnis). Liefert true bei Erfolg. */
  async connect() {
    if (!this.supported) {
      this.error = 'Dieser Browser/Webview unterstützt kein Web-MIDI.';
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.error = `MIDI-Zugriff nicht erlaubt: ${err?.message || err}`;
      this.dispatchEvent(new CustomEvent('ports'));
      return false;
    }
    this.error = null;
    this.access.onstatechange = () => this.refresh();
    this.refresh();
    return true;
  }

  refresh() {
    if (!this.access) return;
    const inputs = [...this.access.inputs.values()];
    const outputs = [...this.access.outputs.values()];
    const seen = new Set();
    for (const input of inputs) {
      seen.add(input.id);
      let dev = this.devices.get(input.id);
      const connected = input.state === 'connected';
      if (!dev) {
        dev = { id: input.id, name: input.name || 'MIDI-Gerät', manufacturer: input.manufacturer || '', profile: profileFor(input.name), input, output: null, connected };
        this.devices.set(input.id, dev);
        input.onmidimessage = (e) => this.onMessage(dev, e.data);
      }
      dev.connected = connected;
      dev.output = outputs.find((o) => o.name === input.name && o.state === 'connected') || outputs.find((o) => o.name === input.name) || null;
    }
    for (const id of [...this.devices.keys()]) if (!seen.has(id)) this.devices.delete(id);
    this.dispatchEvent(new CustomEvent('ports'));
  }

  list() {
    return [...this.devices.values()];
  }

  onMessage(dev, data) {
    const msg = decode(data);
    if (!msg) return;
    this.dispatchEvent(new CustomEvent('message', { detail: { device: dev, msg } }));
  }

  /** Bytes an ein Gerät schicken (LEDs). Fehler werden verschluckt – ein Gerät ohne Ausgang stört nicht. */
  send(dev, bytes) {
    try {
      dev.output?.send(bytes);
    } catch {
      /* getrennt */
    }
  }
}
