// Freestyle: Der DJ spielt auch mit dem laufenden Track, nicht nur beim Übergang. Alle 16–32 Takte
// kommt an einem Phrasenende ein kleiner Trick, der genau auf der Eins wieder aufgelöst wird:
// Echo-/Hall-Wurf, Filter-/Flanger-Sweep, Bass-Cut, Beat-Repeat, Stutter-Gate, Noise-Riser oder ein
// kurzer A-cappella-Moment.
// Schritte in Takten relativ zur Phrasengrenze (negativ = davor), wie beim Übergangs-Planer.
import { KILL } from './planner.js';

export const TRICKS = {
  echo: 'Echo-Wurf',
  sweep: 'Filter-Sweep in die Eins',
  bassCut: 'Bass-Cut vor der Eins',
  repeat: 'Beat-Repeat',
  acapella: 'kurzer A-cappella-Moment',
  reverb: 'Hall-Wurf',
  flanger: 'Flanger-Sweep',
  stutter: 'Stutter-Gate in die Eins',
  riser: 'Noise-Riser in den Drop',
};

const p = (at, param, to, dur = 0) => ({ at, param, to, dur });

function build(kind, intoMain = false) {
  switch (kind) {
    case 'echo':
      // Echo-Wurf: letzter Schlag wird ins Echo geworfen, der Track selbst taucht kurz ab – so hört
      // man die Wiederholungen – und ist auf der Eins wieder voll da
      return [p(-0.25, 'echo', 0.6, 0.03), p(-0.25, 'fader', 0.25, 0.05), p(0, 'fader', 1, 0.02), p(0, 'echo', 0, 0.5)];
    case 'sweep':
      return intoMain
        ? [p(-4, 'filter', 0.5, 3.95), p(0, 'filter', 0)]
        : [p(-2, 'filter', 0.4, 1.95), p(0, 'filter', 0)];
    case 'bassCut':
      // ein ganzer Takt ohne Bass, dann knallt er auf der Eins zurück
      return [p(-1, 'low', KILL, 0.05), p(0, 'low', 0)];
    case 'repeat':
      // Beat-Repeat, dezent: der vorletzte Schlag erklingt einfach zweimal (kein hektisches Stottern)
      return [{ at: -0.5, action: 'loop', bars: 0.25, anchor: -0.5 }, { at: 0, action: 'unloop' }];
    case 'acapella':
      return [p(-1, 'low', KILL, 0.25), p(-1, 'filter', 0.45, 0.25), p(0, 'low', 0), p(0, 'filter', 0)];
    case 'reverb':
      // letzter Schlag in den Hall geworfen, Track taucht kurz ab, auf der Eins wieder voll da
      return [p(-0.25, 'reverb', 0.7, 0.05), p(-0.25, 'fader', 0.35, 0.05), p(0, 'fader', 1, 0.02), p(0, 'reverb', 0, 0.25)];
    case 'flanger':
      return [p(-2, 'flanger', 0.85, 1), p(0, 'flanger', 0, 0.02)];
    case 'stutter':
      // letzter halber Takt in 16teln zerhackt – nur vor einem Drop, dann kommt die Eins voll
      return [{ at: -0.5, action: 'gate', bars: 0.5, div: 16, depth: 0.85 }];
    case 'riser':
      return [{ at: -4, action: 'riser', bars: 4, level: 0.09 }, p(-4, 'filter', 0.35, 3.95), p(0, 'filter', 0)];
    default:
      return null;
  }
}

/**
 * Nächster Trick im Track `a` ab Takt `barNow`: Phrasengrenze 2–12 Takte voraus, Trick passend zum
 * Abschnitt (vor einem Drop eher Bass-Cut/Repeat, im Gesang eher A-cappella/Echo).
 * dice: 0..1 für Abwechslung, last: zuletzt gespielter Trick (nicht direkt wiederholen).
 */
export function planTrick(a, barNow, dice = Math.random(), last = null, weights = {}) {
  const phrases = a.phrases || [];
  const next = phrases.find((ph) => ph.bar >= barNow + 2 && ph.bar <= barNow + 12);
  if (!next) return null;
  const i = phrases.indexOf(next);
  const prev = phrases[i - 1];
  if (!prev || next.bar > (a.points?.lastBar ?? Infinity) - 4) return null;
  const vocalEnd = a.vocals?.[next.bar - 1] ?? 0;
  const intoMain = next.label === 'main' && prev.label !== 'main';
  const w = {
    echo: 1,
    sweep: prev.label === 'main' || prev.label === 'build' ? 1 : 0.4,
    bassCut: intoMain ? 1.6 : next.label === 'main' ? 0.8 : 0.2,
    repeat: (a.barDrums?.[next.bar - 1] ?? 0) > 0.4 ? (intoMain ? 0.6 : 0.3) : 0,
    acapella: vocalEnd >= 0.5 ? 1.1 : 0,
    reverb: 0.7,
    flanger: prev.label === 'main' || prev.label === 'build' ? 0.6 : 0.3,
    stutter: intoMain && (a.barDrums?.[next.bar - 1] ?? 0) > 0.4 ? 0.5 : 0,
    riser: intoMain ? 0.6 : 0,
  };
  // aus deinen 👍/👎: klar abgelehnte Tricks (mehrfach 👎) kommen gar nicht mehr
  for (const k of Object.keys(w)) w[k] = (weights[k] ?? 1) < 0.2 ? 0 : w[k] * (weights[k] ?? 1);
  if (last && w[last]) w[last] *= 0.2;
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  let r = dice * total;
  let kind = Object.keys(w).filter((k) => w[k] > 0).pop(); // Rundungs-Rest: letzter erlaubter Trick
  for (const [k, v] of Object.entries(w)) {
    if ((r -= v) <= 0) {
      kind = k;
      break;
    }
  }
  return { bar: next.bar, kind, name: TRICKS[kind], steps: build(kind, intoMain) };
}
