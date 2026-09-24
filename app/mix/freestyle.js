// Freestyle: Der DJ spielt auch mit dem laufenden Track, nicht nur beim Übergang. Alle 16–32 Takte
// kommt an einem Phrasenende ein kleiner Trick, der genau auf der Eins wieder aufgelöst wird:
// Echo-Wurf, Filter-Sweep, Bass-Cut, Beat-Repeat oder ein kurzer A-cappella-Moment.
// Schritte in Takten relativ zur Phrasengrenze (negativ = davor), wie beim Übergangs-Planer.
import { KILL } from './planner.js';

export const TRICKS = {
  echo: 'Echo-Wurf',
  sweep: 'Filter-Sweep in die Eins',
  bassCut: 'Bass-Cut vor der Eins',
  repeat: 'Beat-Repeat',
  acapella: 'kurzer A-cappella-Moment',
};

const p = (at, param, to, dur = 0) => ({ at, param, to, dur });

function build(kind) {
  switch (kind) {
    case 'echo':
      return [p(-0.25, 'echo', 0.45, 0.05), p(0, 'echo', 0, 0.25)];
    case 'sweep':
      return [p(-2, 'filter', 0.35, 1.95), p(0, 'filter', 0)];
    case 'bassCut':
      return [p(-0.25, 'low', KILL), p(0, 'low', 0)];
    case 'repeat':
      return [{ at: -0.5, action: 'loop', bars: 0.125, anchor: -0.5 }, { at: 0, action: 'unloop' }];
    case 'acapella':
      return [p(-1, 'low', KILL, 0.25), p(-1, 'filter', 0.4, 0.25), p(0, 'low', 0), p(0, 'filter', 0)];
    default:
      return null;
  }
}

/**
 * Nächster Trick im Track `a` ab Takt `barNow`: Phrasengrenze 2–12 Takte voraus, Trick passend zum
 * Abschnitt (vor einem Drop eher Bass-Cut/Repeat, im Gesang eher A-cappella/Echo).
 * dice: 0..1 für Abwechslung, last: zuletzt gespielter Trick (nicht direkt wiederholen).
 */
export function planTrick(a, barNow, dice = Math.random(), last = null) {
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
    repeat: (a.barDrums?.[next.bar - 1] ?? 0) > 0.4 ? (intoMain ? 1.4 : 0.8) : 0,
    acapella: vocalEnd >= 0.5 ? 1.1 : 0,
  };
  if (last && w[last]) w[last] *= 0.2;
  const total = Object.values(w).reduce((s, v) => s + v, 0);
  let r = dice * total;
  let kind = 'echo';
  for (const [k, v] of Object.entries(w)) {
    if ((r -= v) <= 0) {
      kind = k;
      break;
    }
  }
  return { bar: next.bar, kind, name: TRICKS[kind], steps: build(kind) };
}
