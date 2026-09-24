// ============================================================
// DeviceManager.js – Verwaltung der Audio-Eingabegeräte
// Mikrofon, System-Audio (Windows Loopback), AUX
// ============================================================

import { isTauriRuntime, getNativeSystemAudioStream } from './NativeAudioBridge.js';

export class DeviceManager {
  /**
   * Listet alle verfügbaren Audio-Eingabegeräte auf.
   * Fordert zuerst eine temporäre Mikrofon-Berechtigung an,
   * damit die Gerätenamen sichtbar sind (Browser-Sicherheit).
   * @returns {Promise<MediaDeviceInfo[]>}
   */
  async getAudioDevices() {
    // Temporären Stream öffnen, um Gerätenamen zu entblockieren
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      tmp.getTracks().forEach((t) => t.stop());
    } catch {
      // Berechtigung verweigert – trotzdem versuchen, Geräte aufzulisten
    }

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    return allDevices.filter((d) => d.kind === 'audioinput');
  }

  /**
   * Öffnet einen Mikrofon-/AUX-Stream.
   * @param {string|null} deviceId – null = Standard-Mikrofon
   * @returns {Promise<MediaStream>}
   */
  async getMicrophoneStream(deviceId = null) {
    const audioConstraints = deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  }

  /**
   * Öffnet einen Windows-Systemton-Stream.
   *
   * In der Desktop-App (Tauri) wird der Systemton DIREKT per
   * nativem WASAPI-Loopback abgegriffen (kein Screen-Share-Dialog
   * nötig). Im normalen Browser wird automatisch auf die alte
   * getDisplayMedia()-Methode zurückgefallen.
   * @returns {Promise<MediaStream>}
   */
  async getSystemAudioStream() {
    if (isTauriRuntime()) {
      return await getNativeSystemAudioStream();
    }
    return await this._getSystemAudioStreamBrowser();
  }

  /**
   * Legacy-Methode: Windows-Systemton via Screen-Share-Audio
   * (WASAPI Loopback über den Browser-Dialog). Wird als Fallback
   * verwendet, wenn die App NICHT innerhalb von Tauri läuft.
   * @returns {Promise<MediaStream>}
   */
  async _getSystemAudioStreamBrowser() {
    // getDisplayMedia benötigt video:true in manchen Browsern
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        sampleRate:       48000,
      },
      video: { width: 1, height: 1, frameRate: 1 }, // minimales Video
    });

    // Video-Tracks sofort stoppen
    displayStream.getVideoTracks().forEach((t) => t.stop());

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error(
        'Kein Audio-Track erhalten.\n' +
        'Bitte "Audio freigeben" / "Share audio" im Dialog aktivieren.'
      );
    }

    return new MediaStream(audioTracks);
  }

  /**
   * Prüft, ob der Browser getDisplayMedia mit Audio unterstützt.
   */
  static supportsSystemAudio() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }
}
