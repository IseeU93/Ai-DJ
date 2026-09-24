// ============================================================
// TauriBridge.js – Kleine Hilfsfunktionen für Tauri-spezifisches
// Verhalten (Player-Fenster zeigen/fokussieren). Im normalen
// Browser (npm-freier Dev-Modus / GitHub Pages o.ä.) bleibt das
// bisherige window.open()-Verhalten unangetastet.
// ============================================================

export function isTauriRuntime() {
  return typeof window !== 'undefined'
    && Boolean(
      window.__TAURI_INTERNALS__
      || window.__TAURI__
      || window.location?.protocol === 'tauri:'
      || window.location?.hostname === 'tauri.localhost',
    );
}

/**
 * Zeigt das vordefinierte "player"-Fenster (siehe tauri.conf.json)
 * und fokussiert es. Die Funktion wirft bei einem nativen Fehler,
 * damit die Desktop-App nicht auf ein Browser-Popup zurückfällt.
 * @returns {Promise<void>}
 */
export async function showNativePlayerWindow() {
  if (!isTauriRuntime()) {
    throw new Error('Das native Player-Fenster ist nur in der Windows-App verfügbar.');
  }
  // WICHTIG: Kein `import ... from '@tauri-apps/api/core'` – dieses
  // Projekt hat KEINEN Bundler (kein Vite/Webpack), und ein bare
  // Module-Specifier wie '@tauri-apps/api/core' kann von der WebView
  // ohne Bundler/Import-Map grundsätzlich nicht aufgelöst werden
  // ("Failed to resolve module specifier"). Tauri stellt seine API
  // deshalb zusätzlich als globales window.__TAURI__-Objekt bereit
  // (aktiviert via app.withGlobalTauri in tauri.conf.json) – genau
  // für bundler-freie Projekte wie dieses gedacht.
  if (!window.__TAURI__?.core) {
    throw new Error('window.__TAURI__ ist nicht verfügbar (withGlobalTauri fehlt?).');
  }
  const { invoke } = window.__TAURI__.core;
  await invoke('show_player_window');
}
