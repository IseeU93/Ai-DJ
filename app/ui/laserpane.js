// Lasershow-Bereich im Mixer: ein-/ausblenden, geteilt oder Vollbild, Seite und Breite frei
// wählbar (wird gemerkt), Beamer-Fenster, und die Show-Einstellungen.
import { LaserStage } from '../laser/dj/stage.js';

const $ = (sel) => document.querySelector(sel);
const LAYOUT = 'automix.laser.layout';
const EFFECTS = {
  scanner: 'Scanner', beamSweep: 'Beam Sweep', hotBeams: 'Hot Beams', liquidSky: 'Liquid Sky',
  tunnel: 'Tunnel', lsdTunnel: 'LSD-Tunnel', rainbowRing: 'Regenbogen-Ring', chaosBlades: 'Chaos Blades',
  spiral: 'Spirale', snake: 'Snake', lissajous: 'Lissajous', waveform: 'Wellenform',
};
const PALETTES = { green: 'Grün', red: 'Rot', cyan: 'Cyan', white: 'Weiß', rainbow: 'Regenbogen' };
const PHASES = { intro: 'Intro', verse: 'Groove', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };

function loadLayout() {
  const base = { mode: 'off', side: 'right', width: null };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(LAYOUT)) };
  } catch {
    return base;
  }
}

export function initLaserPane({ engine, conductor }) {
  const shell = $('#shell');
  const pane = $('#laserpane');
  const stage = new LaserStage({ engine, conductor, canvas: $('#lz-canvas') });
  const layout = loadLayout();
  let lastOpenMode = layout.mode === 'off' ? 'split' : layout.mode;

  const save = () => {
    try {
      localStorage.setItem(LAYOUT, JSON.stringify(layout));
    } catch {
      /* egal */
    }
  };

  function render() {
    shell.dataset.laser = layout.mode;
    shell.dataset.side = layout.side;
    pane.hidden = layout.mode === 'off';
    if (layout.width) shell.style.setProperty('--lz-w', `${layout.width}px`);
    else shell.style.removeProperty('--lz-w');
    $('#btn-laser').classList.toggle('on', layout.mode !== 'off');
    for (const b of document.querySelectorAll('#lz-mode button')) b.classList.toggle('on', b.dataset.mode === layout.mode);
    stage.setVisible(layout.mode !== 'off');
    requestAnimationFrame(() => stage.fit());
    window.dispatchEvent(new Event('resize')); // Wellenformen/Timeline des Mixers neu vermessen
  }

  function setMode(mode) {
    if (mode !== 'off') lastOpenMode = mode;
    layout.mode = mode;
    save();
    render();
  }

  $('#btn-laser').onclick = () => setMode(layout.mode === 'off' ? lastOpenMode : 'off');
  $('#lz-close').onclick = () => setMode('off');
  $('#lz-exitfull').onclick = () => setMode('split');
  for (const b of document.querySelectorAll('#lz-mode button')) b.onclick = () => setMode(b.dataset.mode);
  $('#lz-swap').onclick = () => {
    layout.side = layout.side === 'right' ? 'left' : 'right';
    save();
    render();
  };
  $('#lz-beamer').onclick = () => stage.openBeamer().catch((err) => console.error('Beamer-Fenster', err));
  $('#lz-mixnow').onclick = () => $('#btn-mixnow').click();
  $('#lz-canvas').ondblclick = () => setMode(layout.mode === 'full' ? 'split' : 'full');

  // Aufteilung per Ziehen
  const split = $('#lz-split');
  split.onpointerdown = (e) => {
    split.setPointerCapture(e.pointerId);
    split.classList.add('drag');
    const r = shell.getBoundingClientRect();
    split.onpointermove = (ev) => {
      const w = layout.side === 'right' ? r.right - ev.clientX : ev.clientX - r.left;
      layout.width = Math.round(Math.max(260, Math.min(r.width - 520, w)));
      shell.style.setProperty('--lz-w', `${layout.width}px`);
      stage.fit();
    };
    split.onpointerup = () => {
      split.onpointermove = null;
      split.classList.remove('drag');
      save();
      window.dispatchEvent(new Event('resize'));
    };
  };
  split.ondblclick = () => {
    layout.width = null;
    save();
    render();
  };

  // Einstellungen
  const s = stage.settings;
  const syncManual = () => {
    $('#lz-effect').classList.toggle('dim', s.autopilot);
    $('#lz-palette').classList.toggle('dim', s.autopilot);
  };
  const bindSwitch = (id, key) => {
    const el = $(id);
    el.checked = !!s[key];
    el.onchange = () => {
      stage.set(key, el.checked);
      syncManual();
    };
  };
  bindSwitch('#lz-auto', 'autopilot');
  bindSwitch('#lz-sync', 'trackSync');
  bindSwitch('#lz-keycol', 'keyColors');
  bindSwitch('#lz-strobe', 'strobe');
  const fill = (sel, map, value) => {
    sel.innerHTML = Object.entries(map).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = value;
  };
  fill($('#lz-effect'), EFFECTS, s.effect);
  fill($('#lz-palette'), PALETTES, s.palette);
  $('#lz-intensity').value = String(s.intensity);
  $('#lz-intensity').onchange = (e) => stage.set('intensity', e.target.value);
  // Effekt/Farbe von Hand wählen heißt: Autopilot aus
  const manual = (key) => (e) => {
    if (s.autopilot) {
      $('#lz-auto').checked = false;
      s.autopilot = false;
    }
    stage.set(key, e.target.value);
    syncManual();
  };
  $('#lz-effect').onchange = manual('effect');
  $('#lz-palette').onchange = manual('palette');
  syncManual();
  $('#lz-blackout').onclick = () => {
    stage.toggleBlackout();
    $('#lz-blackout').classList.toggle('on', stage.manualBlackout);
  };

  // Statuszeile: was der Laser gerade über die Musik weiß
  stage.addEventListener('status', ({ detail: st }) => {
    if (s.autopilot) {
      $('#lz-effect').value = stage.config.effect;
      if (PALETTES[stage.config.palette]) $('#lz-palette').value = stage.config.palette;
    }
    const parts = [];
    if (st.deck >= 0) parts.push(`Deck ${'AB'[st.deck]}`);
    if (st.bpm) parts.push(`${st.bpm} BPM`);
    if (st.key) parts.push(st.key);
    if (st.phase && st.phase !== '-') parts.push(PHASES[st.phase] || st.phase);
    let html = parts.join(' · ');
    if (Number.isFinite(st.beatsToDrop) && st.beatsToDrop <= 32 && st.phase !== 'drop') {
      html += ` · <span class="hot">Drop in ${Math.ceil(st.beatsToDrop / 4)} T.</span>`;
    }
    if (st.mixing) html += ' · Übergang';
    if (stage.beamerOpen) html += ' · Beamer';
    $('#lz-status').innerHTML = html || 'wartet auf Musik';
    $('#lz-now').textContent = st.title ? `${st.title} · ${PHASES[st.phase] || ''}` : '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'l' || e.key === 'L') setMode(layout.mode === 'off' ? lastOpenMode : 'off');
    else if (e.key === 'Escape' && layout.mode === 'full') setMode('split');
    else if ((e.key === 'b' || e.key === 'B') && layout.mode !== 'off') $('#lz-blackout').click();
  });

  render();
  // Auch ohne sichtbaren Bereich (nur Beamer-Fenster) soll mitgehört werden – ab dem ersten Klick
  document.addEventListener('pointerdown', () => engine.resume().then(() => stage.ensureRunning()), { once: true });
  window.__automixLaser = stage; // für Diagnose in den DevTools
  return stage;
}
