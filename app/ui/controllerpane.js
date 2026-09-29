// Controller-Fenster: Geräte, manuelles Mixen, Kopfhörer-Cue, MIDI-Learn und die Anzeige beim
// Durchblättern der Bibliothek. Die eigentliche Logik steckt in app/controller/.
import { ControllerHost } from '../controller/host.js';
import { ACTIONS } from '../controller/actions.js';
import { deviceKey } from '../controller/profiles.js';
import { RANGES, FX_LIST } from '../controller/performer.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const TYPE_NAMES = { blend: 'Blend', cut: 'Schnitt', filter: 'Filter-Blend', echo: 'Echo-Out', loop: 'Loop-Ausstieg' };

export function initControllerPane({ engine, conductor, toast, getBrowse, onLearned }) {
  const host = new ControllerHost({ engine, conductor, toast, getBrowse, onLearned });
  const win = $('#ctlwin');
  const btn = $('#btn-controller');
  const body = $('#ctl-body');
  let audioOutputs = [];
  let learnDevice = '';
  let openGroup = null;

  const refreshOutputs = async () => {
    try {
      audioOutputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch {
      audioOutputs = [];
    }
  };

  function statusText() {
    const devs = host.hub.list().filter((d) => d.connected);
    if (host.hub.error) return { ok: false, text: host.hub.error };
    if (!host.hub.access) return { ok: false, text: 'Noch nicht verbunden – auf „Controller suchen“ klicken' };
    const known = devs.filter((d) => d.profile);
    if (known.length) return { ok: true, text: `${known.map((d) => d.profile.name).join(', ')} verbunden` };
    if (devs.length) return { ok: true, text: `${devs.length} MIDI-Gerät${devs.length > 1 ? 'e' : ''} gefunden – unten per MIDI-Learn belegen` };
    return { ok: false, text: 'Kein Controller gefunden – USB-Kabel prüfen (Pioneer-Treiber installiert? Anderes Programm blockiert das Gerät?)' };
  }

  function render() {
    const s = statusText();
    btn.classList.toggle('on', s.ok && host.hub.list().some((d) => d.profile || (host.store.bindings[deviceKey(d.name)] || []).length));
    if (win.hidden) return;
    const devs = host.hub.list();
    if (!learnDevice || !devs.some((d) => d.id === learnDevice)) learnDevice = devs[0]?.id || '';
    const manual = !conductor.automix;
    const cue = host.store.cue;
    const learning = host.learning;
    const groups = {};
    for (const a of Object.values(ACTIONS)) (groups[a.group] ||= []).push(a);
    const learnRows = Object.entries(groups).map(([g, list]) => `
      <details ${openGroup === g ? 'open' : ''} data-group="${esc(g)}"><summary>${esc(g)}</summary>
        ${list.map((a) => `
          <div class="ctl-act"><span>${esc(a.label)}</span>
            ${(a.perDeck ? [0, 1] : [null]).map((k) => `<button class="btn small ${learning && learning.action === a.id && learning.deck === k ? 'primary' : ''}" data-learn="${a.id}" data-deck="${k ?? ''}">${k === null ? 'Belegen' : `Deck ${k + 1}`}</button>`).join('')}
          </div>`).join('')}
      </details>`).join('');
    const fxSel = FX_LIST[host.performer.fx.sel];
    body.innerHTML = `
      <div class="ctl-status ${s.ok ? 'ok' : 'bad'}"><i></i><span>${esc(s.text)}</span>
        <button class="btn small" id="ctl-connect">${host.hub.access ? 'Neu suchen' : 'Controller suchen'}</button></div>
      ${devs.length ? `<ul class="ctl-devs">${devs.map((d) => `<li class="${d.connected ? '' : 'off'}">${esc(d.name)} <em>${d.profile ? esc(d.profile.name) + ' · fertig belegt' : 'eigene Belegung (MIDI-Learn)'}</em>${d.output ? '' : ' <em>(ohne LED-Ausgang)</em>'}</li>`).join('')}</ul>` : ''}

      <div class="ctl-sec">
        <label class="switch"><input type="checkbox" id="ctl-manual" ${manual ? 'checked' : ''} /><i></i><span>Manuell mixen (Automix aus)</span></label>
        <label class="switch"><input type="checkbox" id="ctl-auto" ${host.store.autoManual ? 'checked' : ''} /><i></i><span>Beim Verbinden automatisch</span></label>
        <label class="switch"><input type="checkbox" id="ctl-invert" ${host.store.tempoInvert ? 'checked' : ''} /><i></i><span>Tempo-Fader umkehren</span></label>
      </div>
      <p class="ctl-hint">Automix aus: Kanalfader, Crossfader, EQ, Filter und Trim des Controllers steuern die Decks direkt.
        Tracks lädst du mit dem Drehregler (Bibliothek durchblättern) und LOAD. Tempo-Bereich ±6/10/16/25 % mit Shift+Sync.
        Jog: Platte berühren = Scratch, Rand oder Drehen = Nudge, Shift+Jog = Suchlauf. Sampler-Pads = Effekte (Riser, Echo, Hall, Gate, Flanger, Filter). Beat-FX aktuell: <b>${esc(fxSel)}</b>.</p>

      <div class="ctl-sec col">
        <b>Kopfhörer (Cue/PFL)</b>
        <div class="ctl-row">
          <select class="sel" id="ctl-cue-mode">
            <option value="off" ${cue.mode === 'off' ? 'selected' : ''}>Aus</option>
            <option value="device" ${cue.mode === 'device' ? 'selected' : ''}>Zweites Ausgabegerät</option>
            <option value="multi" ${cue.mode === 'multi' ? 'selected' : ''}>Kanäle 3/4 der Soundkarte (Master = 1/2)</option>
          </select>
          <select class="sel" id="ctl-cue-dev" ${cue.mode === 'device' ? '' : 'hidden'}>
            <option value="">Standard-Gerät</option>
            ${audioOutputs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cue.deviceId ? 'selected' : ''}>${esc(d.label || d.deviceId)}</option>`).join('')}
          </select>
        </div>
        <div class="ctl-row"><span>Lautstärke</span><input type="range" id="ctl-headvol" min="0" max="1" step="0.01" value="${host.store.headVol}" /></div>
        <p class="ctl-hint">Mit „Kanäle 3/4“ geht der Master auf Ausgang 1/2 und der Kopfhörer auf 3/4 – nötig, wenn der Controller
          (z. B. DDJ-FLX4 mit ASIO-Treiber) Master und Kopfhörer getrennt anbietet. Sonst ein zweites Gerät wählen (leichte Verzögerung).</p>
      </div>

      <div class="ctl-sec col">
        <b>Zuletzt empfangen</b>
        <div class="ctl-mon">${host.recent.length ? host.recent.map(esc).join('<br>') : 'Noch nichts – Regler bewegen oder Taste drücken.'}</div>
      </div>

      <div class="ctl-sec col">
        <b>Dein Mixen → Automix lernt</b>
        ${host.recentMixes?.length
          ? host.recentMixes.map((m) => `<div class="ctl-mix">${esc(TYPE_NAMES[m.type] || m.type)} · ${m.overlapSec.toFixed(0)} s · ${esc(m.out)} → ${esc(m.in)}${m.bassSwap ? ' · Bass-Tausch' : ''}</div>`).join('')
          : '<p class="ctl-hint">Mix von Hand: jeder Übergang, den du fährst, wird ausgewertet (Technik, Länge, Ausstieg, Bass-Tausch, Tempo-Angleichung). Der Automix bevorzugt danach deinen Stil.</p>'}
      </div>

      <div class="ctl-sec col">
        <b>MIDI-Learn (Tasten und Regler selbst belegen)</b>
        <div class="ctl-row">
          <select class="sel" id="ctl-learn-dev">${devs.map((d) => `<option value="${esc(d.id)}" ${d.id === learnDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('') || '<option>kein Gerät</option>'}</select>
          <button class="btn small" id="ctl-reset" ${devs.length ? '' : 'disabled'}>Eigene Belegung löschen</button>
        </div>
        ${learning ? `<div class="ctl-learning">„${esc(ACTIONS[learning.action].label)}“${learning.deck !== null ? ` (Deck ${learning.deck + 1})` : ''}: jetzt die Taste drücken bzw. den Regler bewegen … <button class="btn small" id="ctl-learn-cancel">Abbrechen</button></div>` : ''}
        ${learnRows}
      </div>`;
    wire();
  }

  function wire() {
    $('#ctl-connect').onclick = async () => {
      await host.connect();
      await refreshOutputs();
      render();
    };
    $('#ctl-manual').onchange = (e) => {
      conductor.setAutomix(!e.target.checked);
      const box = $('#automix');
      if (box) box.checked = !e.target.checked;
      render();
    };
    $('#ctl-auto').onchange = (e) => host.set('autoManual', e.target.checked);
    $('#ctl-invert').onchange = (e) => host.set('tempoInvert', e.target.checked);
    $('#ctl-cue-mode').onchange = async (e) => {
      await host.setCueOutput(e.target.value, host.store.cue.deviceId);
      await refreshOutputs();
      render();
    };
    const dev = $('#ctl-cue-dev');
    if (dev) dev.onchange = () => host.setCueOutput('device', dev.value).then(render);
    $('#ctl-headvol').oninput = (e) => host.setHeadVolume(+e.target.value);
    $('#ctl-learn-dev').onchange = (e) => (learnDevice = e.target.value);
    $('#ctl-reset').onclick = () => {
      const d = host.hub.devices.get(learnDevice);
      if (d) host.clearUserBindings(d);
      toast('Eigene Belegung gelöscht');
    };
    const cancel = $('#ctl-learn-cancel');
    if (cancel) cancel.onclick = () => host.cancelLearn();
    for (const det of body.querySelectorAll('details[data-group]')) det.ontoggle = () => (openGroup = det.open ? det.dataset.group : openGroup === det.dataset.group ? null : openGroup);
    for (const b of body.querySelectorAll('[data-learn]')) {
      b.onclick = () => {
        if (!host.hub.devices.size) return toast('Erst einen Controller anschließen und „Controller suchen“ drücken');
        host.startLearn(b.dataset.learn, b.dataset.deck === '' ? null : +b.dataset.deck);
      };
    }
  }

  // Bibliothek durchblättern (Drehregler am Gerät): Liste unten einblenden
  const browseBox = $('#ctl-browse');
  let hideTimer = null;
  host.performer.addEventListener('browse', (e) => {
    const { label, index, count, tracks } = e.detail;
    if (!count) {
      browseBox.hidden = true;
      return;
    }
    const from = Math.max(0, Math.min(index - 3, count - 8));
    const rows = tracks.slice(from, from + 8).map((t, k) => {
      const a = t.analysis;
      return `<div class="ctl-brow ${from + k === index ? 'sel' : ''}"><span class="t">${esc(t.title)}</span><span class="a">${esc(t.artist || '')}</span><span class="n">${a ? a.bpm.toFixed(0) : ''}</span><span class="n">${esc(a?.key?.camelot || '')}</span></div>`;
    }).join('');
    browseBox.innerHTML = `<div class="ctl-bhead"><b>${esc(label)}</b><span>${index + 1} / ${count}</span><span class="ctl-hint">LOAD am Deck lädt den markierten Titel · Drehregler drücken wechselt die Quelle</span></div>${rows}`;
    browseBox.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (browseBox.hidden = true), 5000);
  });

  host.addEventListener('change', render);
  host.addEventListener('message', () => {
    if (!win.hidden) {
      const mon = body.querySelector('.ctl-mon');
      if (mon) mon.innerHTML = host.recent.map(esc).join('<br>') || '';
    }
  });
  conductor.addEventListener('automix', () => {
    const box = $('#automix');
    if (box) box.checked = conductor.automix;
    render();
  });

  btn.onclick = async () => {
    win.hidden = !win.hidden;
    if (!win.hidden) {
      await refreshOutputs();
      render();
    }
  };
  $('#ctl-close').onclick = () => (win.hidden = true);

  // Beim Start still nach schon angeschlossenen Geräten suchen (fragt nur, wenn nötig)
  host.connect().then(() => host.restore()).catch(() => {});
  return host;
}

export { RANGES };
