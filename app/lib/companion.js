// Brücke zur Handy-App (AI-DJ Companion): Status an den Companion-Server (Rust, Port 7777) melden,
// Befehle vom Handy ausführen und Ereignisse schicken (z. B. "Playlist fast vorbei" -> Push aufs Handy).
// Im Browser-Test übernimmt tools/dev-server.mjs die Rolle des Servers.

const invoke = (cmd, args) => window.__TAURI__?.core?.invoke(cmd, args);
const WARN_AT = [10, 3, 1]; // Warnung bei noch 10, 3 und 1 Songs in der Queue

function trackInfo(t) {
  if (!t) return null;
  const a = t.analysis || {};
  return {
    id: t.id,
    title: t.title || t.name || '',
    artist: t.artist || '',
    bpm: a.bpm ? Math.round(a.bpm * 10) / 10 : null,
    key: a.key?.camelot || null,
    genre: t.genre || null,
    dur: a.duration ? Math.round(a.duration) : null,
  };
}

/**
 * @param actions Funktionen aus main.js, die die UI mitziehen (Schalter, Regler, Bewertung)
 */
export function initCompanion({ engine, conductor, actions, onWarning }) {
  if (!window.__TAURI__?.core) return null;
  let lastJson = '';
  let warned = new Set();
  let lastRemaining = Infinity;

  const remaining = () => Math.max(0, conductor.queue.length - (conductor.pos + 1));

  function buildState() {
    const md = conductor.masterDeck;
    const t = md.track;
    const pos = t ? md.realAt(engine.now) / engine.sr : 0;
    const p = conductor.plan;
    const q = conductor.queue;
    const from = Math.max(0, conductor.pos);
    const laser = window.__automixLaser;
    return {
      now: t ? { ...trackInfo(t), pos: Math.round(pos), playing: md.status.playing, deck: 'AB'[conductor.master] } : null,
      next: trackInfo(conductor.track(q[conductor.pos + 1])),
      plan: p ? {
        label: p.label,
        type: p.type,
        committed: !!p.committed,
        inSec: p.firstStepTime ? Math.max(0, Math.round(p.firstStepTime - engine.now)) : null,
        extended: conductor.extendFrom != null,
        notes: (p.notes || []).slice(0, 3),
      } : null,
      queue: q.slice(from, from + 60).map((id, k) => ({ ...trackInfo(conductor.track(id)), i: from + k, current: from + k === conductor.pos })),
      editableFrom: conductor.editableFrom,
      remaining: remaining(),
      flags: {
        automix: conductor.automix,
        autopilot: conductor.autopilot,
        freestyle: conductor.freestyle,
        laser: document.querySelector('#shell')?.dataset.laser || 'off',
        blackout: !!laser?.manualBlackout,
      },
      master: Math.round((engine.masterVolume ?? 1) * 100) / 100,
      lastTransition: actions.lastTransition?.() || null,
      learned: document.querySelector('#tr-learned')?.textContent?.replace(' · Protokoll kopieren', '') || '',
    };
  }

  function push() {
    try {
      const json = JSON.stringify(buildState());
      if (json !== lastJson) {
        lastJson = json;
        invoke('companion_push', { state: json })?.catch?.(() => {});
      }
    } catch (err) {
      console.error('Companion', err);
    }
    checkWarning();
  }

  function event(type, data) {
    invoke('companion_event', { event: JSON.stringify({ type, time: Date.now(), ...data }) })?.catch?.(() => {});
  }

  function checkWarning() {
    const n = remaining();
    if (!conductor.queue.length || conductor.pos < 0) return;
    if (n > lastRemaining) warned = new Set([...warned].filter((w) => w >= n)); // Queue wieder aufgefüllt
    lastRemaining = n;
    for (const w of WARN_AT) {
      if (n <= w && n > 0 && !warned.has(w)) {
        warned.add(w);
        // nur die knappste zutreffende Stufe melden
        for (const x of WARN_AT) if (x > w) warned.add(x);
        const text = n === 1 ? 'Nur noch 1 Song in der Queue!' : `Nur noch ${n} Songs in der Queue – Playlist fast vorbei`;
        onWarning?.(text, n);
        event('playlistLow', { remaining: n, text });
        break;
      }
    }
  }

  const COMMANDS = {
    togglePlay: () => conductor.togglePlay(conductor.master),
    mixNow: () => conductor.mixNow(),
    extend: () => conductor.extend(),
    skip: () => {
      const next = conductor.track(conductor.queue[conductor.pos + 1]);
      if (next) conductor.mixSoon(next);
    },
    playNext: ({ index }) => conductor.playNext(index),
    remove: ({ index }) => conductor.remove(index),
    move: ({ from, to }) => conductor.move(from, to),
    reorder: () => conductor.reorderAI(),
    reshuffle: () => conductor.reshuffle(),
    automix: ({ on }) => actions.setSwitch('#automix', on),
    autopilot: ({ on }) => actions.setSwitch('#autopilot', on),
    freestyle: ({ on }) => actions.setSwitch('#freestyle', on),
    master: ({ value }) => actions.setMaster(Math.max(0, Math.min(1, +value))),
    laser: () => document.querySelector('#btn-laser')?.click(),
    blackout: () => document.querySelector('#lz-blackout')?.click(),
    rate: ({ verdict, reason }) => actions.rate(verdict, reason),
  };

  window.__TAURI__.event?.listen('companion-cmd', (e) => {
    try {
      const msg = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
      const fn = COMMANDS[msg.cmd];
      if (fn) {
        fn(msg);
        setTimeout(push, 50);
      }
    } catch (err) {
      console.error('Companion-Befehl', err);
    }
  });

  setInterval(push, 500);
  push();
  return { info: () => invoke('companion_info'), event };
}
