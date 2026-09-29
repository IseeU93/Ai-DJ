// Alles, was man am Controller belegen kann. Ein Controller-Profil (profiles.js) oder eine eigene
// MIDI-Learn-Belegung verbindet eine MIDI-Nachricht mit einer dieser Aktionen; der Performer
// (performer.js) führt sie aus. kind: button (gedrückt/losgelassen), abs (Regler 0..1), rel (Drehgeber).

const PAD_LOOP = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const PAD_JUMP = [-1, 1, -2, 2, -4, 4, -8, 8];

const actions = {};
const add = (id, label, kind, group, perDeck = true, extra = {}) => (actions[id] = { id, label, kind, group, perDeck, ...extra });

add('play', 'Play / Pause', 'button', 'Transport');
add('cue', 'Cue (halten = Vorhören)', 'button', 'Transport');
add('cueStart', 'Zum Anfang springen', 'button', 'Transport');
add('censor', 'Censor (rückwärts, halten)', 'button', 'Transport');
add('sync', 'Sync (Tempo + Takt)', 'button', 'Transport');
add('tempoRange', 'Tempo-Bereich wechseln (±6/10/16/25 %)', 'button', 'Transport');
add('keylock', 'Keylock an/aus', 'button', 'Transport');
add('load', 'Markierten Track laden', 'button', 'Bibliothek');
add('browse', 'Bibliothek durchblättern (Drehgeber)', 'rel', 'Bibliothek', false);
add('browseFast', 'Bibliothek schnell durchblättern', 'rel', 'Bibliothek', false);
add('browsePress', 'Bibliothek: Quelle wechseln (Bibliothek/Queue)', 'button', 'Bibliothek', false);
add('loopIn', 'Loop In', 'button', 'Loop');
add('loopOut', 'Loop Out', 'button', 'Loop');
add('reloop', 'Reloop / Loop aus', 'button', 'Loop');
add('loopExit', 'Loop verlassen', 'button', 'Loop');
add('loopHalf', 'Loop halbieren', 'button', 'Loop');
add('loopDouble', 'Loop verdoppeln', 'button', 'Loop');
add('jumpBack', '16 Schläge zurück', 'button', 'Loop');
add('jumpFwd', '16 Schläge vor', 'button', 'Loop');
add('pfl', 'Kopfhörer-Cue (PFL)', 'button', 'Mixer');
add('fader', 'Kanalfader', 'abs', 'Mixer');
add('trim', 'Trim / Gain', 'abs', 'Mixer');
add('eqHigh', 'EQ Höhen', 'abs', 'Mixer');
add('eqMid', 'EQ Mitten', 'abs', 'Mixer');
add('eqLow', 'EQ Bass', 'abs', 'Mixer');
add('filter', 'Filter (links Tiefpass, rechts Hochpass)', 'abs', 'Mixer');
add('tempo', 'Tempo-Fader', 'abs', 'Transport');
add('crossfader', 'Crossfader', 'abs', 'Mixer', false);
add('headMix', 'Kopfhörer-Mix (Cue ↔ Master)', 'abs', 'Mixer', false);
add('headVol', 'Kopfhörer-Lautstärke', 'abs', 'Mixer', false);
add('masterVol', 'Master-Lautstärke', 'abs', 'Mixer', false);
add('jogTouch', 'Jog: Platte berührt', 'button', 'Jog');
add('jogPlatter', 'Jog: Platte drehen (Scratch / Nudge)', 'rel', 'Jog');
add('jogPlatterFree', 'Jog: Platte drehen (Vinyl aus → Nudge)', 'rel', 'Jog');
add('jogSide', 'Jog: Rand drehen (Nudge)', 'rel', 'Jog');
add('jogSearch', 'Jog: Suchlauf (Shift + Drehen)', 'rel', 'Jog');
add('fxOn', 'Beat-FX an/aus', 'button', 'Effekte', false);
add('fxOff', 'Beat-FX alle aus', 'button', 'Effekte', false);
add('fxNext', 'Beat-FX: nächster Effekt', 'button', 'Effekte', false);
add('fxPrev', 'Beat-FX: voriger Effekt', 'button', 'Effekte', false);
add('fxLevel', 'Beat-FX: Menge', 'abs', 'Effekte', false);
add('fxTarget', 'Beat-FX: Kanal wählen', 'button', 'Effekte');
add('fxTargetBoth', 'Beat-FX: beide Kanäle', 'button', 'Effekte', false);
add('shift', 'Shift (Anzeige)', 'button', 'Sonstiges');
for (let n = 0; n < 8; n++) {
  add(`hotcue${n}`, `Hot Cue ${n + 1}`, 'button', 'Pads', true, { pad: n });
  add(`hotcueClear${n}`, `Hot Cue ${n + 1} löschen`, 'button', 'Pads', true, { pad: n });
  add(`beatloop${n}`, `Beat-Loop ${PAD_LOOP[n]} Schläge`, 'button', 'Pads', true, { pad: n });
  add(`beatjump${n}`, `Beat-Jump ${PAD_JUMP[n] > 0 ? '+' : ''}${PAD_JUMP[n]}`, 'button', 'Pads', true, { pad: n });
  add(`fxpad${n}`, `Effekt-Pad ${n + 1}`, 'button', 'Pads', true, { pad: n });
}
add('jumpSizeDown', 'Beat-Jump-Größe ÷16', 'button', 'Pads');
add('jumpSizeUp', 'Beat-Jump-Größe ×16', 'button', 'Pads');

export const ACTIONS = actions;
export { PAD_LOOP, PAD_JUMP };

/** Namen der Effekt-Pads (Sampler-Pads des Controllers spielen hier One-Shot-Effekte). */
export const FX_PADS = [
  'Riser', 'Downlifter', 'Echo-Wurf', 'Hall-Wurf', 'Gate 1/8', 'Gate 1/16', 'Flanger-Sweep', 'Filter-Riser',
];
