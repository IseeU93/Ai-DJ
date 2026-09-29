// Controller-Profile: welche MIDI-Nachricht (Kanal, Note/CC) welche Aktion auslöst.
// Ein Profil wird über den Namen des MIDI-Geräts gefunden; für alles andere gibt es MIDI-Learn
// (learn.js) – dort belegt man jede Aktion per Tastendruck selbst, das wird pro Gerät gespeichert.
//
// Binding: { t: 'note' | 'cc', ch, d1, enc, lsb?, a: Aktion, deck?: 0|1 }
//   enc (nur cc): 'abs' (7 Bit), 'abs14' (MSB d1 + LSB lsb), 'center' (Drehgeber um 64), 'signed' (1 / 127 = ±1)

/** Pioneer DDJ-FLX4 (Belegung nach der offiziellen MIDI-Liste bzw. der Mixxx-Belegung). */
function ddjFlx4() {
  const out = [];
  for (const k of [0, 1]) {
    const n = (d1, a, extra = {}) => out.push({ t: 'note', ch: k, d1, a, deck: k, ...extra });
    const cc = (d1, a, enc, extra = {}) => out.push({ t: 'cc', ch: k, d1, a, enc, deck: k, ...extra });
    n(0x0b, 'play');
    n(0x47, 'play'); // Shift + Play kommt je nach Firmware auch hier an
    n(0x0e, 'censor');
    n(0x0c, 'cue');
    n(0x48, 'cueStart');
    n(0x58, 'sync');
    n(0x5c, 'sync');
    n(0x60, 'tempoRange');
    n(0x10, 'loopIn');
    n(0x11, 'loopOut');
    n(0x4d, 'reloop');
    n(0x50, 'loopExit');
    n(0x51, 'loopHalf');
    n(0x53, 'loopDouble');
    n(0x3e, 'jumpBack');
    n(0x3d, 'jumpFwd');
    n(0x54, 'pfl');
    n(0x36, 'jogTouch');
    n(0x67, 'jogTouch');
    n(0x3f, 'shift');
    cc(0x22, 'jogPlatter', 'center');
    cc(0x23, 'jogPlatterFree', 'center');
    cc(0x21, 'jogSide', 'center');
    cc(0x29, 'jogSearch', 'center');
    cc(0x00, 'tempo', 'abs14', { lsb: 0x20 });
    cc(0x13, 'fader', 'abs14', { lsb: 0x33 });
    cc(0x04, 'trim', 'abs14', { lsb: 0x24 });
    cc(0x07, 'eqHigh', 'abs14', { lsb: 0x27 });
    cc(0x0b, 'eqMid', 'abs14', { lsb: 0x2b });
    cc(0x0f, 'eqLow', 'abs14', { lsb: 0x2f });
    // Performance-Pads: 0x97/0x98 = Deck 1 (normal/Shift), 0x99/0x9A = Deck 2
    const padCh = k === 0 ? 7 : 9;
    const padChShift = padCh + 1;
    for (let p = 0; p < 8; p++) {
      out.push({ t: 'note', ch: padCh, d1: p, a: `hotcue${p}`, deck: k });
      out.push({ t: 'note', ch: padChShift, d1: p, a: `hotcueClear${p}`, deck: k });
      out.push({ t: 'note', ch: padCh, d1: 0x60 + p, a: `beatloop${p}`, deck: k });
      out.push({ t: 'note', ch: padCh, d1: 0x20 + p, a: `beatjump${p}`, deck: k });
      out.push({ t: 'note', ch: padCh, d1: 0x30 + p, a: `fxpad${p}`, deck: k });
    }
    out.push({ t: 'note', ch: padChShift, d1: 0x26, a: 'jumpSizeDown', deck: k });
    out.push({ t: 'note', ch: padChShift, d1: 0x27, a: 'jumpSizeUp', deck: k });
  }
  // Browse-Bereich und Mixer-Mitte laufen auf Kanal 7 (0x96 / 0xB6)
  out.push({ t: 'cc', ch: 6, d1: 0x40, a: 'browse', enc: 'signed' });
  out.push({ t: 'cc', ch: 6, d1: 0x64, a: 'browseFast', enc: 'signed' });
  out.push({ t: 'note', ch: 6, d1: 0x41, a: 'browsePress' });
  out.push({ t: 'note', ch: 6, d1: 0x42, a: 'browsePress' });
  out.push({ t: 'note', ch: 6, d1: 0x46, a: 'load', deck: 0 });
  out.push({ t: 'note', ch: 6, d1: 0x47, a: 'load', deck: 1 });
  out.push({ t: 'cc', ch: 6, d1: 0x1f, a: 'crossfader', enc: 'abs14', lsb: 0x3f });
  out.push({ t: 'cc', ch: 6, d1: 0x17, a: 'filter', enc: 'abs14', lsb: 0x37, deck: 0 });
  out.push({ t: 'cc', ch: 6, d1: 0x18, a: 'filter', enc: 'abs14', lsb: 0x38, deck: 1 });
  out.push({ t: 'cc', ch: 6, d1: 0x0c, a: 'headMix', enc: 'abs14', lsb: 0x2c });
  // Beat-FX
  out.push({ t: 'note', ch: 4, d1: 0x47, a: 'fxOn' });
  out.push({ t: 'note', ch: 5, d1: 0x47, a: 'fxOn' });
  out.push({ t: 'note', ch: 4, d1: 0x43, a: 'fxOff' });
  out.push({ t: 'note', ch: 5, d1: 0x43, a: 'fxOff' });
  out.push({ t: 'note', ch: 4, d1: 0x63, a: 'fxNext' });
  out.push({ t: 'note', ch: 4, d1: 0x64, a: 'fxPrev' });
  out.push({ t: 'note', ch: 4, d1: 0x4b, a: 'fxNext' });
  out.push({ t: 'note', ch: 4, d1: 0x4a, a: 'fxPrev' });
  out.push({ t: 'note', ch: 4, d1: 0x10, a: 'fxTarget', deck: 0 });
  out.push({ t: 'note', ch: 4, d1: 0x11, a: 'fxTarget', deck: 1 });
  out.push({ t: 'note', ch: 5, d1: 0x11, a: 'fxTarget', deck: 1 });
  out.push({ t: 'note', ch: 4, d1: 0x14, a: 'fxTargetBoth' });
  out.push({ t: 'cc', ch: 4, d1: 0x02, a: 'fxLevel', enc: 'abs' });
  return out;
}

/** LED-Ausgaben (welche Note auf welchem Kanal leuchtet) – nur für Geräte, die das mitmachen. */
const FLX4_LEDS = {
  play: { ch: (k) => k, note: 0x0b },
  cue: { ch: (k) => k, note: 0x0c },
  sync: { ch: (k) => k, note: 0x58 },
  pfl: { ch: (k) => k, note: 0x54 },
  loopIn: { ch: (k) => k, note: 0x10 },
  loopOut: { ch: (k) => k, note: 0x11 },
  reloop: { ch: (k) => k, note: 0x4d },
  pad: { ch: (k) => (k === 0 ? 7 : 9), note: (p) => p }, // Hot-Cue-Pads
  vu: { ch: (k) => k, cc: 0x02 },
};

export const PROFILES = [
  {
    id: 'ddj-flx4',
    name: 'Pioneer DDJ-FLX4',
    match: /DDJ[-\s]?FLX\s?4|DDJ[-\s]?400|DDJ[-\s]?FLX/i,
    bindings: ddjFlx4(),
    leds: FLX4_LEDS,
  },
];

/** Profil zu einem MIDI-Gerätenamen (oder null → nur MIDI-Learn). */
export function profileFor(deviceName) {
  return PROFILES.find((p) => p.match.test(deviceName || '')) || null;
}

/** Gerätename → Speicherschlüssel für eigene Belegungen. */
export function deviceKey(name) {
  return String(name || 'unbekannt').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
