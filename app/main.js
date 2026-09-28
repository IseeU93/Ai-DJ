import { Engine } from './audio/engine.js';
import { Conductor } from './mix/conductor.js';
import { AnalysisService } from './analysis/service.js';
import { TRANSITIONS, KILL, barToSeconds, beatToSeconds, secondsToBeat } from './mix/planner.js';
import { parseCamelot, shiftCamelot, orderFeatures } from './mix/order.js';
import { Knob, Slider } from './ui/controls.js';
import { DeckWaveform, drawOverview } from './ui/waveform.js';
import { drawTimeline } from './ui/timeline.js';
import { pickFolder, scanFolder } from './lib/tauri.js';
import { loadSettings, saveSettings, gridOverride, setGridOverride, genreOverrides, setGenreOverride } from './lib/store.js';
import { GENRES } from './mix/genre.js';
import { REASONS, ORDER_REASONS, addFeedback, learn, describeLearned, loadFeedback } from './mix/feedback.js';
import { TRICKS } from './mix/freestyle.js';
import { initCompanion } from './lib/companion.js';
import { createWebGenre } from './lib/webgenre.js';
import { VocalScan } from './lyrics/vocalscan.js';
import { dedupeTracks } from './mix/dedupe.js';
import { versionPriority } from './mix/eastereggs.js';

const $ = (sel, root = document) => root.querySelector(sel);
const COLORS = ['#d6a03c', '#5b9fc6'];
const NAMES = ['A', 'B'];
const LOOPS = [
  [0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16'],
];
const ICON_PLAY = '<svg viewBox="0 0 12 12"><path d="M2 1 L11 6 L2 11 Z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';

const engine = new Engine();
const analysis = new AnalysisService();
let conductor;
const decksUi = [];
const stripsUi = [];
let loadingFolder = false;

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '–:––';
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function keyChip(el, camelot, shift = 0) {
  if (shift) camelot = shiftCamelot(camelot, shift);
  const k = parseCamelot(camelot);
  el.textContent = camelot ? `${camelot}${shift ? ` ${shift > 0 ? '+' : '−'}${Math.abs(shift)}` : ''}` : '–';
  el.title = shift ? `Key-Sync: um ${shift > 0 ? '+' : ''}${shift} Halbton verschoben` : '';
  el.style.setProperty('--h', k ? (k.n - 1) * 30 : 0);
  el.classList.toggle('minor', k?.letter === 'A');
  el.classList.toggle('none', !k);
}

let toastTimer;
function toast(msg) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

/** Kleine Rückfrage (Ja/Abbrechen) im App-Stil – liefert true bei Ja. */
function ask(msg, okLabel = 'Ja') {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'ask';
    box.innerHTML = `<div class="ask-card"><p></p><div class="ask-btns"><button class="btn" data-no>Abbrechen</button><button class="btn primary" data-yes></button></div></div>`;
    $('p', box).textContent = msg;
    $('[data-yes]', box).textContent = okLabel;
    const done = (v) => {
      box.remove();
      document.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    $('[data-yes]', box).onclick = () => done(true);
    $('[data-no]', box).onclick = () => done(false);
    box.onclick = (e) => e.target === box && done(false);
    document.addEventListener('keydown', key, true);
    document.body.appendChild(box);
    $('[data-yes]', box).focus();
  });
}

/** Warnung, wenn ein Track in dieser Session schon lief. true = trotzdem spielen. */
async function okToReplay(t) {
  if (!conductor.wasPlayed(t.id)) return true;
  return ask(`„${t.title}“ wurde heute schon gespielt. Trotzdem nochmal spielen?`, 'Nochmal spielen');
}

// ------------------------------------------------------------------ Decks

function buildDeck(i) {
  const root = $(`.deck[data-deck="${i}"]`);
  root.innerHTML = `
    <div class="deck-head">
      <span class="deck-id">${NAMES[i]}</span>
      <div class="deck-title"><div class="t">Leer</div><div class="a deck-state"></div></div>
      <span class="key">–</span>
      <button class="btn small tap" title="Tempo tappen: mind. 4× im Takt klicken (oder Taste T/Z für Deck A/B). Korrigiert das Beatgrid dieses Tracks.">Tap</button>
      <div class="stat"><b class="bpm">–</b><small class="rate">&nbsp;</small></div>
      <div class="stat" style="min-width:64px"><b class="remain">–:––</b><small class="elapsed">&nbsp;</small></div>
    </div>
    <canvas class="wave"></canvas>
    <canvas class="overview" title="Klicken zum Springen (auf Takt gerundet)"></canvas>
    <div class="deck-controls">
      <button class="btn transport play" title="Play / Pause">${ICON_PLAY}</button>
      <button class="btn cue" title="Zurück zum ersten Takt">Cue</button>
      <button class="btn sync" title="Tempo und Takt an das andere Deck angleichen">Sync</button>
      <button class="btn toggle keylock" title="Tonhöhe bei Tempoänderung halten (Standard aus: Tempo-Anpassung klingt wie am Plattenspieler; an = Key-Sync möglich)">Keylock</button>
      <span class="sep"></span>
      <span class="lbl">Loop</span>
      ${LOOPS.map(([b, l]) => `<button class="btn loopbtn" data-bars="${b}" title="${b} Takt(e)">${l}</button>`).join('')}
      <button class="btn loopbtn exit" title="Loop verlassen">Exit</button>
    </div>
    <div class="pads" title="Hot Cues: Klick springt im Takt · leeres Pad setzt einen Cue · Rechtsklick löscht"></div>
    <div class="gridtools">
      <span class="lbl">Beatgrid</span>
      <span class="gridconf"></span>
      <button class="btn small" data-grid="left" title="Grid 5 ms früher">◀</button>
      <button class="btn small" data-grid="right" title="Grid 5 ms später">▶</button>
      <button class="btn small" data-grid="one" title="Aktueller Beat ist die „1“ (Taktanfang)">1 hier</button>
      <button class="btn small" data-grid="half" title="Halbes Tempo">÷2</button>
      <button class="btn small" data-grid="double" title="Doppeltes Tempo">×2</button>
      <button class="btn small" data-grid="reset" title="Automatisches Grid wiederherstellen">Auto</button>
    </div>`;
  const ui = {
    root,
    title: $('.t', root),
    artist: $('.a', root),
    key: $('.key', root),
    bpm: $('.bpm', root),
    rate: $('.rate', root),
    remain: $('.remain', root),
    elapsed: $('.elapsed', root),
    play: $('.play', root),
    keylock: $('.keylock', root),
    loopBtns: [...root.querySelectorAll('.loopbtn[data-bars]')],
    wave: new DeckWaveform($('.wave', root), COLORS[i]),
    overview: $('.overview', root),
    pads: $('.pads', root),
    gridconf: $('.gridconf', root),
    lastTrack: undefined,
  };
  root.querySelectorAll('[data-grid]').forEach((btn) => (btn.onclick = () => editGrid(i, btn.dataset.grid)));
  $('.tap', root).onclick = () => tapTempo(i);
  for (let slot = 0; slot < 8; slot++) {
    const pad = document.createElement('button');
    pad.className = 'pad free';
    pad.onclick = () => conductor.triggerCue(i, slot);
    pad.oncontextmenu = (e) => {
      e.preventDefault();
      conductor.deleteCue(i, slot);
    };
    ui.pads.appendChild(pad);
  }
  ui.play.onclick = () => conductor.togglePlay(i);
  $('.cue', root).onclick = () => conductor.cue(i);
  $('.sync', root).onclick = () => conductor.sync(i);
  ui.keylock.onclick = () => conductor.setKeylock(i, !engine.decks[i].keylock);
  ui.loopBtns.forEach((b) => (b.onclick = () => conductor.loop(i, +b.dataset.bars)));
  $('.exit', root).onclick = () => conductor.exitLoop(i);
  ui.overview.addEventListener('click', (e) => {
    const d = engine.decks[i];
    if (!d.track) return;
    const r = ui.overview.getBoundingClientRect();
    conductor.seekTo(i, ((e.clientX - r.left) / r.width) * d.track.analysis.duration);
  });
  decksUi[i] = ui;
}

function buildStrip(i) {
  const root = $(`.strip[data-deck="${i}"]`);
  root.innerHTML = `<div class="strip-head">${NAMES[i]}</div>`;
  const eq = (label, param) =>
    new Knob({
      label, min: KILL, max: 6, center: 0, value: 0, killAt: KILL + 1,
      format: (v) => (v <= KILL + 1 ? 'Kill' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`),
      onInput: (v) => conductor.setParam(i, param, v),
    });
  const knobs = {
    high: eq('HIGH', 'high'),
    mid: eq('MID', 'mid'),
    low: eq('LOW', 'low'),
    filter: new Knob({
      label: 'FILTER', min: -1, max: 1, center: 0, value: 0,
      format: (v) => (Math.abs(v) < 0.02 ? 'aus' : v < 0 ? `Tiefpass ${Math.round(-v * 100)}%` : `Hochpass ${Math.round(v * 100)}%`),
      onInput: (v) => conductor.setParam(i, 'filter', v),
    }),
  };
  const eqGrid = document.createElement('div');
  eqGrid.className = 'eq';
  for (const k of Object.values(knobs)) eqGrid.appendChild(k.el);
  root.appendChild(eqGrid);

  const fx = document.createElement('div');
  fx.className = 'fx';
  fx.innerHTML = `<button class="btn vox" title="Gesang absenken (Stereo-Mitte im Stimmbereich)">VOX</button>
                  <button class="btn echo" title="Echo (1 Beat)">ECHO</button>`;
  root.appendChild(fx);
  const vox = $('.vox', fx);
  const echo = $('.echo', fx);
  vox.onclick = () => conductor.setParam(i, 'vocal', engine.decks[i].get('vocal') > 0.5 ? 0 : 1);
  echo.onclick = () => {
    const d = engine.decks[i];
    if (d.track) d.setEchoTime(60 / (d.track.analysis.bpm * (d.status.rate || 1)));
    conductor.setParam(i, 'echo', d.get('echo') > 0.05 ? 0 : 0.8);
  };

  const row = document.createElement('div');
  row.className = 'fader-row';
  row.innerHTML = '<div class="meter"><i></i></div><div class="slider v"></div>';
  root.appendChild(row);
  const fader = new Slider($('.slider', row), { value: 1, onInput: (v) => conductor.setParam(i, 'fader', v) });
  stripsUi[i] = { knobs, vox, echo, fader, meter: $('.meter i', row) };
}

// ------------------------------------------------------------------ Laufende Anzeige

function planMarks(i) {
  const p = conductor.plan;
  const d = engine.decks[i];
  if (!p || !d.track) return null;
  const a = d.track.analysis;
  if (p.outDeck === i && d.track.id === p.outId) {
    const s = barToSeconds(a, p.outBar);
    return { mixStart: s, mixEnd: s + p.bars * 4 * a.beatInterval, label: p.label };
  }
  if (p.inDeck === i && d.track.id === p.inId) {
    const s = barToSeconds(a, p.inBar);
    return { mixStart: s, mixEnd: s + p.bars * p.m * 4 * a.beatInterval, label: 'Einstieg' };
  }
  return null;
}

/** Beatgrid von Hand korrigieren und den Track mit der Korrektur neu analysieren. */
async function editGrid(i, action, value = null) {
  const d = engine.decks[i];
  const t = d.track;
  if (!t) return;
  const a = t.analysis;
  const ov = { ...(gridOverride(t.path) || {}) };
  if (action === 'left') ov.shiftSec = (ov.shiftSec || 0) - 0.005;
  else if (action === 'right') ov.shiftSec = (ov.shiftSec || 0) + 0.005;
  else if (action === 'double') ov.bpm > 0 ? (ov.bpm *= 2) : (ov.bpmFactor = (ov.bpmFactor || 1) * 2);
  else if (action === 'half') ov.bpm > 0 ? (ov.bpm /= 2) : (ov.bpmFactor = (ov.bpmFactor || 1) / 2);
  else if (action === 'tap') {
    ov.bpm = value;
    delete ov.bpmFactor;
  }
  else if (action === 'one') {
    const sec = d.realAt(engine.now - (engine.ctx.outputLatency || 0)) / engine.sr;
    ov.downbeatSec = beatToSeconds(a, Math.round(secondsToBeat(a, sec)));
  }
  const next = action === 'reset' ? null : ov;
  setGridOverride(t.path, next);
  toast('Beatgrid wird neu berechnet …');
  try {
    const fresh = await analysis.analyzeOne(t, next);
    conductor.updateAnalysis(t.id, fresh.analysis);
    toast(`Beatgrid aktualisiert: ${fresh.analysis.bpm.toFixed(2)} BPM`);
  } catch (err) {
    toast(`Neuberechnung fehlgeschlagen: ${err.message || err}`);
  }
}

// Tap-Tempo pro Deck: Abstände der letzten Klicks mitteln, nach kurzer Pause übernehmen
const taps = [[], []];
const tapTimers = [0, 0];
function tapTempo(i) {
  const d = engine.decks[i];
  if (!d.track) return;
  const now = performance.now();
  const list = taps[i];
  if (list.length && now - list[list.length - 1] > 2000) list.length = 0;
  list.push(now);
  if (list.length > 16) list.shift();
  clearTimeout(tapTimers[i]);
  if (list.length < 4) {
    tapTimers[i] = setTimeout(() => {
      list.length = 0;
      $('.tap', decksUi[i].root).textContent = 'Tap';
    }, 2000);
    $('.tap', decksUi[i].root).textContent = `${list.length}/4`;
    return;
  }
  const gaps = list.slice(1).map((t, k) => t - list[k]).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  const heard = 60000 / gap; // so schnell wie es gerade klingt
  const bpm = heard / (d.status.rate || 1); // Tempo des Tracks selbst
  $('.tap', decksUi[i].root).textContent = heard.toFixed(1);
  tapTimers[i] = setTimeout(() => {
    list.length = 0;
    $('.tap', decksUi[i].root).textContent = 'Tap';
    if (bpm >= 40 && bpm <= 320) editGrid(i, 'tap', bpm);
  }, 1500);
}

function renderPads(i) {
  const ui = decksUi[i];
  const track = engine.decks[i].track;
  const cues = conductor.cuesFor(track);
  [...ui.pads.children].forEach((pad, slot) => {
    const c = cues[slot];
    pad.className = `pad ${c ? c.kind : 'free'}`;
    pad.innerHTML = `<b>${slot + 1}</b>`;
    pad.append(c ? c.label : track ? 'setzen' : '');
    pad.title = c ? `${c.label} · ${fmtTime(c.sec)} – Klick springt (im Takt), Rechtsklick löscht` : 'Leeres Pad: Klick setzt einen Cue auf den aktuellen Beat';
    pad.disabled = !track;
  });
}

function updateDeck(i, now) {
  const d = engine.decks[i];
  const ui = decksUi[i];
  const st = d.status;
  const track = d.track;
  const sr = engine.sr;

  if (ui.lastTrack !== track || ui.lastShift !== (d.keyShift || 0)) {
    ui.lastTrack = track;
    ui.lastShift = d.keyShift || 0;
    ui.title.textContent = track ? track.title : 'Leer';
    keyChip(ui.key, track?.analysis.key.camelot, ui.lastShift);
    renderPads(i);
    ui.gridAnalysis = null;
  }
  if (track && ui.gridAnalysis !== track.analysis) {
    ui.gridAnalysis = track.analysis;
    const c = track.analysis.gridConfidence ?? 1;
    ui.gridconf.textContent = `${Math.round(c * 100)} %${track.analysis.gridOverride ? ' · manuell' : ''}`;
    ui.gridconf.className = `gridconf ${c < 0.5 ? 'warn' : ''}`;
    ui.gridconf.title = c < 0.5 ? 'Tempo schwankt oder Beats sind unklar – Übergänge werden kurz gehalten. Grid ggf. von Hand korrigieren.' : 'Zuverlässigkeit des Beatgrids';
    renderPads(i);
  }
  const loading = conductor.loading[i];
  ui.artist.textContent = loading
    ? `Lädt ${conductor.track(loading.id)?.title ?? ''} …`
    : track
      ? track.artist || ' '
      : 'Wartet auf Queue';
  ui.root.classList.toggle('is-master', i === conductor.master && !!track);
  ui.root.classList.toggle('playing', st.playing);
  ui.play.innerHTML = st.playing ? ICON_PAUSE : ICON_PLAY;
  ui.keylock.classList.toggle('on', d.keylock);

  const pos = track ? d.realAt(now) / sr : 0;
  if (track) {
    const a = track.analysis;
    const rate = st.rate || 1;
    ui.bpm.textContent = (a.bpm * rate).toFixed(2);
    const pct = (rate - 1) * 100;
    ui.rate.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %`;
    ui.remain.textContent = `-${fmtTime((a.duration - pos) / rate)}`;
    ui.elapsed.textContent = fmtTime(pos);
  } else {
    ui.bpm.textContent = '–';
    ui.rate.innerHTML = '&nbsp;';
    ui.remain.textContent = '–:––';
    ui.elapsed.innerHTML = '&nbsp;';
  }

  const loopLenBars = track && st.loopLen ? st.loopLen / (4 * track.analysis.beatInterval * sr) : 0;
  ui.loopBtns.forEach((b) => b.classList.toggle('active', loopLenBars > 0 && Math.abs(+b.dataset.bars - loopLenBars) < 0.01));

  const marks = planMarks(i);
  const loop = st.loopLen ? { start: st.loopStart / sr, len: st.loopLen / sr } : null;
  ui.wave.draw(track, pos, marks, loop);
  drawOverview(ui.overview, track, pos, COLORS[i], marks);

  const s = stripsUi[i];
  for (const [name, k] of Object.entries(s.knobs)) k.set(d.get(name));
  s.fader.set(d.get('fader'));
  s.vox.classList.toggle('on', d.get('vocal') > 0.5);
  s.echo.classList.toggle('on', d.get('echo') > 0.05);
  const lvl = d.level();
  s.meter.style.height = `${Math.min(100, Math.max(0, (20 * Math.log10(lvl + 1e-6) + 48) / 48) * 100)}%`;
}

function updateTransition(now) {
  const p = conductor.plan;
  const count = $('#tr-count');
  const mixNow = $('#btn-mixnow');
  const nextId = nextQueueId();
  const typeSel = $('#tr-type');
  typeSel.disabled = !nextId || !!p?.committed;
  mixNow.disabled = !nextId || !!p?.committed || !engine.decks[conductor.master].status.playing;
  $('#btn-jump').disabled = !p || !!p.committed;
  const waitingLoad = conductor.forceSoon && !p && conductor.loading.some(Boolean);
  mixNow.textContent = waitingLoad ? 'Lädt …' : conductor.forceSoon && !p?.committed ? 'Startet …' : 'Jetzt mixen';

  let shown = p;
  let progress = null;
  if (p) {
    const bars = (now - p.T0) / p.barSec;
    if (p.committed && bars >= Math.min(0, ...p.steps.map((s) => s.at)) - 0.001) {
      progress = bars;
      count.textContent = bars < 0 ? `in ${(-bars * p.barSec).toFixed(1)} s` : `Takt ${Math.min(p.bars, Math.floor(bars) + 1)}/${p.bars}`;
    } else {
      count.textContent = `in ${fmtTime(p.T0 - now)}`;
    }
  } else {
    count.textContent = conductor.automix ? '' : 'Automix aus';
    shown = previewCache.get(nextId) || null;
  }
  const out = p ? p.outDeck : conductor.master;
  const inn = 1 - out;
  drawTimeline($('#tr-canvas'), shown, progress, {
    out: COLORS[out], in: COLORS[inn], outName: NAMES[out], inName: NAMES[inn],
  });
}

function frame() {
  const now = engine.now - (engine.ctx.outputLatency || 0);
  updateDeck(0, now);
  updateDeck(1, now);
  updateTransition(engine.now);
  const md = engine.decks[conductor.master];
  const start = $('#btn-start');
  start.textContent = md.status.playing ? 'Pause' : md.track ? 'Weiter' : 'Start';
  start.disabled = !conductor.queue.length;
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ Übergangs-Panel

let previewCache = new Map();

/** Track, in den als Nächstes übergeblendet wird (vor dem Start: der zweite in der Queue). */
function nextQueueId() {
  return conductor.queue[Math.max(conductor.pos, 0) + 1];
}

function renderPlanInfo() {
  const p = conductor.plan;
  const nextId = nextQueueId();
  const next = conductor.track(nextId);
  const shown = p || previewCache.get(nextId);
  $('#tr-title').textContent = next ? `Nächster Übergang → ${next.title}` : 'Nächster Übergang';
  $('#tr-name').textContent = shown ? shown.label + (p ? '' : ' (Vorschau)') : '–';
  const notes = shown?.notes || [];
  $('#tr-notes').textContent = notes.join(' · ');
  $('#tr-notes').title = notes.join('\n');
  $('#tr-reason').textContent = shown ? shown.reason : next ? '' : 'Keine weiteren Tracks in der Queue';
  const sel = $('#tr-type');
  sel.value = (nextId && conductor.overrides.get(nextId)) || 'auto';
}

// ------------------------------------------------------------------ Queue

function drawStructure(canvas, a) {
  const w = (canvas.width = 240);
  const h = (canvas.height = 28);
  const c = canvas.getContext('2d');
  const dur = a.duration;
  for (const ph of a.phrases) {
    const x1 = (barToSeconds(a, ph.bar) / dur) * w;
    const x2 = (barToSeconds(a, ph.bar + ph.bars) / dur) * w;
    c.fillStyle = ph.label === 'main' ? '#5c5e64' : ph.label === 'break' ? '#34463c' : ph.label === 'build' ? '#4a4536' : '#34363c';
    c.fillRect(x1, 10, Math.max(1, x2 - x1 - 1), 12);
  }
  a.vocals.forEach((v, bar) => {
    if (v < 0.35) return;
    const x1 = (barToSeconds(a, bar) / dur) * w;
    const x2 = (barToSeconds(a, bar + 1) / dur) * w;
    c.fillStyle = `rgba(236,234,228,${0.2 + 0.7 * v})`;
    c.fillRect(x1, 2, Math.max(1, x2 - x1), 5);
  });
}

let dragFrom = -1;

// Queue folgt dem laufenden Track: wechselt er, rollt die Liste mit (der gerade gespielte bleibt
// als Orientierung darüber sichtbar). Hat man selbst gerade gescrollt, wird man nicht weggerissen.
const queueFollow = { pos: null, userAt: 0, programmatic: false };

function followQueue(list) {
  if (!list.dataset.follow) {
    list.dataset.follow = '1';
    list.addEventListener('scroll', () => {
      if (queueFollow.programmatic) queueFollow.programmatic = false;
      else queueFollow.userAt = Date.now();
    });
    // hat man gescrollt, wird das Mitrollen nachgeholt, sobald man 8 s nichts macht
    setInterval(() => {
      if (queueFollow.pos !== conductor.pos && Date.now() - queueFollow.userAt > 8000 && !$('#queue-search').value.trim()) {
        queueFollow.pos = conductor.pos;
        scrollToPlaying(list);
      }
    }, 2000);
  }
}

function scrollToPlaying(list) {
  const row = list.querySelector('.qrow.playing') || list.querySelector('.qrow:not(.header):not(.played)');
  if (!row) return;
  const head = list.querySelector('.qrow.header');
  const prev = row.previousElementSibling?.classList.contains('played') ? row.previousElementSibling : null;
  const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top
    - (head ? head.offsetHeight : 0) - (prev ? prev.offsetHeight : 0);
  if (Math.abs(offset) < 2) return;
  queueFollow.programmatic = true;
  list.scrollTop += offset;
}

function renderQueue() {
  previewCache = conductor.previewTransitions();
  const list = $('#queue');
  const q = conductor.queue;
  followQueue(list);
  const keepTop = list.scrollTop;
  list.innerHTML = '';
  if (!q.length) {
    list.innerHTML = loadingFolder
      ? '<div class="empty">Analysiere Tracks …</div>'
      : '<div class="empty"><b>Noch keine Musik geladen.</b><br>Wähle oben einen Ordner mit mp3/wav/ogg/flac – die Tracks werden analysiert (BPM, Tonart, Struktur, Gesang) und automatisch zu einem Set sortiert.</div>';
    $('#queue-info').textContent = '';
    renderRemoved();
    renderPlanInfo();
    return;
  }

  const head = document.createElement('div');
  head.className = 'qrow header';
  head.innerHTML = '<span></span><span>#</span><span>Titel</span><span style="text-align:right">BPM</span><span>Key</span><span>Richtung</span><span>Struktur · Gesang</span><span style="text-align:right">Länge</span><span>Übergang davor</span><span></span>';
  list.appendChild(head);

  const editable = conductor.editableFrom;
  const filter = $('#queue-search').value.trim().toLowerCase();
  let total = 0;
  let remaining = 0;
  let hits = 0;
  q.forEach((id, i) => {
    const t = conductor.track(id);
    if (!t) return;
    const a = t.analysis;
    total += a.duration;
    if (i >= conductor.pos) remaining += a.duration;
    // Suche: nur passende Titel zeigen (Nummern und Aktionen bleiben die echten Positionen)
    if (filter && !`${t.title} ${t.artist || ''} ${t.path || ''}`.toLowerCase().includes(filter)) return;
    if (filter) hits++;
    const row = document.createElement('div');
    row.className = filter ? 'qrow match' : 'qrow';
    if (i < conductor.pos) row.classList.add('played');
    if (i === conductor.pos) row.classList.add('playing');
    if (conductor.pinned.includes(id) && i > conductor.pos) row.classList.add('wished');
    const locked = i < editable;
    if (locked) row.classList.add('locked');
    row.innerHTML = `
      <span class="grip"></span>
      <span class="idx">${i + 1}</span>
      <div class="ti"><div class="t"></div><div class="a"></div></div>
      <span class="num">${a.bpm.toFixed(1)}</span>
      <span><span class="key"></span></span>
      <span class="genre"></span>
      <canvas class="struct"></canvas>
      <span class="num">${fmtTime(a.duration)}</span>
      <span class="trans"></span>
      <span class="acts"></span>`;
    $('.t', row).textContent = t.title;
    $('.a', row).textContent = t.artist || '';
    row.title = t.path;
    keyChip($('.key', row), a.key.camelot);
    drawStructure($('.struct', row), a);
    const gsel = document.createElement('select');
    gsel.className = 'sel';
    gsel.innerHTML = `<option value="auto">Auto · ${GENRES[t.genreWeb || t.genreAuto] || '?'}${t.style ? ` (${t.style})` : ''}</option>` +
      Object.entries(GENRES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    gsel.value = genreOverrides()[t.path] || 'auto';
    gsel.title = 'Musikrichtung dieses Tracks (bestimmt, wie gemixt wird)' + (t.webInfo
      ? `
Online: ${[t.webInfo.itunes, ...(t.webInfo.tags || []).slice(0, 4).map((x) => x.name)].filter(Boolean).join(', ')} · Audio: ${GENRES[t.genreAuto]}`
      : '');
    gsel.onchange = () => {
      setGenreOverride(t.path, gsel.value === 'auto' ? null : gsel.value);
      conductor.applyGenres(resolveGenre);
      refreshUptempo();
    };
    $('.genre', row).appendChild(gsel);

    const trans = $('.trans', row);
    const preview = previewCache.get(id);
    if (i === 0 || i <= conductor.pos) {
      trans.innerHTML = '<span class="trans-fixed"></span>';
      trans.firstChild.textContent = i === 0 ? '–' : '';
    } else if (locked) {
      trans.innerHTML = '<span class="trans-fixed"></span>';
      trans.firstChild.textContent = conductor.plan?.label ?? preview?.label ?? '';
    } else {
      const sel = document.createElement('select');
      sel.className = 'sel';
      const override = conductor.overrides.get(id);
      sel.innerHTML =
        `<option value="auto">Auto${preview && !override ? ` · ${preview.label}` : ''}</option>` +
        Object.entries(TRANSITIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
      sel.value = override || 'auto';
      sel.title = preview?.reason || '';
      sel.onchange = () => conductor.setOverride(id, sel.value);
      trans.appendChild(sel);
    }

    if (!locked) {
      const acts = $('.acts', row);
      const mixBtn = document.createElement('button');
      mixBtn.className = 'mix';
      mixBtn.textContent = 'Mix';
      mixBtn.title = 'Jetzt sofort in diesen Track mixen';
      mixBtn.onclick = () => conductor.mixInto(i);
      acts.append(mixBtn);
      const nextBtn = document.createElement('button');
      nextBtn.textContent = '↑';
      nextBtn.title = 'Als Nächstes spielen';
      nextBtn.onclick = () => conductor.playNext(i);
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = 'Aus der Queue entfernen';
      rm.onclick = () => conductor.remove(i);
      acts.append(nextBtn, rm);

      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragFrom = i;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        dragFrom = -1;
        row.classList.remove('dragging');
      });
      row.addEventListener('dblclick', () => conductor.playNext(i));
    } else if (i < conductor.pos) {
      // schon gespielt: mit Warnung nochmal einreihen (Knopf oder nach vorne ziehen)
      const again = document.createElement('button');
      again.textContent = '↻';
      again.title = 'Nochmal spielen (als Nächstes) – lief schon';
      again.onclick = async () => (await okToReplay(t)) && conductor.replay(id);
      $('.acts', row).append(again);
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragFrom = i;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        dragFrom = -1;
        row.classList.remove('dragging');
      });
    }
    row.addEventListener('dragover', (e) => {
      if (dragFrom < 0 || i < editable) return;
      e.preventDefault();
      list.querySelectorAll('.drop-before').forEach((r) => r.classList.remove('drop-before'));
      row.classList.add('drop-before');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-before');
      if (dragFrom < 0) return;
      const from = dragFrom;
      if (from < conductor.pos) {
        const t2 = conductor.track(q[from]);
        okToReplay(t2).then((ok) => ok && conductor.replay(t2.id, i - 1));
        return;
      }
      conductor.move(from, from < i ? i - 1 : i);
    });
    list.appendChild(row);
  });

  // Ablage ans Ende
  const tail = document.createElement('div');
  tail.style.height = '40px';
  tail.addEventListener('dragover', (e) => dragFrom >= 0 && e.preventDefault());
  tail.addEventListener('drop', () => {
    if (dragFrom < 0) return;
    const from = dragFrom;
    if (from < conductor.pos) {
      const t2 = conductor.track(q[from]);
      okToReplay(t2).then((ok) => ok && conductor.replay(t2.id, q.length));
      return;
    }
    conductor.move(from, q.length - 1);
  });
  list.appendChild(tail);

  $('#queue-info').textContent = (filter ? `${hits} Treffer · ` : '') + `${q.length} Tracks · ${fmtTime(total)} gesamt · ${fmtTime(remaining)} verbleibend`;
  // Neuer Track läuft (oder erstes Zeichnen): mitrollen – außer man hat gerade selbst gescrollt
  // oder sucht etwas; sonst die eigene Scroll-Position behalten
  const moved = queueFollow.pos !== conductor.pos;
  if (moved && !filter && Date.now() - queueFollow.userAt > 8000) {
    queueFollow.pos = conductor.pos;
    setTimeout(() => scrollToPlaying(list), 0);
  } else {
    queueFollow.programmatic = list.scrollTop !== keepTop;
    list.scrollTop = keepTop;
  }
  renderRemoved();
  renderPlanInfo();
}

function renderRemoved() {
  const box = $('#removed');
  const ids = conductor.removed;
  box.hidden = !ids.length;
  box.innerHTML = 'Nicht in der Queue:';
  for (const id of ids) {
    const t = conductor.track(id);
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = `+ ${t.title}`;
    b.onclick = () => conductor.restore(id);
    box.appendChild(b);
  }
}

// ------------------------------------------------------------------ Ordner laden

let currentPlaylists = []; // gewählte Unterordner (mehrere möglich)
const playlistKey = (name) => `${folderRoot}|${name}`;

/** Track-Override > Override seiner Playlist (Unterordner) > Override für "Alle" > automatisch */
function resolveGenre(t) {
  const all = genreOverrides();
  return all[t.path] || all[playlistKey(playlistOf(t.path))] || all[playlistKey(ALL_PLAYLISTS)] || null;
}

// Uptempo gesetzt (Track oder ganze Playlist) heißt: das Tempo liegt sicher im Uptempo-Bereich.
// Nur dort – bei anderen Richtungen kann ein Track durchaus halb so schnell sein.
analysis.hintFor = (f) => (resolveGenre(f) === 'uptempo' ? { bpmMin: 170 } : null);

/** Nach Genre-Änderung: Tracks mit falsch halbiertem Uptempo-Tempo neu analysieren. */
async function refreshUptempo() {
  const todo = [...conductor.tracks.values()].filter((t) => t.analysis && resolveGenre(t) === 'uptempo' && t.analysis.bpm < 170);
  if (!todo.length) return;
  toast(`Uptempo: ${todo.length} Track(s) werden mit Uptempo-Tempo neu analysiert …`);
  for (const t of todo) {
    try {
      const fresh = await analysis.analyzeOne(t);
      conductor.updateAnalysis(t.id, fresh.analysis);
    } catch (err) {
      console.error(err);
    }
  }
}

const ROOT_PLAYLIST = '__root__';
const ALL_PLAYLISTS = '__all__';
let folderFiles = [];
let folderRoot = '';

/** Unterordner (erste Ebene) eines Pfads relativ zum gewählten Oberordner. */
function playlistOf(path) {
  const rel = path.slice(folderRoot.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : ROOT_PLAYLIST;
}

/** Alle Playlists (Unterordner) des Oberordners mit Anzahl Tracks. */
function playlistCounts() {
  const counts = new Map();
  for (const f of folderFiles) counts.set(playlistOf(f.path), (counts.get(playlistOf(f.path)) || 0) + 1);
  const names = [...counts.keys()].filter((n) => n !== ROOT_PLAYLIST).sort((a, b) => a.localeCompare(b, 'de'));
  if (counts.has(ROOT_PLAYLIST)) names.push(ROOT_PLAYLIST);
  return { names, counts };
}

/** Gespeicherte Auswahl (früher ein einzelner Name, jetzt eine Liste) auf vorhandene Playlists abbilden. */
function normalizeSelection(saved) {
  const { names } = playlistCounts();
  let list = Array.isArray(saved) ? saved : saved && saved !== ALL_PLAYLISTS ? [saved] : names;
  list = list.filter((n) => names.includes(n));
  return list.length ? list : names;
}

const playlistLabel = (n) => (n === ROOT_PLAYLIST ? 'Ohne Unterordner' : n);

/** Checkbox-Liste der Playlists aufbauen; `selected` sind die angehakten. */
function renderPlaylists(selected) {
  const { names, counts } = playlistCounts();
  $('#playlist').hidden = names.length <= 1;
  $('#pl-list').innerHTML = names
    .map((n) => `<label class="plpick-item"><input type="checkbox" value="${n.replace(/"/g, '&quot;')}" ${selected.includes(n) ? 'checked' : ''} />
      <span>${playlistLabel(n).replace(/</g, '&lt;')}</span><small>${counts.get(n)}</small></label>`)
    .join('');
  const total = selected.reduce((s, n) => s + (counts.get(n) || 0), 0);
  $('#pl-btn').textContent = selected.length === names.length
    ? `Alle Playlists (${total})`
    : selected.length === 1 ? `${playlistLabel(selected[0])} (${total})` : `${selected.length} Playlists (${total})`;
  return selected;
}

/** Oberordner wählen: Dateien scannen, Unterordner als Playlists anbieten. */
async function loadFolder(path, playlist = loadSettings().playlists ?? loadSettings().playlist) {
  if (loadingFolder) return;
  try {
    const files = await scanFolder(path);
    if (!files.length) {
      toast('In diesem Ordner wurden keine Audiodateien gefunden.');
      return;
    }
    folderRoot = path;
    folderFiles = files;
    $('#folder').textContent = path;
    $('#folder').title = path;
    saveSettings({ folder: path });
    await loadPlaylist(renderPlaylists(normalizeSelection(playlist)));
  } catch (err) {
    toast(`Ordner konnte nicht geladen werden: ${err.message || err}`);
  }
}

/** Richtungs-Auswahl zeigt die gemeinsame Einstellung der gewählten Playlists (sonst "Auto"). */
function showPlaylistGenre() {
  const all = genreOverrides();
  const vals = new Set(currentPlaylists.map((n) => all[playlistKey(n)] || all[playlistKey(ALL_PLAYLISTS)] || 'auto'));
  $('#playlist-genre').value = vals.size === 1 ? [...vals][0] : 'auto';
  $('#playlist-genre').hidden = false;
}

/** Gewählte Playlists (Unterordner) analysieren und gemeinsam als Queue übernehmen. */
async function loadPlaylist(names) {
  if (loadingFolder) return;
  loadingFolder = true;
  saveSettings({ playlists: names });
  currentPlaylists = names;
  showPlaylistGenre();
  const files = folderFiles.filter((f) => names.includes(playlistOf(f.path)));
  const prog = $('#progress');
  const setProgress = (done, total, fname) => {
    prog.hidden = false;
    $('i', prog).style.width = `${(done / total) * 100}%`;
    $('span', prog).textContent = `Analyse ${done}/${total}${fname ? ` · ${fname}` : ''}`;
  };
  try {
    renderQueue();
    setProgress(0, files.length);
    const found = [];
    let failed = 0;
    await analysis.analyzeAll(files, {
      onTrack: (t) => found.push(t),
      onProgress: (d, n, f) => setProgress(d, n, f.name),
      onError: (f, err) => {
        failed++;
        console.error('Analyse fehlgeschlagen:', f.path, err);
      },
    });
    if (failed) toast(`${failed} Datei(en) konnten nicht gelesen werden (Format/Codec).`);
    // Laufende Tracks bleiben beim Playlist-Wechsel erhalten, damit die Musik nicht abreißt
    for (const d of engine.decks) {
      if (d.track && d.status.playing && !found.some((t) => t.id === d.track.id)) found.unshift(d.track);
    }
    webGenre.attach(found); // schon bekannte Online-Genres gleich fürs erste Sortieren
    // derselbe Song in mehreren gewählten Playlists: nur einmal in die Queue
    const { tracks: unique, dropped } = dedupeTracks(found, versionPriority);
    if (dropped.length) toast(`${dropped.length} doppelte Song${dropped.length > 1 ? 's' : ''} (in mehreren Playlists) nur einmal eingereiht`);
    conductor.setLibrary(unique, resolveGenre);
    attachScans(unique);
    webGenre.lookup(conductor.queue.map((id) => conductor.track(id)).filter(Boolean));
  } catch (err) {
    toast(`Playlist konnte nicht geladen werden: ${err.message || err}`);
  } finally {
    loadingFolder = false;
    prog.hidden = true;
    renderQueue();
  }
}

// ------------------------------------------------------------------ Bibliothek-Fenster
// Eigene Ordner-Ansicht: ändert nichts an der laufenden Musik, bis man etwas einreiht.

const lib = { root: '', files: [], selected: [], tracks: [], loading: 0 };
let webGenre = null;
let vocalScan = null;
let scanWholeSet = false;

// ------------------------------------------------------------------ Gesang-Scan (Songtexte)
// Whisper erkennt lokal, wo in jedem Song gesungen wird – auf den Schlag genau. Automatisch für den
// laufenden und die nächsten Songs; "Set vorbereiten" scannt die ganze Queue vorab (fürs Battle).

/** Schon gescannte Songs aus dem Cache übernehmen (ohne neu zu rechnen). */
function attachScans(tracks) {
  vocalScan?.attach(tracks).then((done) => {
    for (const t of done) conductor.trackUpdated(t);
    renderScan();
  });
}

function scanAhead() {
  if (!vocalScan) return;
  const ids = [conductor.decks[conductor.master]?.track?.id, ...conductor.queue.slice(Math.max(0, conductor.pos), scanWholeSet ? undefined : conductor.pos + 4)];
  vocalScan.want([...new Set(ids)].map((id) => conductor.track(id)).filter(Boolean));
  renderScan();
}

function renderScan() {
  const btn = $('#btn-vscan');
  if (!btn || !vocalScan) return;
  const q = conductor.queue.slice(Math.max(0, conductor.pos)).map((id) => conductor.track(id)).filter(Boolean);
  const done = q.filter((t) => t.analysis?.vocalSource === 'lyrics').length;
  const m = vocalScan.model;
  const loadingModel = vocalScan.busy && m && m.total && m.loaded < m.total;
  btn.textContent = !vocalScan.enabled ? 'Gesang-Scan aus'
    : loadingModel ? `KI-Modell lädt ${Math.round((100 * m.loaded) / m.total)} %`
      : vocalScan.busy ? `Gesang-Scan ${done}/${q.length} …` : `Gesang ✓ ${done}/${q.length}`;
  btn.classList.toggle('on', scanWholeSet);
  btn.title = `Gesang-Scan: erkennt per Songtext-KI (lokal), wo gesungen wird – auf den Schlag genau, damit nie in eine Zeile gemixt wird.
${done} von ${q.length} Songs der Queue gescannt${vocalScan.busy ? ` · gerade: ${vocalScan.busy.title}` : ''}.
Klick: ganzes Set vorab scannen (vor dem Auftritt empfohlen). Rechtsklick: an/aus.`;
}

function libPlaylistOf(path) {
  const rel = path.slice(lib.root.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : ROOT_PLAYLIST;
}

async function openLibrary(root, force = false) {
  $('#libwin').hidden = false;
  if (!root) return;
  // Schon geladen: sofort zeigen, nur im Hintergrund nach neuen/entfernten Dateien schauen
  if (!force && root === lib.root && lib.files.length) {
    renderLibFolders();
    renderLibTracks();
    scanFolder(root).then((files) => {
      const was = lib.files.map((f) => f.path).join('|');
      if (files.map((f) => f.path).join('|') === was) return;
      lib.files = files;
      showLibPlaylist(lib.selected.filter((n) => libNames().includes(n)));
    }).catch(() => {});
    return;
  }
  lib.root = root;
  $('#lib-root').textContent = root;
  $('#lib-root').title = root;
  $('#lib-status').textContent = 'Ordner wird gelesen …';
  try {
    lib.files = await scanFolder(root);
  } catch (err) {
    $('#lib-status').textContent = `Fehler: ${err.message || err}`;
    return;
  }
  await showLibPlaylist(libNames());
}

/** Alle Unterordner der Bibliothek (+ "Ohne Unterordner"). */
function libNames() {
  const names = [...new Set(lib.files.map((f) => libPlaylistOf(f.path)))].filter((n) => n !== ROOT_PLAYLIST).sort((a, b) => a.localeCompare(b, 'de'));
  if (lib.files.some((f) => libPlaylistOf(f.path) === ROOT_PLAYLIST)) names.push(ROOT_PLAYLIST);
  return names;
}

/**
 * Ordnerliste der Bibliothek: Häkchen = mehrere Ordner gleichzeitig anzeigen (an-/abwählen),
 * Klick auf den Namen = nur diesen Ordner. "Alle" hakt alles an bzw. ab.
 */
function renderLibFolders() {
  const box = $('#lib-folders');
  const counts = new Map();
  for (const f of lib.files) counts.set(libPlaylistOf(f.path), (counts.get(libPlaylistOf(f.path)) || 0) + 1);
  const names = libNames();
  const allOn = names.length && names.every((n) => lib.selected.includes(n));
  const entries = [[ALL_PLAYLISTS, 'Alle', lib.files.length], ...names.map((n) => [n, n === ROOT_PLAYLIST ? 'Ohne Unterordner' : n, counts.get(n)])];
  box.innerHTML = '';
  for (const [value, label, n] of entries) {
    const on = value === ALL_PLAYLISTS ? allOn : lib.selected.includes(value);
    const el = document.createElement('div');
    el.className = `lib-folder ${on ? 'active' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.title = 'An-/abwählen (mehrere Ordner gleichzeitig)';
    cb.onclick = (e) => {
      e.stopPropagation();
      let next;
      if (value === ALL_PLAYLISTS) next = cb.checked ? names : [];
      else next = cb.checked ? [...lib.selected, value] : lib.selected.filter((x) => x !== value);
      showLibPlaylist(next);
    };
    const span = document.createElement('span');
    span.textContent = label;
    const small = document.createElement('small');
    small.textContent = n;
    el.append(cb, span, small);
    el.onclick = () => showLibPlaylist(value === ALL_PLAYLISTS ? names : [value]);
    box.appendChild(el);
  }
}

async function showLibPlaylist(names) {
  lib.selected = names;
  renderLibFolders();
  const files = lib.files.filter((f) => names.includes(libPlaylistOf(f.path)));
  const token = ++lib.loading;
  const sortByTitle = (list) => list.sort((x, y) => x.title.localeCompare(y.title, 'de'));
  // Songs, die die App schon kennt (analysiert), stehen sofort da – nur neue werden analysiert
  const known = files.map((f) => conductor.track(f.path)).filter((t) => t?.analysis);
  const knownIds = new Set(known.map((t) => t.id));
  const todo = files.filter((f) => !knownIds.has(f.path));
  lib.tracks = sortByTitle([...known]);
  renderLibTracks();
  const done = () => {
    $('#lib-status').textContent = names.length ? `${lib.tracks.length} Tracks aus ${names.length === libNames().length ? 'allen Ordnern' : names.length === 1 ? '1 Ordner' : `${names.length} Ordnern`}` : 'Links Ordner anhaken';
  };
  if (!todo.length) {
    done();
    webGenre.lookup(lib.tracks);
    return;
  }
  const found = [];
  let lastDraw = 0;
  await analysis.analyzeAll(todo, {
    onTrack: (t) => found.push(t),
    onProgress: (d, n) => {
      if (token !== lib.loading) return;
      $('#lib-status').textContent = d < n ? `${known.length} Tracks bereit · analysiere neue ${d}/${n} … (einfügen geht schon)` : '';
      // selten neu zeichnen, sonst verschwinden Knöpfe unter dem Mauszeiger
      if (Date.now() - lastDraw < 2000) return;
      lastDraw = Date.now();
      webGenre.attach(found);
      lib.tracks = sortByTitle([...known, ...conductor.addTracks(found)]);
      renderLibTracks();
    },
    onError: (f, err) => console.error('Analyse fehlgeschlagen:', f.path, err),
  });
  if (token !== lib.loading) return;
  webGenre.attach(found);
  lib.tracks = sortByTitle([...known, ...conductor.addTracks(found)]);
  attachScans(found);
  webGenre.lookup(lib.tracks);
  done();
  renderLibTracks();
}

function renderLibTracks() {
  const list = $('#lib-list');
  const q = $('#lib-search').value.trim().toLowerCase();
  // Scroll-Position beim Neuzeichnen behalten
  const scroller = list.closest('.lib-tracks') || list;
  const top = scroller.scrollTop;
  requestAnimationFrame(() => (scroller.scrollTop = top));
  list.innerHTML = '';
  const queued = new Set(conductor.queue);
  const match = (s) => q.split(/\s+/).every((w) => s.toLowerCase().includes(w));
  const shown = new Set();
  for (const t of lib.tracks) {
    if (q && !match(`${t.title} ${t.artist} ${t.path || ''}`)) continue;
    shown.add(t.path);
    const a = t.analysis;
    const row = document.createElement('div');
    const wasPlayed = conductor.wasPlayed(t.id);
    row.className = `lrow ${queued.has(t.id) && !wasPlayed ? 'inqueue' : ''} ${wasPlayed ? 'played' : ''}`;
    row.innerHTML = `<div><div class="t"></div><div class="a"></div></div>
      <span class="num">${a.bpm.toFixed(1)}</span><span><span class="key"></span></span>
      <span class="g">${GENRES[t.genre] || ''}</span><span class="num">${fmtTime(a.duration)}</span>
      <span class="acts">
        <button class="btn" data-a="next" title="Als Nächstes spielen (Hot-Queue)">Als Nächstes</button>
        <button class="btn" data-a="add" title="Hinten an die Queue anhängen">+ Queue</button>
        <button class="btn" data-a="mix" title="Jetzt reinmixen – mit gutem Übergang an der nächsten passenden Stelle, danach läuft diese Playlist weiter">Mix</button>
      </span>`;
    $('.t', row).textContent = t.title;
    $('.a', row).textContent = t.artist || '';
    keyChip($('.key', row), a.key.camelot);
    if (wasPlayed) row.title = 'Lief heute schon';
    row.querySelector('[data-a=next]').onclick = async () => {
      if (!(await okToReplay(t))) return;
      conductor.queueNext(t);
      toast(`„${t.title}“ kommt als Nächstes`);
      renderLibTracks();
    };
    row.querySelector('[data-a=add]').onclick = async () => {
      if (!(await okToReplay(t))) return;
      conductor.queueAppend(t);
      toast(`„${t.title}“ an die Queue angehängt`);
      renderLibTracks();
    };
    row.querySelector('[data-a=mix]').onclick = async () => {
      if (!(await okToReplay(t))) return;
      if (conductor.wasPlayed(t.id)) conductor.replay(t.id);
      conductor.mixSoon(t, lib.tracks);
      toast(`„${t.title}“ wird an der nächsten passenden Stelle eingemixt – danach läuft diese Playlist`);
      renderLibTracks();
    };
    list.appendChild(row);
  }
  // Suche auch in den nicht angehakten Ordnern (nach Dateiname) – wird beim Klick analysiert
  if (!q) return;
  let more = 0;
  for (const f of lib.files) {
    if (shown.has(f.path) || !match(f.path.split(/[\\/]/).slice(-2).join(' '))) continue;
    if (++more > 100) break;
    const row = document.createElement('div');
    row.className = 'lrow other';
    row.innerHTML = `<div><div class="t"></div><div class="a"></div></div><span></span><span></span><span></span><span></span>
      <span class="acts">
        <button class="btn" data-a="next" title="Als Nächstes spielen (Hot-Queue)">Als Nächstes</button>
        <button class="btn" data-a="add" title="Hinten an die Queue anhängen">+ Queue</button>
        <button class="btn" data-a="mix" title="Jetzt reinmixen">Mix</button>
      </span>`;
    const parts = f.path.split(/[\\/]/);
    $('.t', row).textContent = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    $('.a', row).textContent = libPlaylistOf(f.path) === ROOT_PLAYLIST ? '' : libPlaylistOf(f.path);
    for (const b of row.querySelectorAll('[data-a]')) {
      b.onclick = async () => {
        row.querySelectorAll('button').forEach((x) => (x.disabled = true));
        $('.a', row).textContent = 'Analysiere …';
        const found = [];
        await analysis.analyzeAll([f], { onTrack: (t) => found.push(t), onProgress: () => {}, onError: (_, err) => console.error(err) });
        webGenre.attach(found);
        const [t] = conductor.addTracks(found);
        if (!t) {
          $('.a', row).textContent = 'Analyse fehlgeschlagen';
          return;
        }
        if (b.dataset.a === 'next') conductor.queueNext(t);
        else if (b.dataset.a === 'add') conductor.queueAppend(t);
        else conductor.mixSoon(t, lib.tracks.length ? lib.tracks : [t]);
        toast(`„${t.title}“ ${b.dataset.a === 'next' ? 'kommt als Nächstes' : b.dataset.a === 'add' ? 'an die Queue angehängt' : 'wird eingemixt'}`);
        renderLibTracks();
      };
    }
    list.appendChild(row);
  }
}

// ------------------------------------------------------------------ Start

async function boot() {
  await engine.init();
  conductor = new Conductor(engine);
  // Genre online nachschlagen: neue Ergebnisse -> Mix-Richtungen aktualisieren; ist die Runde
  // durch, sortiert der Autopilot die Queue einmal neu (gleiche Richtungen am Stück)
  webGenre = createWebGenre({
    onUpdate: (tracks, final) => {
      if (!tracks.length) return;
      conductor.applyGenres(resolveGenre);
      if (final && conductor.autopilot) conductor.reorderAI();
      if (final) toast(`Genre online ergänzt: ${tracks.length} Song${tracks.length > 1 ? 's' : ''}`);
    },
  });
  vocalScan = new VocalScan();
  vocalScan.enabled = loadSettings().vocalScan !== false;
  // kein Scan-Start, während ein Übergang läuft oder gleich beginnt – die Wiedergabe hat Vorrang
  vocalScan.shouldWait = () => {
    const p = conductor.plan;
    return !!p && (p.committed || (p.firstStepTime ?? Infinity) - engine.now < 20);
  };
  vocalScan.addEventListener('done', (e) => {
    conductor.trackUpdated(e.detail);
    renderScan();
  });
  vocalScan.addEventListener('status', renderScan);
  vocalScan.addEventListener('error', (e) => {
    if (!vocalScan.device) toast(`Gesang-Scan nicht möglich: ${e.detail.error?.message || e.detail.error}`);
  });
  conductor.addEventListener('queue', scanAhead);
  conductor.addEventListener('transitionDone', scanAhead);
  $('#btn-vscan').onclick = () => {
    if (!vocalScan.enabled) return;
    scanWholeSet = !scanWholeSet;
    toast(scanWholeSet ? 'Ganzes Set wird vorab auf Gesang gescannt (läuft im Hintergrund)' : 'Gesang-Scan nur noch für die nächsten Songs');
    scanAhead();
  };
  $('#btn-vscan').oncontextmenu = (e) => {
    e.preventDefault();
    vocalScan.enabled = !vocalScan.enabled;
    saveSettings({ vocalScan: vocalScan.enabled });
    toast(vocalScan.enabled ? 'Gesang-Scan an' : 'Gesang-Scan aus – dann zählt nur die Signal-Analyse');
    scanAhead();
  };
  window.automix = { engine, conductor, vocalScan }; // für Debugging in den DevTools
  buildDeck(0);
  buildDeck(1);
  buildStrip(0);
  buildStrip(1);

  const masterSlider = new Slider($('#master-vol'), { value: 1, onInput: (v) => engine.setMasterVolume(v) });
  new Slider($('#xfader'), { value: 0.5, onInput: (v) => engine.setCrossfader(v) });

  // Playlist-Auswahl: mehrere an-/abwählen, mit "Übernehmen" laden
  const plMenu = $('#pl-menu');
  const checked = () => [...$('#pl-list').querySelectorAll('input:checked')].map((i) => i.value);
  $('#pl-btn').onclick = (e) => {
    e.stopPropagation();
    if (plMenu.hidden) {
      renderPlaylists(currentPlaylists);
      // direkt unter dem Knopf aufklappen, über allem anderen (Decks, Laser)
      const r = $('#pl-btn').getBoundingClientRect();
      plMenu.style.top = `${r.bottom + 4}px`;
      plMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 290))}px`;
    }
    plMenu.hidden = !plMenu.hidden;
  };
  plMenu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => (plMenu.hidden = true));
  $('#pl-all').onclick = (e) => {
    e.preventDefault();
    for (const i of $('#pl-list').querySelectorAll('input')) i.checked = true;
  };
  $('#pl-none').onclick = (e) => {
    e.preventDefault();
    for (const i of $('#pl-list').querySelectorAll('input')) i.checked = false;
  };
  $('#pl-apply').onclick = () => {
    const names = checked();
    if (!names.length) return toast('Mindestens eine Playlist anhaken.');
    plMenu.hidden = true;
    loadPlaylist(renderPlaylists(names));
  };
  $('#btn-library').onclick = () => {
    if ($('#libwin').hidden) openLibrary(lib.root || folderRoot || null);
    else $('#libwin').hidden = true;
  };
  $('#lib-close').onclick = () => ($('#libwin').hidden = true);
  $('#lib-open').onclick = async () => {
    const path = await pickFolder();
    if (path) openLibrary(path);
  };
  $('#lib-search').oninput = renderLibTracks;
  $('#lib-take').onclick = () => {
    if (!lib.tracks.length) return;
    conductor.switchPlaylist(dedupeTracks(lib.tracks, versionPriority).tracks);
    toast('Nach dem aktuellen Track geht es mit dieser Playlist weiter');
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#libwin').hidden = true;
  });
  const pg = $('#playlist-genre');
  pg.innerHTML = '<option value="auto">Richtung: Auto</option>' +
    Object.entries(GENRES).map(([k, v]) => `<option value="${k}">Richtung: ${v}</option>`).join('');
  pg.onchange = () => {
    for (const n of currentPlaylists) setGenreOverride(playlistKey(n), pg.value === 'auto' ? null : pg.value);
    conductor.applyGenres(resolveGenre);
    refreshUptempo();
  };
  $('#btn-folder').onclick = async () => {
    const path = await pickFolder();
    if (path) loadFolder(path, null);
  };
  $('#btn-start').onclick = () => conductor.togglePlay(conductor.master);
  $('#btn-reorder').onclick = () => conductor.reorderAI();
  $('#queue-search').oninput = renderQueue;
  // Musikwunsch: Text oder Schnellknopf -> passende Songs kommen als Nächstes
  let wishUndo = null;
  let lastWish = null; // für die Handy-App: was zuletzt gewünscht und verstanden wurde
  const doWish = (text) => {
    if (!String(text || '').trim()) return;
    const r = conductor.applyWish(text);
    let msg;
    if (r.wish.empty) {
      msg = 'Nicht verstanden – probier z. B. „ruhiger“, „Party“, „Schlager“, „härter“, „Hip-Hop“ oder einen Interpreten';
    } else if (!r.tracks.length) {
      msg = `Nichts Passendes gefunden für: ${r.wish.summary.join(', ')}`;
    } else {
      wishUndo = r.undo;
      $('#wish-undo').hidden = false;
      msg = `Verstanden: ${r.wish.summary.join(', ')} → als Nächstes: ${r.tracks.slice(0, 3).map((t) => t.title).join(', ')}${r.tracks.length > 3 ? ` (+${r.tracks.length - 3})` : ''}`;
    }
    toast(msg);
    lastWish = { text: String(text), ok: !!r.tracks.length, message: msg, titles: r.tracks.map((t) => t.title), canUndo: !!r.tracks.length, at: Date.now() };
  };
  $('#wish-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doWish(e.target.value);
  });
  $('#wish-go').onclick = () => doWish($('#wish-input').value);
  $('#wish-chips').onclick = (e) => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (w) doWish(w);
  };
  $('#wish-undo').onclick = () => {
    if (!wishUndo) return;
    const ok = wishUndo();
    toast(ok ? 'Wunsch zurückgenommen – vorige Reihenfolge' : 'Geht nicht mehr – davon läuft schon etwas');
    if (lastWish) lastWish = { ...lastWish, canUndo: false, message: ok ? 'Wunsch zurückgenommen' : 'Rückgängig geht nicht mehr – davon läuft schon etwas', at: Date.now() };
    wishUndo = null;
    $('#wish-undo').hidden = true;
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const s = $('#libwin').hidden ? $('#queue-search') : $('#lib-search');
      s.focus();
      s.select();
    } else if (e.key === 'Escape' && e.target.id === 'queue-search') {
      e.target.value = '';
      renderQueue();
    }
  });
  $('#btn-reshuffle').onclick = () => conductor.reshuffle();
  $('#btn-mixnow').onclick = () => conductor.mixNow();
  $('#btn-extend').onclick = () => {
    if (!conductor.extend()) toast('Länger geht nicht – der Song ist fast zu Ende oder der Übergang läuft schon.');
  };
  $('#btn-jump').onclick = () => {
    if (!conductor.jumpToTransition()) toast('Noch kein Übergang geplant (der nächste Track wird gerade vorbereitet).');
  };
  $('#automix').onchange = (e) => conductor.setAutomix(e.target.checked);
  $('#freestyle').onchange = (e) => {
    conductor.setFreestyle(e.target.checked);
    saveSettings({ freestyle: e.target.checked });
  };
  // Bewertung des letzten Übergangs -> die App lernt deinen Geschmack
  let lastTransition = null;
  const applyLearned = () => {
    const l = learn();
    conductor.setLearned(l);
    window.__automixLaser?.setPrefs(l.laser);
    $('#tr-learned').innerHTML = `Gelernt: ${describeLearned(l, TRANSITIONS)} · <a href="#" id="fb-copy">Protokoll kopieren</a>`;
    $('#fb-copy').onclick = async (ev) => {
      ev.preventDefault();
      const text = JSON.stringify(loadFeedback(), null, 1);
      try {
        await navigator.clipboard.writeText(text);
        toast('Übergangs-Protokoll kopiert – kannst du mir einfach schicken');
      } catch {
        toast('Kopieren nicht erlaubt');
      }
    };
  };
  applyLearned();
  const rateBox = $('#tr-rate');
  const reasonsBox = $('#rate-reasons');
  reasonsBox.innerHTML = Object.entries(REASONS).map(([k, v]) => `<button class="btn small chip" data-r="${k}">${v}</button>`).join('');
  const save = (verdict, reasons = []) => {
    if (!lastTransition) return;
    const t = lastTransition;
    addFeedback({
      verdict, reasons, type: t.type, label: t.label, genres: t.genres, bars: t.bars,
      out: t.out ? `${t.out.artist || ''} – ${t.out.title || t.out.name || ''}` : '',
      in: t.inc ? `${t.inc.artist || ''} – ${t.inc.title || t.inc.name || ''}` : '',
      outBar: t.outBar, inBar: t.inBar, audit: t.audit, freestyle: t.freestyle, outId: t.outId, inId: t.inId,
    });
    lastTransition = null;
    rateBox.hidden = true;
    reasonsBox.hidden = true;
    applyLearned();
    toast(verdict === 'up' ? 'Gemerkt – öfter so' : 'Gemerkt – wird angepasst');
  };
  $('#rate-up').onclick = () => save('up');

  // Freestyle-Tricks und Teaser anzeigen, sobald sie wirklich passieren – und bewertbar machen
  let lastTrick = null;
  const trickRow = $('#trick-row');
  const showTrick = (info, text) => {
    lastTrick = { ...info, shownAt: Date.now() };
    $('#tr-trick').textContent = text;
    trickRow.hidden = false;
    clearTimeout(trickRow._t);
    trickRow._t = setTimeout(() => {
      trickRow.hidden = true;
      lastTrick = null;
    }, 30000);
  };
  const rateTrick = (verdict) => {
    if (!lastTrick) return;
    addFeedback({ kind: 'trick', trick: lastTrick.kind, name: lastTrick.name, verdict, genre: conductor.masterDeck.track?.genre || null });
    trickRow.hidden = true;
    lastTrick = null;
    applyLearned();
    toast(verdict === 'up' ? 'Gemerkt – kommt öfter' : 'Gemerkt – kommt seltener');
  };
  $('#trick-up').onclick = () => rateTrick('up');
  $('#trick-down').onclick = () => rateTrick('down');
  conductor.addEventListener('teaser', (e) => {
    const wait = Math.max(0, e.detail.at - engine.now);
    setTimeout(() => showTrick({ kind: 'teaser', name: 'Teaser' }, `Teaser: ${e.detail.bars} Takte vom nächsten Track (${e.detail.what})`), wait * 1000);
  });
  conductor.addEventListener('trick', (e) => {
    const wait = Math.max(0, (e.detail.at ?? engine.now) - engine.now);
    setTimeout(() => showTrick({ kind: e.detail.kind, name: e.detail.name }, `Freestyle: ${e.detail.name}`), wait * 1000);
  });
  // Reihenfolge bewerten: passte der neue Song nach dem vorigen?
  let lastPair = null;
  const orderBox = $('#order-rate');
  const orderReasons = $('#order-reasons');
  orderReasons.innerHTML = Object.entries(ORDER_REASONS).map(([k, v]) => `<button class="btn small chip" data-r="${k}">${v}</button>`).join('');
  const rateOrder = (verdict, reason = null) => {
    if (!lastPair) return;
    const ta = conductor.track(lastPair.a);
    const tb = conductor.track(lastPair.b);
    addFeedback({
      kind: 'order', a: lastPair.a, b: lastPair.b, title: lastPair.title, verdict, reasons: reason ? [reason] : [],
      fa: ta ? orderFeatures(ta) : null, fb: tb ? orderFeatures(tb) : null, // damit es auch für ähnliche Paare gilt
    });
    lastPair = null;
    orderBox.hidden = true;
    orderReasons.hidden = true;
    applyLearned();
    toast(verdict === 'up' ? 'Gemerkt – solche Folgen öfter' : 'Gemerkt – das Paar kommt so nicht mehr');
  };
  $('#order-up').onclick = () => rateOrder('up');
  $('#order-down').onclick = () => (orderReasons.hidden = !orderReasons.hidden);
  orderReasons.onclick = (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    if (r) rateOrder('down', r);
  };
  // Handy-App: Status/Befehle über den Companion-Server, Playlist-Warnung auch als Push aufs Handy
  const companion = initCompanion({
    engine,
    conductor,
    actions: {
      // Playlist-Auswahl vom Handy (gleiche Logik wie oben in der Kopfzeile)
      playlists: () => {
        if (!folderFiles.length) return null;
        const { names, counts } = playlistCounts();
        return {
          label: $('#pl-btn').textContent,
          genre: $('#playlist-genre').value,
          items: names.map((n) => ({ name: n, label: playlistLabel(n), count: counts.get(n), selected: currentPlaylists.includes(n) })),
        };
      },
      setPlaylists: (names) => {
        const { names: all } = playlistCounts();
        const pick = (names || []).filter((n) => all.includes(n));
        if (pick.length) loadPlaylist(renderPlaylists(pick));
      },
      setPlaylistGenre: (g) => {
        const pg = $('#playlist-genre');
        if (![...pg.options].some((o) => o.value === g)) return;
        pg.value = g;
        pg.dispatchEvent(new Event('change'));
      },
      setSwitch: (sel, on) => {
        const el = $(sel);
        if (!el || el.disabled || el.checked === on) return;
        el.checked = on;
        el.dispatchEvent(new Event('change'));
      },
      setMaster: (v) => {
        engine.setMasterVolume(v);
        masterSlider.set(v);
      },
      rate: (verdict, reason) => save(verdict, reason ? [reason] : []),
      lastTransition: () => (lastTransition ? { label: lastTransition.label, title: lastTransition.inc?.title || '' } : null),
      lastTrick: () => (lastTrick ? { kind: lastTrick.kind, name: lastTrick.name || TRICKS[lastTrick.kind] || '' } : null),
      rateTrick,
      wish: (text) => doWish(text),
      undoWish: () => $('#wish-undo').click(),
      lastWish: () => lastWish,
      lastPair: () => (lastPair ? { title: lastPair.title } : null),
      rateOrder: (verdict, reason) => rateOrder(verdict, reason),
    },
    onWarning: (text) => {
      toast(text);
      const w = $('#queue-warn');
      w.textContent = text;
      w.hidden = false;
    },
  });
  conductor.addEventListener('queue', () => {
    const left = conductor.queue.length - (conductor.pos + 1);
    if (left > 10) $('#queue-warn').hidden = true;
  });
  let phoneTimer = 0;
  const showPhone = async () => {
    const info = await companion?.info();
    if (!info) {
      $('#phone-addr').textContent = 'nur in der Desktop-App verfügbar';
      return;
    }
    $('#phone-addr').textContent = `${info.ip}:${info.port}`;
    $('#phone-pin').textContent = info.pin;
    $('#phone-status').textContent = info.connected ? '● Handy verbunden' : '○ noch kein Handy verbunden';
    $('#phone-status').classList.toggle('ok', info.connected);
    $('#btn-phone').classList.toggle('on', info.connected);
  };
  $('#btn-phone').onclick = () => {
    const win = $('#phonewin');
    win.hidden = !win.hidden;
    clearInterval(phoneTimer);
    if (!win.hidden) {
      showPhone();
      phoneTimer = setInterval(showPhone, 2000);
    }
  };
  $('#phone-close').onclick = () => {
    $('#phonewin').hidden = true;
    clearInterval(phoneTimer);
  };
  setInterval(() => $('#phonewin').hidden && showPhone(), 10000); // Button zeigt Verbindung an
  $('#rate-down').onclick = () => {
    reasonsBox.hidden = !reasonsBox.hidden;
  };
  reasonsBox.onclick = (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    if (r) save('down', [r]);
  };
  conductor.addEventListener('transitionDone', (e) => {
    if (e.detail.outId && e.detail.inId) {
      lastPair = { a: e.detail.outId, b: e.detail.inId, title: `${e.detail.inc?.title || ''} nach ${e.detail.out?.title || ''}` };
      $('#order-name').textContent = `Passte „${e.detail.inc?.title || ''}“ nach „${e.detail.out?.title || ''}“?`;
      orderBox.hidden = false;
      orderReasons.hidden = true;
    }
    lastTransition = e.detail;
    $('#rate-name').textContent = `${e.detail.label} (${e.detail.inc?.title || ''})`;
    rateBox.hidden = false;
    reasonsBox.hidden = true;
  });
  $('#autopilot').onchange = (e) => {
    conductor.setAutopilot(e.target.checked);
    $('#automix').checked = conductor.automix;
    $('#automix').disabled = e.target.checked;
    saveSettings({ autopilot: e.target.checked });
  };

  const typeSel = $('#tr-type');
  typeSel.innerHTML = '<option value="auto">Auto</option>' +
    Object.entries(TRANSITIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  typeSel.onchange = () => {
    const nextId = nextQueueId();
    if (nextId) conductor.setOverride(nextId, typeSel.value);
  };

  conductor.addEventListener('queue', renderQueue);
  conductor.addEventListener('plan', () => {
    previewCache = conductor.previewTransitions();
    renderPlanInfo();
  });
  conductor.addEventListener('error', (e) => toast(e.detail));
  conductor.addEventListener('cues', () => {
    renderPads(0);
    renderPads(1);
  });

  document.addEventListener('pointerdown', () => engine.resume());
  document.addEventListener('keydown', (e) => {
    if ((e.key === 't' || e.key === 'z') && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLInputElement)) {
      tapTempo(e.key === 't' ? 0 : 1);
      return;
    }
    if (e.code === 'Space' && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      conductor.togglePlay(conductor.master);
    }
  });

  renderQueue();
  requestAnimationFrame(frame);
  // Lasershow getrennt laden: ein Fehler dort darf den Mixer nie mitreißen
  import('./ui/laserpane.js')
    .then(({ initLaserPane }) => initLaserPane({ engine, conductor }))
    .catch((err) => console.error('Lasershow', err));

  const { folder, autopilot, freestyle } = loadSettings();
  if (freestyle) {
    $('#freestyle').checked = true;
    conductor.setFreestyle(true);
  }
  if (autopilot) {
    $('#autopilot').checked = true;
    $('#automix').disabled = true;
    conductor.autopilot = true;
  }
  if (folder) await loadFolder(folder);
  // Nicht von selbst losspielen – erst, wenn du auf Start tippst
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="empty">Audio-Engine konnte nicht starten: ${String(err.message || err)}</div>`;
});
