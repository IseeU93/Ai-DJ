// Conductor: Queue + Automix. Plant den nächsten Übergang, lädt den nächsten Track vor und
// setzt den Plan kurz vor dem Einsatz sample-genau in Deck-Befehle und Parameter-Automation um.
import { planTransition, barToSeconds, secondsToBar } from './planner.js';
import { assignEnergy, buildSetOrder, tempoRelation } from './order.js';
import { NEUTRAL, PARAMS } from '../audio/engine.js';
import { readFile } from '../lib/tauri.js';
import { detectGenre } from './genre.js';

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
    this.queue = buildSetOrder([...fixed, ...rest], fixed).map((t) => t.id);
    this.removed = [];
    this.pos = playing.length - 1;
    this.invalidatePlan();
    this.emit('queue');
  }

  /** Erste Position, die noch verschoben werden darf. */
  get editableFrom() {
    return this.pos + 1 + (this.plan?.committed ? 1 : 0);
  }

  reorderAI(seed = 0) {
    const from = this.editableFrom;
    const fixed = this.queue.slice(0, from).map((id) => this.track(id));
    const all = this.queue.map((id) => this.track(id));
    this.queue = buildSetOrder(all, fixed, seed).map((t) => t.id);
    this.invalidatePlan();
    this.emit('queue');
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

  /** Track aus der Queue sofort reinmixen. */
  mixInto(index) {
    if (index < this.editableFrom) return;
    this.playNext(index);
    if (this.masterDeck.status.playing) this.mixNow();
    else this.start();
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
      const p = planTransition({ out: a, inc: b, type: this.overrides.get(b.id) || 'auto', history });
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
    const opts = {
      out,
      inc,
      outRate: rate,
      type: this.overrides.get(inc.id) || 'auto',
      history: this.history,
      flavorHistory: this.flavorHistory || [],
      outKeyShift: md.keyShift || 0,
      earliestBar: instant ? nowBar + (INSTANT_LEAD * rate) / barTrackSec : null,
      instant,
    };
    let plan = planTransition(opts);
    if (!instant && plan.outBar < nowBar + leadBars) plan = planTransition({ ...opts, earliestBar: nowBar + leadBars });

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
          let real = barToSeconds(b, plan.inBar) * sr;
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

  finishPlan() {
    const p = this.plan;
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
      const firstF = a.firstBeat * sr;
      const k = Math.ceil((realNow - firstF) / beatF);
      realB = firstF + k * beatF;
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
      const beats = (secs - x.firstBeat) / x.beatInterval - x.downbeat;
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
    const beat = Math.round((secNow - a.firstBeat) / a.beatInterval);
    const all = loadCues();
    all[d.track.id] = { ...(all[d.track.id] || {}), [slot]: Math.max(0, a.firstBeat + beat * a.beatInterval) };
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
    const beatF = a.beatInterval * sr;
    const firstF = a.firstBeat * sr;
    const realB = firstF + Math.ceil((realNow - firstF) / beatF) * beatF;
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
