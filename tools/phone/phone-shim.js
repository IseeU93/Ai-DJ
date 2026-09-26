// Handy-Hülle für den Selbst-Modus der Android-App: ersetzt die PC-Befehle (Tauri) durch die
// Android-Brücke. Wird von tools/phone.mjs vor alle anderen Skripte in index.html gesetzt.
//   - Dateien:     /scan/<Ordner>  und  /fs/<Datei>   (liefert die App, nur im Musik-Ordner)
//   - Internet:    /net/<URL>                          (nur Genre-Nachschlagen, wie am PC)
//   - Companion:   Status/Ereignisse/Abgleich gehen direkt an die App (AutomixNative)
(function () {
  const native = window.AutomixNative;
  if (!native) return; // im normalen Browser nichts tun
  window.__AUTOMIX_PHONE__ = true;
  const root = native.musicRoot();
  const enc = encodeURIComponent;

  // Beim ersten Start: Musik-Ordner des Handys laden, Autopilot an
  try {
    const s = JSON.parse(localStorage.getItem('automix.settings') || '{}');
    if (!s.folder) localStorage.setItem('automix.settings', JSON.stringify({ ...s, folder: root, autopilot: true }));
  } catch {
    /* egal */
  }

  const listeners = [];
  window.__automixCmd = (json) => {
    for (const cb of listeners) {
      try {
        cb({ payload: json });
      } catch (err) {
        console.error('Befehl', err);
      }
    }
  };

  async function checked(res) {
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res;
  }

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        switch (cmd) {
          case 'pick_folder':
            return root;
          case 'scan_folder':
            return (await checked(await fetch(`/scan/${enc(args.path)}`))).json();
          case 'read_file':
            return (await checked(await fetch(`/fs/${enc(args.path)}`))).arrayBuffer();
          case 'web_get':
            return (await checked(await fetch(`/net/${enc(args.url)}`))).text();
          case 'companion_push':
            native.push(args.state);
            return null;
          case 'companion_event':
            native.event(args.event);
            return null;
          case 'companion_info':
            return { ip: 'Handy', port: 0, pin: '–', connected: false };
          case 'sync_set':
            native.syncSet(args.root || '', args.feedback || '[]');
            return null;
          case 'show_laser_window':
            return null;
          default:
            throw new Error(`auf dem Handy nicht verfügbar: ${cmd}`);
        }
      },
    },
    event: {
      listen: async (name, cb) => {
        if (name !== 'companion-cmd') return () => {};
        listeners.push(cb);
        native.listening(); // App kann jetzt Befehle schicken (z. B. Bewertungen vom PC)
        return () => listeners.splice(listeners.indexOf(cb), 1);
      },
    },
  };
})();
