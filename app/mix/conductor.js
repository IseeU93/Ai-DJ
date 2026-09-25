// Conductor: Queue + Automix. Plant den nächsten Übergang, lädt den nächsten Track vor und
// setzt den Plan kurz vor dem Einsatz sample-genau in Deck-Befehle und Parameter-Automation um.
import { planTransition, barToSeconds, secondsToBar, beatToSeconds, secondsToBeat } from './planner.js';
import { assignEnergy, buildSetOrder, tempoRelation } from './order.js';
import { NEUTRAL, PARAMS } from '../audio/engine.js';
import { readFile } from '../lib/tauri.js';
import { detectGenre } from './genre.js';
import { planTrick } from './freestyle.js';
import { planTeaser } from './teaser.js';
import { pairEasterEggs, planEasterEgg } from './eastereggs.js';
import { KILL } from './planner.js';

const COMMIT_MARGIN = 1.5; // s: so früh vor dem ersten Schritt wird der Plan fest eingeplant
const LEAD_SECONDS = 2.5; // Mindestvorlauf für normal geplante Übergänge
const INSTANT_LEAD = 0.45; // s: "Jetzt mixen" startet auf dem nächsten Takt nach dieser Zeit
const CUE_STORE = 'automix.cues';

function loadCues() {
  try {
    return JSON.parse(localStorage.getItem(CUE_STORE)) || {};
  } catch {
    return {};
  }
}

function saveCues(all) {
  try {
    localStorage.setItem(CUE_STORE, JSON.stringify(all));
  } catch {
    /* egal */
  }
}

export class Conductor extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.decks = engine.decks;
    this.tracks = new Map();
    this.queue = [];
    this.removed = [];
    this.pos = -1;
    this.master = 0;
    this.automix = true;
    this.plan = null;
    this.history = [];
    this.overrides = new Map();
    this.rampUntil = 0;
    this.loading = [null, null];
    this.forceSoon = false;
    this.autopilot = false;
    this.freestyle = false;
    this.learned = { bias: {}, tune: {} }; // aus deinen Bewertungen (siehe feedback.js)
    this.nextTrickAt = 0;
    this.lastTrick = null;
    this.timer = setInterval(() => this.tick(), 40);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  track(id) {
    return this.tracks.get(id);
  }

  get masterDeck() {
    return this.decks[this.master];
  }

  // ------------------------------------------------------------------ Queue

  /**
   * Effektive Musikrichtung je Track: Track-Override > Playlist-Override > automatisch.
   * resolve(track) liefert den Override oder null.
   */
  applyGenres(resolve) {
    for (const t of this.tracks.values()) {
      t.genreAuto = detectGenre(t.analysis);
      t.genreManual = resolve?.(t) || null;
      t.genre = t.genreManual || t.genreAuto;
    }
    this.invalidatePlan();
    this.emit('queue');
  }

  setLibrary(list, resolveGenre) {
    this.tracks = new Map(list.map((t) => [t.id, t]));
    this.resolveGenre = resolveGenre || this.resolveGenre;
    for (const t of list) {
      t.genreAuto = detectGenre(t.analysis);
      t.genreManual = this.resolveGenre?.(t) || null;
      t.genre = t.genreManual || t.genreAuto;
    }
    assignEnergy(list);
    const playing = this.queue.slice(0, this.pos + 1).filter((id) => this.tracks.has(id));
    const fixed = playing.map((id) => this.tracks.get(id));
    const rest = list.filter((t) => !playing.includes(t.id));
    this.queue = this.pairEggs(buildSetOrder([...fixed, ...rest], fixed).map((t) => t.id), fixed.length);
    this.removed = [];
    this.pos = playing.length - 1;
    this.invalidatePlan();
    this.emit('queue');
  }

  /** Erste Position, die noch verschoben werden darf. */
  get editableFrom() {
    return this.pos + 1 + (this.plan?.committed ? 1 : 0);
  }

  /** KI-Reihenfolge – jedes Mal eine eigene, gute Variante (nicht immer dieselbe). */
  reorderAI(seed = 1 + Math.floor(Math.random() * 1e9)) {
    const from = this.editableFrom;
    const fixed = this.queue.slice(0, from).map((id) => this.track(id));
    const all = this.queue.map((id) => this.track(id));
    this.queue = this.pairEggs(buildSetOrder(all, fixed, seed, this.learned.order).map((t) => t.id), from);
    this.invalidatePlan();
    this.emit('queue');
  }

  /** Easter Egg: One More Time folgt in der Wiedergabeliste direkt auf Starships. */
  pairEggs(queue, minIndex) {
    return pairEasterEggs(queue, (id) => this.track(id), minIndex);
  }

  /** Neue, ebenfalls gut passende Reihenfolge (andere Variante). */
  reshuffle() {
    const before = this.queue.slice(this.editableFrom).join('|');
    for (let tries = 0; tries < 8; tries++) {
      this.reorderAI(1 + Math.floor(Math.random() * 1e9));
      if (this.queue.slice(this.editableFrom).join('|') !== before) return;
    }
  }

  move(from, to) {
    const min = this.editableFrom;
    if (from < min || to < min || from === to) return;
    const [id] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, id);
    this.invalidatePlan();
    this.emit('queue');
  }

  playNext(index) {
    this.move(index, this.editableFrom);
  }

  remove(index) {
    if (index < this.editableFrom) return;
    const [id] = this.queue.splice(index, 1);
    this.removed.push(id);
    this.invalidatePlan();
    this.emit('queue');
  }

  restore(id) {
    this.removed = this.removed.filter((x) => x !== id);
    this.queue.push(id);
    this.invalidatePlan();
    this.emit('queue');
  }

  setOverride(id, type) {
    if (type === 'auto') this.overrides.delete(id);
    else this.overrides.set(id, type);
    this.invalidatePlan();
    this.emit('queue');
  }

  setAutomix(on) {
    this.automix = on;
    if (!on) this.invalidatePlan();
    this.emit('plan');
  }

  /** Übergang sofort starten (nächster Takt) – wartet nicht auf das Outro. */
  mixNow() {
    if (this.plan?.committed) return;
    this.forceSoon = true;
    this.plan = null;
    this.emit('plan');
  }

  /** Zum Testen: ein paar Takte vor den geplanten Übergang springen (im Takt). */
  jumpToTransition(bars = 4) {
    const p = this.plan;
    const md = this.masterDeck;
    if (!p || p.committed || !md.track) return false;
    const a = md.track.analysis;
    const lead = Math.min(0, ...p.steps.map((s) => s.at));
    const target = p.outBar + lead - bars;
    this.jumpTo(this.master, barToSeconds(a, Math.max(0, target)));
    return true;
  }

  // ------------------------------------------------------------------ Bibliothek

  /** Tracks aus einem anderen Ordner bekannt machen (ohne die Queue zu ändern). */
  addTracks(list) {
    let added = false;
    for (const t of list) {
      if (!this.tracks.has(t.id)) {
        this.tracks.set(t.id, t);
        added = true;
      }
      const known = this.tracks.get(t.id);
      known.genreAuto = detectGenre(known.analysis);
      known.genreManual = this.resolveGenre?.(known) || null;
      known.genre = known.genreManual || known.genreAuto;
    }
    if (added) assignEnergy([...this.tracks.values()]);
    return list.map((t) => this.tracks.get(t.id));
  }

  /** Als Nächstes spielen (Hot-Queue). */
  queueNext(track) {
    const [t] = this.addTracks([track]);
    const i = this.queue.indexOf(t.id);
    if (i >= 0 && i < this.editableFrom) return;
    if (i >= 0) this.queue.splice(i, 1);
    this.removed = this.removed.filter((x) => x !== t.id);
    this.queue.splice(this.editableFrom, 0, t.id);
    this.invalidatePlan();
    this.emit('queue');
  }

  /** Hinten an die Queue anhängen. */
  queueAppend(track) {
    const [t] = this.addTracks([track]);
    if (this.queue.includes(t.id)) return;
    this.removed = this.removed.filter((x) => x !== t.id);
    this.queue.push(t.id);
    this.invalidatePlan();
    this.emit('queue');
  }

  /**
   * Nach dem aktuellen Track mit einer anderen Playlist weitermachen (KI-sortiert).
   * startTrack optional: dieser Track kommt als Nächstes.
   */
  switchPlaylist(list, startTrack = null) {
    const tracks = this.addTracks(list);
    const keep = this.queue.slice(0, this.editableFrom);
    const fixed = keep.map((id) => this.track(id));
    if (startTrack) {
      const [s] = this.addTracks([startTrack]);
      if (!keep.includes(s.id)) fixed.push(s);
    }
    const pool = tracks.filter((t) => !fixed.includes(t));
    this.queue = this.pairEggs(buildSetOrder([...fixed, ...pool], fixed).map((t) => t.id), fixed.length);
    this.removed = [];
    this.invalidatePlan();
    this.emit('queue');
  }

  /**
   * Track als Nächstes einmixen – nicht hektisch: der Planer sucht innerhalb der nächsten
   * ~32 Takte die beste Stelle (mit Teaser und vollem Übergang), statt sofort zu schneiden.
   */
  mixSoon(track, playlist = null) {
    if (playlist) this.switchPlaylist(playlist, track);
    else this.queueNext(track);
    if (!this.masterDeck.status.playing) {
      this.start();
      return;
    }
    if (this.plan?.committed) return; // läuft schon ein Übergang: danach geht es weiter
    this.soonWindow = true;
    this.plan = null;
    this.emit('plan');
  }

  /** Track aus der Queue sofort reinmixen. */
  mixInto(index) {
    if (index < this.editableFrom) return;
    this.playNext(index);
    if (this.masterDeck.status.playing) this.mixNow();
    else this.start();
  }

  /**
   * "Länger spielen": der laufende Song kommt gut an – den geplanten Übergang um 16 Takte nach
   * hinten schieben (auf das nächste passende Phrasenende). Mehrfach drücken schiebt weiter.
   * Liefert false, wenn der Song dafür nicht mehr lang genug ist oder der Übergang schon läuft.
   */
  extend(bars = 16) {
    if (this.plan?.committed) return false;
    const md = this.masterDeck;
    const a = md.track?.analysis;
    if (!a) return false;
    const nowBar = secondsToBar(a, md.realAt(this.engine.now) / this.engine.sr);
    const base = Math.max(this.plan?.outBar ?? nowBar, this.extendFrom ?? 0, nowBar);
    const lastBar = a.points?.lastBar ?? Math.floor(secondsToBar(a, a.duration));
    // so weit wie möglich, aber mit Platz für einen sauberen Übergang vor dem Songende
    const from = Math.min(base + bars, lastBar - 8);
    if (from < base + 2) return false;
    this.extendFrom = from;
    this.forceSoon = false;
    this.soonWindow = false;
    this.invalidatePlan();
    this.emit('plan');
    return true;
  }

  /** Freestyle: wildere Übergänge + kleine Tricks im laufenden Track. */
  setFreestyle(on) {
    this.freestyle = on;
    this.nextTrickAt = this.engine.now + 8;
    this.invalidatePlan();
    this.emit('plan');
  }

  setAutopilot(on) {
    this.autopilot = on;
    if (on) {
      this.automix = true;
      this.reorderAI();
      if (!this.masterDeck.status.playing) this.start();
    }
    this.emit('plan');
  }

  /** Autopilot läuft endlos: länger zurückliegende Tracks wandern wieder ans Ende. */
  recycleIfNeeded() {
    if (this.queue.length - (this.pos + 1) >= 2) return false;
    const old = this.queue.slice(0, Math.max(0, this.pos - 3));
    if (!old.length) return false;
    this.queue.splice(0, old.length);
    this.pos -= old.length;
    this.queue.push(...old);
    return true;
  }

  invalidatePlan() {
    if (this.plan && !this.plan.committed) {
      this.plan = null;
      this.emit('plan');
    }
  }

  /** Vorschau der Übergangstypen für die ganze Queue (für die Anzeige). */
  previewTransitions() {
    const out = new Map();
    const history = [...this.history];
    for (let i = Math.max(1, this.pos + 1); i < this.queue.length; i++) {
      const a = this.track(this.queue[i - 1]);
      const b = this.track(this.queue[i]);
      if (!a || !b) continue;
      if (this.plan && this.plan.inId === b.id && i === this.pos + 1) {
        out.set(b.id, this.plan);
        history.push(this.plan.type);
        continue;
      }
      const o = { out: a, inc: b, type: this.overrides.get(b.id) || 'auto', history, freestyle: this.freestyle, bias: this.learned.bias, tune: this.learned.tune, trackTune: this.learned.trackTune };
      const cues = loadCues();
      const p = planEasterEgg({ ...o, outCues: cues[a.id], inCues: cues[b.id] }) || planTransition(o);
      out.set(b.id, p);
      history.push(p.type);
    }
    return out;
  }

  // ------------------------------------------------------------------ Laden & Start

  async loadDeck(index, id) {
    const track = this.track(id);
    const job = (async () => {
      const bytes = await readFile(track.path);
      const audio = await this.engine.decode(bytes);
      await this.decks[index].load(track, audio);
      this.decks[index].setNow('fader', index === this.master ? 1 : 0);
    })();
    this.loading[index] = { id, job };
    this.emit('decks');
    try {
      await job;
    } finally {
      this.loading[index] = null;
      this.emit('decks');
    }
  }

  async start() {
    await this.engine.resume();
    const md = this.masterDeck;
    if (md.track && !md.status.playing) {
      md.playAt(this.engine.now + 0.05);
      return;
    }
    if (md.track || !this.queue.length) return;
    this.pos = Math.max(0, this.pos);
    await this.loadDeck(this.master, this.queue[this.pos]);
    this.masterDeck.setNow('fader', 1);
    this.masterDeck.playAt(this.engine.now + 0.1, 0);
    this.emit('queue');
  }

  // ------------------------------------------------------------------ Takt

  tick() {
    const now = this.engine.now;
    const md = this.masterDeck;
    const other = 1 - this.master;
    const od = this.decks[other];

    if (this.plan?.committed && now >= this.plan.tDone) this.finishPlan();

    // Master stoppt, anderes Deck läuft (manuell gemixt) -> Rollen tauschen
    if (!this.plan?.committed && !md.status.playing && od.status.playing && od.track) {
      this.master = other;
      const idx = this.queue.indexOf(od.track.id);
      if (idx >= 0) this.pos = idx;
      this.emit('queue');
      return;
    }

    // Trackende ohne Übergang
    if (md.track && md.status.playing && md.realAt(now) >= md.length) md.stopAt(now);

    if (!this.automix || !md.track || !md.status.playing) return;
    if (this.freestyle) this.maybeTrick(now);
    this.maybeTeaser(now);
    if (this.autopilot && !this.plan?.committed && this.recycleIfNeeded()) {
      this.reorderAI();
      return;
    }
    const nextId = this.queue[this.pos + 1];
    if (!nextId) return;

    if (od.track?.id !== nextId || this.loading[other]) {
      if (!this.plan?.committed && !this.loading[other] && !od.status.playing) {
        this.loadDeck(other, nextId).catch((err) => this.emit('error', `Laden fehlgeschlagen: ${err.message || err}`));
      }
      return;
    }

    // Nach einem Sprung warten, bis er wirklich passiert ist (sonst Planung mit alter Position)
    if (now < (this.holdPlanningUntil || 0)) return;

    // Passt ein noch nicht eingeplanter Plan noch zur tatsächlichen Position? Sonst neu planen.
    if (this.plan && !this.plan.committed && md.status.loopLen === 0 && now >= this.rampUntil) {
      const st = md.status;
      const t0 = st.time + (this.plan.realOut0 - st.real) / ((st.rate || 1) * this.engine.sr);
      if (Math.abs(t0 - this.plan.T0) > 0.05) {
        this.plan = null;
        this.emit('plan');
      }
    }

    if (!this.plan) {
      if (now < this.rampUntil && this.forceSoon && !this.rampFrozen) {
        // "Jetzt mixen" während der Tempo-Rückfahrt: aktuelles Tempo einfrieren
        md.cancel({ ratesAfter: now });
        md.rateAt(now + 0.02, md.status.rate, 0);
        this.rampUntil = now + 0.1; // kurz warten, bis der Status das feste Tempo meldet
        this.rampFrozen = true;
        return;
      }
      if (now < this.rampUntil || md.status.loopLen > 0 || od.status.playing) return;
      try {
        this.plan = this.makePlan();
      } catch (err) {
        this.emit('error', `Planung fehlgeschlagen: ${err.message || err}`);
        this.automix = false;
      }
      this.emit('plan');
      return;
    }

    if (!this.plan.committed && this.plan.firstStepTime - now < COMMIT_MARGIN) {
      if (this.plan.firstStepTime - now < 0.2) {
        // verpasst (z. B. manuell gespult) -> neu planen
        this.plan = null;
        return;
      }
      this.commit(this.plan);
    }
  }

  /**
   * Freestyle-Trick auf dem laufenden Track an der nächsten Phrasengrenze einplanen. Nie während
   * eines Übergangs, nie kurz davor, nie in einem Loop oder einer Tempo-Rampe.
   */
  maybeTrick(now) {
    if (now < this.nextTrickAt || this.plan?.committed || now < this.rampUntil) return;
    // Übergang wird gerade (neu) geplant, z. B. nach einem Sprung -> erst den Plan abwarten
    if (!this.plan && this.queue[this.pos + 1]) return;
    if (now < (this.holdPlanningUntil || 0)) return;
    const md = this.masterDeck;
    if (md.status.loopLen > 0) return;
    const a = md.track.analysis;
    const sr = this.engine.sr;
    const rate = md.status.rate || 1;
    const sec = md.realAt(now) / sr;
    const trick = planTrick(a, secondsToBar(a, sec), Math.random(), this.lastTrick, this.learned.trick?.weights);
    if (!trick) {
      this.nextTrickAt = now + 2;
      return;
    }
    const barSec = (4 * a.beatInterval) / rate;
    const T = (bar) => now + (barToSeconds(a, bar) - sec) / rate;
    // nicht zusammen mit dem Teaser des nächsten Tracks
    const tw = this.teaserWindow;
    if (tw && T(trick.bar) >= tw[0] && T(trick.bar) <= tw[1]) {
      this.nextTrickAt = now + 4;
      return;
    }
    // Abstand zum geplanten Übergang: mindestens 8 Takte
    if (this.plan && T(this.plan.outBar) - T(trick.bar) < 8 * barSec) {
      this.nextTrickAt = now + 4;
      return;
    }
    const cur = md.values();
    for (const s of trick.steps) {
      const t = T(trick.bar + s.at);
      if (s.param) {
        md.ramp(s.param, t, cur[s.param], t + (s.dur || 0) * barSec, s.to);
        cur[s.param] = s.to;
      } else if (s.action === 'loop') {
        md.segment(md.virtualAt(t), barToSeconds(a, trick.bar + s.anchor) * sr, s.bars * 4 * a.beatInterval * sr);
      } else if (s.action === 'unloop') {
        md.segment(md.virtualAt(t), barToSeconds(a, trick.bar + s.at) * sr, 0);
      }
    }
    this.lastTrick = trick.kind;
    // nächster Trick frühestens 16–32 Takte später
    this.nextTrickAt = T(trick.bar) + (16 + Math.floor(Math.random() * 5) * 4) * barSec;
    this.emit('trick', { ...trick, at: T(trick.bar) });
  }

  /**
   * Einmal pro Übergang: gegen Ende des laufenden Tracks, wo er Luft lässt, 2 Takte den Hook des
   * nächsten Tracks anspielen – im Takt, in der Tonart, ohne Bass, mit Echo-Ausklang.
   */
  maybeTeaser(now) {
    const plan = this.plan;
    if (!plan || plan.committed || plan.egg || !plan.beatmatch || this.teased === plan.inId) return;
    if (this.forceSoon || this.soonWindow || now < this.rampUntil || now < (this.holdPlanningUntil || 0)) return;
    const md = this.masterDeck;
    const inn = this.decks[plan.inDeck];
    if (md.status.loopLen > 0 || inn.status.playing || !inn.track || inn.track.id !== plan.inId) return;
    const a = md.track.analysis;
    const b = inn.track.analysis;
    const sr = this.engine.sr;
    const rate = md.status.rate || 1;
    const sec = md.realAt(now) / sr;
    this.teased = plan.inId; // nur einmal prüfen, auch wenn keine Stelle passt
    const shift = this.learned.trick?.teaserShift ?? 0;
    if (shift >= 1) return; // Teaser nach vielen 👎 aus
    const t = planTeaser(a, b, plan.outBar, secondsToBar(a, sec), 2, 0.6 + shift);
    if (!t) return;
    const T = (bar) => now + (barToSeconds(a, bar) - sec) / rate;
    const barSec = (4 * a.beatInterval) / rate;
    const t0 = T(t.bar);
    const t1 = t0 + t.bars * barSec;
    if (t0 - now < 1 || plan.firstStepTime - t1 < 4 * barSec) return; // zu knapp am Übergang
    inn.setKeyShift(plan.keyShift || 0);
    inn.rateAt(t0, plan.inRate, 0);
    inn.playAt(t0, barToSeconds(b, t.inFrom) * sr);
    inn.ramp('low', t0, KILL, t0, KILL);
    inn.ramp('filter', t0, 0.15, t0, 0.15);
    inn.ramp('fader', t0, 0, t0 + 0.25 * barSec, 0.7);
    inn.ramp('echo', t1 - 0.25 * barSec, 0, t1 - 0.2 * barSec, 0.4);
    inn.ramp('fader', t1 - 0.25 * barSec, 0.7, t1, 0);
    inn.stopAt(t1 + 0.05);
    // danach alles zurück, damit der eigentliche Übergang sauber startet
    inn.ramp('echo', t1 + barSec, 0.4, t1 + 1.5 * barSec, 0);
    inn.ramp('low', t1 + 0.1, KILL, t1 + 0.1, 0);
    inn.ramp('filter', t1 + 0.1, 0.15, t1 + 0.1, 0);
    this.teaserWindow = [t0 - 8 * barSec, t1 + 8 * barSec]; // drumherum Ruhe, kein Trick-Gewimmel
    this.emit('teaser', { ...t, at: t0 });
  }

  makePlan() {
    const sr = this.engine.sr;
    const now = this.engine.now;
    const md = this.masterDeck;
    const od = this.decks[1 - this.master];
    const out = md.track;
    const inc = od.track;
    const a = out.analysis;
    const st = md.status;
    const rate = st.rate || 1;
    const barTrackSec = 4 * a.beatInterval;
    const nowBar = secondsToBar(a, md.realAt(now) / sr);
    const leadBars = 2 + (LEAD_SECONDS * rate) / barTrackSec; // Platz für Schritte vor T0

    const instant = this.forceSoon;
    const soon = !instant && this.soonWindow;
    const opts = {
      out,
      inc,
      outRate: rate,
      type: this.overrides.get(inc.id) || 'auto',
      history: this.history,
      flavorHistory: this.flavorHistory || [],
      outKeyShift: md.keyShift || 0,
      earliestBar: instant ? nowBar + (INSTANT_LEAD * rate) / barTrackSec : soon ? nowBar + leadBars + 1 : this.extendFrom ?? null,
      latestBar: soon ? nowBar + leadBars + 32 : null,
      instant,
      freestyle: this.freestyle,
      keylock: od.keylock,
      bias: this.learned.bias,
      tune: this.learned.tune,
      trackTune: this.learned.trackTune,
    };
    // Easter Egg (fest eingebauter DJ-Klassiker für ein bestimmtes Song-Paar) geht vor
    const cues = loadCues();
    const egg = (o) => planEasterEgg({ ...o, outCues: cues[out.id], inCues: cues[inc.id] });
    let plan = egg({ ...opts, minBar: nowBar + 2 }) || planTransition(opts); // Egg hat keine Schritte vor T0
    if (!instant && !plan.egg && plan.outBar < nowBar + leadBars) plan = planTransition({ ...opts, earliestBar: Math.max(nowBar + leadBars, this.extendFrom ?? 0) });

    const barSec = (4 * 60) / plan.masterBpm;
    const realOut0 = barToSeconds(a, plan.outBar) * sr;
    const T0 = st.time + (realOut0 - st.real) / (rate * sr);
    const minAt = Math.min(0, ...plan.steps.map((s) => s.at));
    return {
      ...plan,
      T0,
      barSec,
      realOut0,
      vOut0: st.v + (realOut0 - st.real),
      outRate: rate,
      firstStepTime: T0 + minAt * barSec,
      tDone: T0 + plan.endBars * barSec + 0.3,
      outDeck: this.master,
      inDeck: 1 - this.master,
      outId: out.id,
      inId: inc.id,
      committed: false,
    };
  }

  commit(plan) {
    const sr = this.engine.sr;
    const out = this.decks[plan.outDeck];
    const inn = this.decks[plan.inDeck];
    const a = out.track.analysis;
    const b = inn.track.analysis;
    const T = (at) => plan.T0 + at * plan.barSec;
    const vals = { out: out.values(), in: { ...NEUTRAL, fader: inn.get('fader') } };
    const outBeatFrames = a.beatInterval * sr;

    out.setEchoTime((plan.echoBeats * 60) / plan.masterBpm);
    inn.cancel({ transport: true, ratesAfter: this.engine.now });
    inn.setKeyShift(plan.keyShift || 0);
    for (const name of PARAMS) inn.cancelFrom(name, this.engine.now);
    // noch eingeplante Freestyle-Tricks auf dem alten Track verwerfen – jetzt gilt der Übergang
    for (const name of PARAMS) out.cancelFrom(name, this.engine.now);

    for (const s of plan.steps) {
      const deck = s.deck === 'out' ? out : inn;
      const t = T(s.at);
      if (s.param) {
        const t1 = t + (s.dur || 0) * plan.barSec;
        deck.ramp(s.param, t, vals[s.deck][s.param], t1, s.to);
        vals[s.deck][s.param] = s.to;
        continue;
      }
      switch (s.action) {
        case 'play': {
          let real = barToSeconds(b, plan.inBar + (s.barOffset || 0)) * sr;
          let start = t;
          if (real < 0) {
            start += -real / (plan.inRate * sr);
            real = 0;
          }
          inn.rateAt(start, plan.inRate, 0);
          inn.playAt(start, real);
          break;
        }
        case 'stop':
          deck.stopAt(t);
          break;
        case 'loop': {
          const v = plan.vOut0 + s.at * plan.barSec * plan.outRate * sr;
          const real = plan.realOut0 + s.anchor * 4 * outBeatFrames;
          out.segment(v, real, s.bars * 4 * outBeatFrames);
          break;
        }
        case 'rate': {
          const dur = s.dur * plan.barSec;
          inn.rateAt(t, s.to, dur);
          plan.rampEnd = t + dur;
          break;
        }
      }
    }
    plan.committed = true;
    this.emit('plan');
  }

  /** Gelernte Vorlieben übernehmen (nach einer Bewertung) und neu planen. */
  setLearned(learned) {
    this.learned = learned;
    this.invalidatePlan();
  }

  finishPlan() {
    const p = this.plan;
    this.emit('transitionDone', {
      type: p.type, label: p.label, genres: p.genres, bars: p.bars, outBar: p.outBar, inBar: p.inBar,
      audit: p.audit ? { issues: p.audit.issues, penalty: +p.audit.penalty.toFixed(2) } : null,
      out: this.track(p.outId), inc: this.track(p.inId), outId: p.outId, inId: p.inId, freestyle: this.freestyle,
    });
    this.master = p.inDeck;
    this.lastPlan = p;
    this.pos = Math.max(this.pos + 1, this.queue.indexOf(p.inId));
    this.history.push(p.type);
    this.flavorHistory = [...(this.flavorHistory || []), ...(p.flavors ? [`in:${p.flavors.entry}`, `out:${p.flavors.exit}`] : [])].slice(-4);
    this.rampUntil = p.rampEnd || 0;
    this.rampFrozen = false;
    this.decks[p.outDeck].resetParams();
    this.decks[p.outDeck].setNow('fader', 0);
    this.plan = null;
    this.forceSoon = false;
    this.soonWindow = false;
    this.extendFrom = null;
    if (this.autopilot) {
      this.recycleIfNeeded();
      this.reorderAI();
    }
    this.emit('queue');
    this.emit('plan');
  }

  /** Bricht einen laufenden/eingeplanten Übergang ab (z. B. bei Pause). */
  abortPlan() {
    const p = this.plan;
    if (!p) return;
    this.plan = null;
    if (p.committed) {
      const now = this.engine.now;
      const out = this.decks[p.outDeck];
      const inn = this.decks[p.inDeck];
      for (const name of PARAMS) {
        out.setNow(name, NEUTRAL[name]);
        inn.cancelFrom(name, now);
      }
      inn.cancel({ transport: true, ratesAfter: now });
      inn.stopAt(now);
      out.cancel({ transport: true, ratesAfter: now, segmentsAfter: out.virtualAt(now) + 4096 });
      this.exitLoop(p.outDeck);
    }
    this.emit('plan');
  }

  // ------------------------------------------------------------------ Manuelle Bedienung

  togglePlay(i) {
    const d = this.decks[i];
    if (!d.track) {
      if (i === this.master) this.start();
      return;
    }
    this.engine.resume();
    if (d.status.playing) {
      if (this.plan && (this.plan.outDeck === i || this.plan.inDeck === i)) this.abortPlan();
      d.stopAt(this.engine.now);
    } else {
      if (i !== this.master && !this.masterDeck.status.playing) this.master = i;
      d.setNow('fader', 1);
      d.playAt(this.engine.now + 0.03);
    }
    this.emit('decks');
  }

  cue(i) {
    const d = this.decks[i];
    if (!d.track) return;
    if (this.plan && (this.plan.outDeck === i || this.plan.inDeck === i)) this.abortPlan();
    const a = d.track.analysis;
    const real = Math.max(0, barToSeconds(a, a.points.startBar)) * this.engine.sr;
    if (d.status.playing) {
      d.stopAt(this.engine.now);
      setTimeout(() => d.seek(real), 60);
    } else {
      d.seek(real);
    }
  }

  /** Springt im Track (Klick in die Übersicht), quantisiert auf den nächsten Takt. */
  seekTo(i, seconds) {
    const d = this.decks[i];
    if (!d.track) return;
    if (this.plan && (this.plan.outDeck === i || this.plan.inDeck === i)) this.abortPlan();
    const a = d.track.analysis;
    const bar = Math.round(secondsToBar(a, seconds));
    d.seek(Math.max(0, barToSeconds(a, bar)) * this.engine.sr);
    if (i === this.master) this.plan = null;
  }

  loop(i, bars) {
    const d = this.decks[i];
    const st = d.status;
    if (!d.track || !st.playing) return;
    const a = d.track.analysis;
    const sr = this.engine.sr;
    const beatF = a.beatInterval * sr;
    const t = this.engine.now + 0.06;
    const vNow = d.virtualAt(t);
    const realNow = d.realAt(t);
    let vB;
    let realB;
    if (st.loopLen > 0) {
      const phase = (((realNow - st.loopStart) % st.loopLen) + st.loopLen) % st.loopLen;
      vB = vNow + (st.loopLen - phase);
      realB = st.loopStart;
    } else {
      realB = beatToSeconds(a, Math.ceil(secondsToBeat(a, realNow / sr) - 1e-6)) * sr;
      vB = vNow + (realB - realNow);
    }
    d.segment(vB, realB, bars * 4 * beatF);
    if (i === this.master) this.invalidatePlan();
  }

  exitLoop(i) {
    const d = this.decks[i];
    const st = d.status;
    if (!st.loopLen) return;
    const t = this.engine.now + 0.06;
    const realNow = d.realAt(t);
    const phase = (((realNow - st.loopStart) % st.loopLen) + st.loopLen) % st.loopLen;
    d.segment(d.virtualAt(t) + (st.loopLen - phase), st.loopStart + st.loopLen, 0);
  }

  /** Tempo + Takt-Phase an das andere laufende Deck angleichen. */
  sync(i) {
    const d = this.decks[i];
    const o = this.decks[1 - i];
    if (!d.track || !o.track || !o.status.playing) return;
    const a = d.track.analysis;
    const b = o.track.analysis;
    const sr = this.engine.sr;
    const oBpm = b.bpm * (o.status.rate || 1);
    const rel = tempoRelation(oBpm, a.bpm);
    const rate = (rel.m * oBpm) / a.bpm;
    const now = this.engine.now;
    d.rateAt(now, rate, 0);
    if (!d.status.playing) return;

    const t = now + 0.08;
    const barPhase = (x, secs) => {
      const beats = secondsToBeat(x, secs) - x.downbeat;
      return (((beats / 4) % 1) + 1) % 1;
    };
    const po = barPhase(b, o.realAt(t) / sr);
    const pi = barPhase(a, d.realAt(t) / sr);
    let delta = po * rel.m - pi;
    delta -= Math.round(delta);
    const jump = delta * 4 * a.beatInterval * sr;
    if (Math.abs(jump) > sr * 0.002) d.segment(Math.round(d.virtualAt(t)), d.realAt(t) + jump, 0);
  }

  /** Neue Analyse (z. B. nach Grid-Korrektur) übernehmen – auch für geladene Decks. */
  updateAnalysis(id, analysis) {
    const t = this.track(id);
    if (!t) return;
    t.analysis = analysis;
    if (this.plan && !this.plan.committed && (this.plan.inId === id || this.plan.outId === id)) this.plan = null;
    this.emit('queue');
    this.emit('plan');
  }

  // ------------------------------------------------------------------ Hot Cues

  /** 8 Cue-Slots pro Track: automatisch aus der Analyse (Start, Drops, Break, Outro) + eigene. */
  cuesFor(track) {
    if (!track) return Array(8).fill(null);
    const a = track.analysis;
    const auto = [];
    const add = (label, bar, kind) => {
      if (bar === null || bar === undefined) return;
      const sec = barToSeconds(a, bar);
      if (sec < 0 || sec >= a.duration || auto.some((c) => Math.abs(c.sec - sec) < 0.5)) return;
      auto.push({ label, sec, kind });
    };
    add('Start', a.points.startBar, 'start');
    (a.points.drops?.length ? a.points.drops : [a.points.dropBar]).slice(0, 3)
      .forEach((d, n) => add(n ? `Drop ${n + 1}` : 'Drop', d, 'drop'));
    const brk = a.phrases.find((ph) => (ph.label === 'break' || ph.label === 'build') && ph.bar > a.points.dropBar);
    if (brk) add(brk.label === 'build' ? 'Build' : 'Break', brk.bar, 'break');
    add('Outro', a.points.outroBar, 'outro');
    auto.sort((x, y) => x.sec - y.sec);
    const slots = Array(8).fill(null);
    auto.slice(0, 8).forEach((c, n) => (slots[n] = c));
    const user = loadCues()[track.id] || {};
    for (const [slot, sec] of Object.entries(user)) {
      slots[+slot] = sec === null ? null : { label: `Cue ${+slot + 1}`, sec, kind: 'user' };
    }
    return slots;
  }

  /** Pad gedrückt: gesetzter Cue -> Sprung (im Takt), leerer Slot -> Cue auf aktuellen Beat setzen. */
  triggerCue(i, slot) {
    const d = this.decks[i];
    if (!d.track) return;
    const cue = this.cuesFor(d.track)[slot];
    if (cue) {
      this.jumpTo(i, cue.sec);
      return;
    }
    const a = d.track.analysis;
    const secNow = d.realAt(this.engine.now) / this.engine.sr;
    const beat = Math.round(secondsToBeat(a, secNow));
    const all = loadCues();
    all[d.track.id] = { ...(all[d.track.id] || {}), [slot]: Math.max(0, beatToSeconds(a, beat)) };
    saveCues(all);
    this.emit('cues');
  }

  deleteCue(i, slot) {
    const d = this.decks[i];
    if (!d.track) return;
    const all = loadCues();
    all[d.track.id] = { ...(all[d.track.id] || {}), [slot]: null };
    saveCues(all);
    this.emit('cues');
  }

  /** Sprung an eine Stelle – bei laufendem Deck auf dem nächsten Beat, damit der Takt bleibt. */
  jumpTo(i, sec) {
    const d = this.decks[i];
    if (!d.track) return;
    if (this.plan && (this.plan.outDeck === i || this.plan.inDeck === i)) {
      if (this.plan.committed) this.abortPlan();
      else this.invalidatePlan();
    }
    const sr = this.engine.sr;
    const target = Math.max(0, sec) * sr;
    if (!d.status.playing) {
      d.seek(target);
      return;
    }
    const a = d.track.analysis;
    const t = this.engine.now + 0.06;
    const realNow = d.realAt(t);
    const realB = beatToSeconds(a, Math.ceil(secondsToBeat(a, realNow / sr) - 1e-6)) * sr;
    d.segment(d.virtualAt(t) + (realB - realNow), target, 0);
    if (i === this.master) {
      // erst neu planen, wenn der Sprung (auf dem nächsten Beat) passiert ist und gemeldet wurde
      this.holdPlanningUntil = t + (realB - realNow) / ((d.status.rate || 1) * sr) + 0.12;
      this.plan = null;
      this.emit('plan');
    }
  }

  setParam(i, name, value) {
    this.decks[i].setNow(name, value);
  }

  setKeylock(i, on) {
    this.decks[i].setKeylock(on);
    this.emit('decks');
  }
}
