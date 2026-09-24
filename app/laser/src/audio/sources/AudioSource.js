export const AUDIO_SOURCE_STATES = Object.freeze([
  'idle',
  'requesting-permission',
  'connecting',
  'active',
  'silent',
  'ended',
  'denied',
  'unavailable',
  'error',
]);

export const AUDIO_SOURCE_TRANSITIONS = Object.freeze({
  idle: Object.freeze(['requesting-permission', 'connecting', 'active', 'silent', 'unavailable', 'error']),
  'requesting-permission': Object.freeze(['connecting', 'denied', 'unavailable', 'error', 'idle']),
  connecting: Object.freeze(['active', 'silent', 'ended', 'unavailable', 'error', 'idle']),
  active: Object.freeze(['silent', 'ended', 'error', 'idle']),
  silent: Object.freeze(['active', 'ended', 'error', 'idle']),
  ended: Object.freeze(['requesting-permission', 'connecting', 'active', 'silent', 'idle']),
  denied: Object.freeze(['requesting-permission', 'connecting', 'idle']),
  unavailable: Object.freeze(['requesting-permission', 'connecting', 'idle']),
  error: Object.freeze(['requesting-permission', 'connecting', 'idle']),
});

const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export class AudioSource {
  constructor({ sourceId, sourceType, now = () => performance.now() } = {}) {
    if (!sourceId || !sourceType) throw new Error('AudioSource requires sourceId and sourceType.');
    this.sourceId = String(sourceId);
    this.sourceType = String(sourceType);
    this.state = 'idle';
    this.mediaStream = null;
    this.sampleRate = 0;
    this.channelCount = 0;
    this.trackLabel = '';
    this.startedAt = 0;
    this.lastAudioAt = 0;
    this.lastFrameAt = 0;
    this.errorCode = '';
    this.errorMessage = '';
    this.audioContextState = 'unavailable';
    this._now = now;
  }

  async start() {
    throw new Error('AudioSource.start() must be implemented by a provider.');
  }

  async stop() {
    this._setState('idle');
    return this.getStatus();
  }

  getStatus() {
    return Object.freeze({
      sourceId: this.sourceId,
      sourceType: this.sourceType,
      state: this.state,
      sampleRate: finiteOr(this.sampleRate),
      channelCount: finiteOr(this.channelCount),
      trackLabel: this.trackLabel,
      startedAt: finiteOr(this.startedAt),
      lastAudioAt: finiteOr(this.lastAudioAt),
      lastFrameAt: finiteOr(this.lastFrameAt),
      audioContextState: this.audioContextState,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
    });
  }

  _prepareStart() {
    this.errorCode = '';
    this.errorMessage = '';
    this.startedAt = 0;
    this.lastAudioAt = 0;
    this.lastFrameAt = 0;
  }

  _setState(nextState) {
    if (!AUDIO_SOURCE_STATES.includes(nextState)) throw new Error(`Unknown AudioSource state: ${nextState}`);
    const allowed = AUDIO_SOURCE_TRANSITIONS[this.state] || [];
    if (nextState !== this.state && !allowed.includes(nextState)) {
      throw new Error(`Invalid AudioSource transition: ${this.state} -> ${nextState}`);
    }
    this.state = nextState;
    return this.state;
  }

  _setError(state, code, message) {
    this.errorCode = String(code || 'audio-source-error');
    this.errorMessage = String(message || 'Unknown audio source error.');
    this._setState(state);
    return this.getStatus();
  }
}
