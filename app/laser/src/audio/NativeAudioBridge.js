// ============================================================
// NativeAudioBridge.js – Native WASAPI-Loopback → MediaStream
//
// In der Tauri-Desktop-App läuft die eigentliche Systemton-
// Aufnahme in Rust (src-tauri/src/audio_capture.rs) über WASAPI.
// Diese Datei nimmt die gestreamten PCM-Chunks entgegen und baut
// daraus einen ganz normalen Web-Audio-MediaStream, damit die
// UNVERÄNDERTE AudioEngine.js (die einen MediaStream erwartet)
// weiter funktioniert wie zuvor mit getDisplayMedia().
//
// Läuft NUR innerhalb von Tauri (window.__TAURI__ vorhanden).
// Im normalen Browser wird stattdessen DeviceManager.getSystemAudioStream()
// (Screen-Share-Audio) als Fallback verwendet.
//
// WICHTIG (Fix für inkonsistente/falsche BPM-Erkennung): Die Daten
// laufen über einen tauri::ipc::Channel statt über app.emit()/listen().
// Tauris einfaches Event-System ist laut eigener Dokumentation NICHT
// für häufige/große Datenmengen gedacht (geteilter, JSON-serialisierter
// Bus mit jedem anderen UI-Event) – für einen kontinuierlichen PCM-
// Strom kann das zu Jitter/Mikro-Aussetzern führen. Für eine Beat-
// Erkennung, die auf lückenlose Timing-Kontinuität angewiesen ist,
// reicht das für sichtbar falsche/springende BPM-Werte. Channels sind
// der von Tauri empfohlene Mechanismus für genau diesen Fall.
// ============================================================

let _cachedContext = null;

export function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

/**
 * Startet die native Systemton-Aufnahme und liefert einen
 * MediaStream zurück, der live den Windows-Systemton enthält.
 * @returns {Promise<MediaStream>}
 */
export async function getNativeSystemAudioStream() {
  // WICHTIG: Kein `import ... from '@tauri-apps/api/core'` – dieses
  // Projekt hat KEINEN Bundler (kein Vite/Webpack). Ein bare
  // Module-Specifier wie '@tauri-apps/api/core' kann von der WebView
  // ohne Bundler/Import-Map nicht aufgelöst werden ("Failed to resolve
  // module specifier"). Tauri stellt seine API deshalb zusätzlich als
  // globales window.__TAURI__-Objekt bereit (aktiviert via
  // app.withGlobalTauri in tauri.conf.json) – genau für bundler-freie
  // Projekte wie dieses gedacht.
  if (!window.__TAURI__?.core) {
    throw new Error('window.__TAURI__ ist nicht verfügbar (withGlobalTauri fehlt?).');
  }
  const { invoke, Channel } = window.__TAURI__.core;

  const audioCtx = new AudioContext({ sampleRate: 48000 });
  _cachedContext = audioCtx;

  await audioCtx.audioWorklet.addModule('src/audio/native-audio-worklet.js');
  const workletNode = new AudioWorkletNode(audioCtx, 'native-audio-source', {
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const destination = audioCtx.createMediaStreamDestination();
  workletNode.connect(destination);

  // Ein einziger geordneter Channel für beide Nachrichtentypen (Format
  // kommt garantiert vor dem ersten Chunk an, siehe audio_capture.rs).
  const onChunk = new Channel();
  onChunk.onmessage = (message) => {
    if (message.type === 'format') {
      workletNode.port.postMessage({ type: 'format', channels: message.channels });
    } else if (message.type === 'chunk') {
      const samples = new Float32Array(message.samples);
      workletNode.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
    }
  };

  try {
    await invoke('start_system_audio_capture', { onChunk });
  } catch (err) {
    await audioCtx.close();
    throw new Error(`Native WASAPI-Aufnahme fehlgeschlagen: ${err}`);
  }

  const stream = destination.stream;
  // Aufräum-Funktion am Stream anhängen, damit DeviceManager/ControlPanel
  // beim Trennen auch den Rust-Thread + Worklet sauber stoppen kann.
  stream.__nativeCleanup = async () => {
    try {
      await invoke('stop_system_audio_capture');
    } catch {
      /* bereits gestoppt */
    }
    workletNode.disconnect();
    if (_cachedContext) {
      await _cachedContext.close();
      _cachedContext = null;
    }
  };

  return stream;
}
