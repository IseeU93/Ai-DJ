import { Engine } from './audio/engine.js';
import { Conductor } from './mix/conductor.js';
import { AnalysisService } from './analysis/service.js';
import { TRANSITIONS, KILL, barToSeconds } from './mix/planner.js';
import { parseCamelot } from './mix/order.js';
import { Knob, Slider } from './ui/controls.js';
import { DeckWaveform, drawOverview } from './ui/waveform.js';
import { drawTimeline } from './ui/timeline.js';
import { pickFolder, scanFolder } from './lib/tauri.js';
import { loadSettings, saveSettings } from './lib/store.js';

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

function keyChip(el, camelot) {
  const k = parseCamelot(camelot);
  el.textContent = camelot || '–';
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

// ------------------------------------------------------------------ Decks

function buildDeck(i) {
  const root = $(`.deck[data-deck="${i}"]`);
  root.innerHTML = `
    <div class="deck-head">
      <span class="deck-id">${NAMES[i]}</span>
      <div class="deck-title"><div class="t">Leer</div><div class="a deck-state"></div></div>
      <span class="key">–</span>
      <div class="stat"><b class="bpm">–</b><small class="rate">&nbsp;</small></div>
      <div class="stat" style="min-width:64px"><b class="remain">–:––</b><small class="elapsed">&nbsp;</small></div>
    </div>
    <canvas class="wave"></canvas>
    <canvas class="overview" title="Klicken zum Springen (auf Takt gerundet)"></canvas>
    <div class="deck-controls">
      <button class="btn transport play" title="Play / Pause">${ICON_PLAY}</button>
      <button class="btn cue" title="Zurück zum ersten Takt">Cue</button>
      <button class="btn sync" title="Tempo und Takt an das andere Deck angleichen">Sync</button>
      <button class="btn toggle keylock on" title="Tonhöhe bei Tempoänderung halten">Keylock</button>
      <span class="sep"></span>
      <span class="lbl">Loop</span>
      ${LOOPS.map(([b, l]) => `<button class="btn loopbtn" data-bars="${b}" title="${b} Takt(e)">${l}</button>`).join('')}
      <button class="btn loopbtn exit" title="Loop verlassen">Exit</button>
    </div>
    <div class="pads" title="Hot Cues: Klick springt im Takt · leeres Pad setzt einen Cue · Rechtsklick löscht"></div>`;
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
    lastTrack: undefined,
  };
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
                  <button class="btn echo" title="Echo (¾ Beat)">ECHO</button>`;
  root.appendChild(fx);
  const vox = $('.vox', fx);
  const echo = $('.echo', fx);
  vox.onclick = () => conductor.setParam(i, 'vocal', engine.decks[i].get('vocal') > 0.5 ? 0 : 1);
  echo.onclick = () => {
    const d = engine.decks[i];
    if (d.track) d.setEchoTime((0.75 * 60) / (d.track.analysis.bpm * (d.status.rate || 1)));
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

  if (ui.lastTrack !== track) {
    ui.lastTrack = track;
    ui.title.textContent = track ? track.title : 'Leer';
    keyChip(ui.key, track?.analysis.key.camelot);
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

function renderQueue() {
  previewCache = conductor.previewTransitions();
  const list = $('#queue');
  const q = conductor.queue;
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
  head.innerHTML = '<span></span><span>#</span><span>Titel</span><span style="text-align:right">BPM</span><span>Key</span><span>Energie</span><span>Struktur · Gesang</span><span style="text-align:right">Länge</span><span>Übergang davor</span><span></span>';
  list.appendChild(head);

  const editable = conductor.editableFrom;
  let total = 0;
  let remaining = 0;
  q.forEach((id, i) => {
    const t = conductor.track(id);
    if (!t) return;
    const a = t.analysis;
    total += a.duration;
    if (i >= conductor.pos) remaining += a.duration;
    const row = document.createElement('div');
    row.className = 'qrow';
    if (i < conductor.pos) row.classList.add('played');
    if (i === conductor.pos) row.classList.add('playing');
    const locked = i < editable;
    if (locked) row.classList.add('locked');
    row.innerHTML = `
      <span class="grip"></span>
      <span class="idx">${i + 1}</span>
      <div class="ti"><div class="t"></div><div class="a"></div></div>
      <span class="num">${a.bpm.toFixed(1)}</span>
      <span><span class="key"></span></span>
      <div class="energy"><i style="width:${Math.round((t.energy ?? 0.5) * 100)}%"></i></div>
      <canvas class="struct"></canvas>
      <span class="num">${fmtTime(a.duration)}</span>
      <span class="trans"></span>
      <span class="acts"></span>`;
    $('.t', row).textContent = t.title;
    $('.a', row).textContent = t.artist || '';
    row.title = t.path;
    keyChip($('.key', row), a.key.camelot);
    drawStructure($('.struct', row), a);

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
      conductor.move(dragFrom, dragFrom < i ? i - 1 : i);
    });
    list.appendChild(row);
  });

  // Ablage ans Ende
  const tail = document.createElement('div');
  tail.style.height = '40px';
  tail.addEventListener('dragover', (e) => dragFrom >= 0 && e.preventDefault());
  tail.addEventListener('drop', () => dragFrom >= 0 && conductor.move(dragFrom, q.length - 1));
  list.appendChild(tail);

  $('#queue-info').textContent = `${q.length} Tracks · ${fmtTime(total)} gesamt · ${fmtTime(remaining)} verbleibend`;
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

async function loadFolder(path) {
  if (loadingFolder) return;
  loadingFolder = true;
  $('#folder').textContent = path;
  $('#folder').title = path;
  const prog = $('#progress');
  const setProgress = (done, total, name) => {
    prog.hidden = false;
    $('i', prog).style.width = `${(done / total) * 100}%`;
    $('span', prog).textContent = `Analyse ${done}/${total}${name ? ` · ${name}` : ''}`;
  };
  try {
    const files = await scanFolder(path);
    if (!files.length) {
      toast('In diesem Ordner wurden keine Audiodateien gefunden.');
      return;
    }
    saveSettings({ folder: path });
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
    conductor.setLibrary(found);
    if (conductor.autopilot && !engine.decks[conductor.master].status.playing) conductor.start();
  } catch (err) {
    toast(`Ordner konnte nicht geladen werden: ${err.message || err}`);
  } finally {
    loadingFolder = false;
    prog.hidden = true;
    renderQueue();
  }
}

// ------------------------------------------------------------------ Start

async function boot() {
  await engine.init();
  conductor = new Conductor(engine);
  window.automix = { engine, conductor }; // für Debugging in den DevTools
  buildDeck(0);
  buildDeck(1);
  buildStrip(0);
  buildStrip(1);

  new Slider($('#master-vol'), { value: 1, onInput: (v) => engine.setMasterVolume(v) });
  new Slider($('#xfader'), { value: 0.5, onInput: (v) => engine.setCrossfader(v) });

  $('#btn-folder').onclick = async () => {
    const path = await pickFolder();
    if (path) loadFolder(path);
  };
  $('#btn-start').onclick = () => conductor.togglePlay(conductor.master);
  $('#btn-reorder').onclick = () => conductor.reorderAI();
  $('#btn-reshuffle').onclick = () => conductor.reshuffle();
  $('#btn-mixnow').onclick = () => conductor.mixNow();
  $('#automix').onchange = (e) => conductor.setAutomix(e.target.checked);
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
    if (e.code === 'Space' && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      conductor.togglePlay(conductor.master);
    }
  });

  renderQueue();
  requestAnimationFrame(frame);

  const { folder, autopilot } = loadSettings();
  if (autopilot) {
    $('#autopilot').checked = true;
    $('#automix').disabled = true;
    conductor.autopilot = true;
  }
  if (folder) await loadFolder(folder);
  if (conductor.autopilot && conductor.queue.length) conductor.start();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="empty">Audio-Engine konnte nicht starten: ${String(err.message || err)}</div>`;
});
