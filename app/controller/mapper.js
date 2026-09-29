// MIDI-Nachrichten lesen und über die Belegung (Profil + eigene MIDI-Learn-Zuweisungen) in Aktionen
// übersetzen. Reine Logik ohne Browser-Abhängigkeiten, damit sie sich testen lässt.

/** Rohbytes → { type: 'note'|'cc'|'pitch', on?, ch, d1, d2 } (null bei Systemnachrichten). */
export function decode(data) {
  if (!data || data.length < 2) return null;
  const status = data[0];
  if (status >= 0xf0) return null;
  const kind = status & 0xf0;
  const ch = status & 0x0f;
  const d1 = data[1];
  const d2 = data[2] ?? 0;
  if (kind === 0x90) return { type: 'note', on: d2 > 0, ch, d1, d2 };
  if (kind === 0x80) return { type: 'note', on: false, ch, d1, d2 };
  if (kind === 0xb0) return { type: 'cc', ch, d1, d2 };
  if (kind === 0xe0) return { type: 'pitch', ch, d1: 0, d2: (d2 << 7) | d1 };
  return null;
}

const key = (t, ch, d1) => `${t}:${ch}:${d1}`;

export class Bindings {
  /** @param list Binding-Liste; spätere Einträge überschreiben frühere mit gleicher MIDI-Nachricht */
  constructor(list = []) {
    this.map = new Map();
    this.state = new Map(); // 14-Bit-Regler: zuletzt gesehenes MSB/LSB
    for (const b of list) this.add(b);
  }

  add(b) {
    this.map.set(key(b.t, b.ch, b.d1), b);
    if (b.enc === 'abs14' && b.lsb !== undefined) this.map.set(key(b.t, b.ch, b.lsb), { ...b, isLsb: true, base: b });
  }

  /**
   * Nachricht → Ereignis für den Performer oder null (unbelegt).
   * { action, deck, value?, delta?, down? }
   */
  resolve(msg) {
    if (!msg) return null;
    if (msg.type === 'pitch') {
      const b = this.map.get(key('pitch', msg.ch, 0));
      return b ? { action: b.a, deck: b.deck, value: msg.d2 / 16383 } : null;
    }
    const b = this.map.get(key(msg.type, msg.ch, msg.d1));
    if (!b) return null;
    const base = b.base || b;
    const ev = { action: base.a, deck: base.deck };
    if (msg.type === 'note') {
      ev.down = msg.on;
      return ev;
    }
    switch (base.enc) {
      case 'abs14': {
        const st = this.state.get(base) || { msb: 0, lsb: 0 };
        if (b.isLsb) st.lsb = msg.d2;
        else {
          st.msb = msg.d2;
          st.lsb = 0; // nächstes LSB kommt gleich; bis dahin die grobe Stellung
        }
        this.state.set(base, st);
        ev.value = ((st.msb << 7) | st.lsb) / 16383;
        return ev;
      }
      case 'center':
        ev.delta = msg.d2 - 64;
        return ev;
      case 'signed':
        ev.delta = msg.d2 >= 64 ? msg.d2 - 128 : msg.d2;
        return ev;
      default:
        ev.value = msg.d2 / 127;
        return ev;
    }
  }
}

/** Ereignis aus MIDI-Learn: welche Bindung passt zu dieser Nachricht und diesem Aktionstyp? */
export function bindingFromMessage(msg, action, deck, kind, prevValue = null) {
  if (!msg || msg.type === 'pitch') return null;
  const b = { t: msg.type, ch: msg.ch, d1: msg.d1, a: action };
  if (deck !== null && deck !== undefined) b.deck = deck;
  if (msg.type === 'cc') {
    if (kind === 'rel') b.enc = msg.d2 >= 1 && msg.d2 <= 8 || msg.d2 >= 120 ? 'signed' : 'center';
    else b.enc = 'abs';
  }
  return b;
}
