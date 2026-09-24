import { AudioSource } from './AudioSource.js';

const DEFAULT_FFT_SIZE = 2048;
const SILENCE_RMS = 0.0005;

const errorState = (error) => {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return { state: 'denied', code: 'permission-denied' };
  }
  if (error?.name === 'NotFoundError' || error?.name === 'NotSupportedError') {
    return { state: 'unavailable', code: 'capture-unavailable' };
  }
  return { state: 'error', code: error?.name || 'capture-error' };
};

const rmsOf = (samples) => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

/**
 * Development-only system-audio provider based on browser screen capture.
 * It never connects its analysis graph to AudioContext.destination. The final
 * Windows party runtime is expected to provide a native WASAPI-loopback source
 * behind the same AudioSource contract.
 */
export class BrowserSystemAudioSource extends AudioSource {
  constructor({
    mediaDevices = globalThis.navigator?.mediaDevices,
    AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    MediaStreamClass = globalThis.MediaStream,
    now,
    fftSize = DEFAULT_FFT_SIZE,
  } = {}) {
    super({ sourceId: 'browser-system-audio', sourceType: 'browser-system-audio', now });
    this.mediaDevices = mediaDevices;
    this.AudioContextClass = AudioContextClass;
    this.MediaStreamClass = MediaStreamClass;
    this.fftSize = fftSize;
    this.captureStream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.analyserNode = null;
    this.audioTrack = null;
    this._trackEndedHandler = () => this._handleTrackEnded();
  }

  static isSupported(mediaDevices = globalThis.navigator?.mediaDevices) {
    return typeof mediaDevices?.getDisplayMedia === 'function';
  }

  async start() {
    await this._release(true);
    this._prepareStart();
    if (!BrowserSystemAudioSource.isSupported(this.mediaDevices) || !this.AudioContextClass) {
      return this._setError('unavailable', 'browser-api-unavailable', 'Browser-Systemaudio ist in dieser Umgebung nicht verfügbar.');
    }

    this._setState('requesting-permission');
    try {
      // This method must be called directly from the visible UI click handler.
      const stream = await this.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.captureStream = stream;
      this._setState('connecting');
      const audioTracks = stream.getAudioTracks?.() || [];
      if (!audioTracks.length) {
        await this._release(false);
        return this._setError('unavailable', 'missing-audio-track', 'Keine Audiofreigabe empfangen. Im Freigabedialog muss Systemaudio aktiviert sein.');
      }

      this.audioTrack = audioTracks[0];
      if (this.audioTrack.readyState && this.audioTrack.readyState !== 'live') {
        await this._release(false);
        return this._setError('unavailable', 'audio-track-not-live', 'Der freigegebene Audiotrack ist nicht aktiv.');
      }
      this.audioTrack.addEventListener?.('ended', this._trackEndedHandler, { once: true });

      this.mediaStream = this.MediaStreamClass
        ? new this.MediaStreamClass(audioTracks)
        : stream;
      this.audioContext = new this.AudioContextClass();
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = this.fftSize;
      this.analyserNode.smoothingTimeConstant = 0;
      this.sourceNode.connect(this.analyserNode);
      // Deliberately no analyser/source connection to audioContext.destination.

      const settings = this.audioTrack.getSettings?.() || {};
      this.sampleRate = Number(settings.sampleRate) || Number(this.audioContext.sampleRate) || 0;
      this.channelCount = Number(settings.channelCount) || 1;
      this.trackLabel = this.audioTrack.label || 'Freigegebenes Systemaudio';
      this.audioContextState = this.audioContext.state || 'unknown';
      this.startedAt = this._now();
      this._setState('silent');

      // Video is never displayed, stored or analysed. It is stopped after the
      // independent audio-only MediaStream has been constructed.
      for (const videoTrack of stream.getVideoTracks?.() || []) videoTrack.stop();
      return this.getStatus();
    } catch (error) {
      await this._release(false);
      const mapped = errorState(error);
      return this._setError(mapped.state, mapped.code, error?.message || 'Systemaudio konnte nicht verbunden werden.');
    }
  }

  readFrame(timestamp = this._now()) {
    if (!this.analyserNode || !['active', 'silent'].includes(this.state)) return null;
    const timeDomainSamples = new Float32Array(this.analyserNode.fftSize);
    const frequencyData = new Float32Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getFloatTimeDomainData(timeDomainSamples);
    this.analyserNode.getFloatFrequencyData(frequencyData);
    const rms = rmsOf(timeDomainSamples);
    this.lastFrameAt = timestamp;
    this.audioContextState = this.audioContext?.state || 'closed';
    if (rms > SILENCE_RMS) {
      this.lastAudioAt = timestamp;
      if (this.state !== 'active') this._setState('active');
    } else if (this.state !== 'silent') {
      this._setState('silent');
    }
    return Object.freeze({
      timestamp,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      fftSize: this.analyserNode.fftSize,
      spectrumScale: 'decibels',
      timeDomainSamples,
      frequencyData,
    });
  }

  async stop() {
    await this._release(true);
    return this.getStatus();
  }

  async _handleTrackEnded() {
    await this._release(false);
    if (this.state !== 'ended') this._setState('ended');
  }

  async _release(setIdle) {
    this.audioTrack?.removeEventListener?.('ended', this._trackEndedHandler);
    try { this.sourceNode?.disconnect(); } catch { /* already disconnected */ }
    const tracks = new Set([
      ...(this.captureStream?.getTracks?.() || []),
      ...(this.mediaStream?.getTracks?.() || []),
    ]);
    for (const track of tracks) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { await this.audioContext.close(); } catch { /* already closed */ }
    }
    this.captureStream = null;
    this.mediaStream = null;
    this.audioTrack = null;
    this.sourceNode = null;
    this.analyserNode = null;
    this.audioContext = null;
    this.audioContextState = 'closed';
    if (setIdle && this.state !== 'idle') this._setState('idle');
  }
}
