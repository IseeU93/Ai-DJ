// ============================================================
// BroadcastBridge.js – Inter-Window Kommunikation
// Verbindet das Control Panel mit dem Player-Fenster.
// ============================================================

const CHANNEL_NAME = 'beamer-laser-show-v1';

export class BroadcastBridge {
  /**
   * @param {'master'|'slave'} role
   *   master = Control Panel (sendet Konfiguration + Audio-Daten)
   *   slave  = Player Fenster (empfängt und rendert)
   */
  constructor(role) {
    this.role = role;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this._listeners = new Map();

    this.channel.addEventListener('message', (event) => {
      const { type, data } = event.data;
      const handlers = this._listeners.get(type);
      if (handlers) {
        handlers.forEach((handler) => {
          try { handler(data); } catch (e) { console.error('[Bridge] Handler error:', e); }
        });
      }
    });
  }

  /**
   * Registriert einen Handler für einen Nachrichtentyp.
   * Gibt eine Unsubscribe-Funktion zurück.
   */
  on(type, handler) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(handler);
    return () => this._listeners.get(type)?.delete(handler);
  }

  /**
   * Sendet eine Nachricht an alle anderen Fenster desselben Origins.
   */
  send(type, data) {
    try {
      this.channel.postMessage({ type, data });
    } catch (e) {
      // Ignoriere Structured-Clone-Fehler (nicht-serialisierbare Objekte)
      console.warn('[Bridge] Send failed:', e.message);
    }
  }

  destroy() {
    this.channel.close();
    this._listeners.clear();
  }
}
