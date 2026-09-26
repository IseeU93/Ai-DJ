import { AudioSource } from './AudioSource.js';

export const SYNTHETIC_SIGNAL_TYPES = Object.freeze([
  'silence',
  'sine-40',
  'sine-60',
  'sine-100',
  'sine-120',
  'sine-180',
  'sine-300',
  'sine-1000',
  'sine-8000',
  'impulse-60',
  'impulse-100',
  'ramp-120',
  'sustained-120',
  'low-mid-broadband',
  'vocal-like',
  'broadband',
  'impulses',
  'ramp-up',
  'ramp-down',
  'rhythm-60',
  'rhythm-90',
  'rhythm-120',
  'rhythm-128',
  'rhythm-133',
  'rhythm-134',
  'rhythm-150',
  'rhythm-174',
  'rhythm-180',
  'rhythm-128-missing',
  'rhythm-128-false-transient',
  'rhythm-128-jitter',
  'rhythm-tempo-change',
  'rhythm-half-time',
  'rhythm-dnb-174',
  'rhythm-sparse-128',
  'rhythm-every-second-dominant',
  'rhythm-offbeat-128',
  'rhythm-breakdown-128',
  'rhythm-tempo-change-128-150',
  'rhythm-hardstyle-150-multipeak',
  'rhythm-true-low-90',
  'rhythm-ambiguous-90-180',
  'rhythm-soft-intro-128-150',
  'rhythm-breakdown-continuous-128',
  'rhythm-transition-same-128',
  'rhythm-70',
  'rhythm-76',
  'rhythm-100',
  'rhythm-true-low-76-vocal',
  'rhythm-double-152',
  'rhythm-dnb-174-sparse-return',
  'rhythm-change-174-87',
  'rhythm-weak-intro-128',
  'rhythm-songchange-weak-150',
  'rhythm-pause-resume-128',
]);

export const SYNTHETIC_RHYTHM_SIGNAL_TYPES = Object.freeze([
  'rhythm-60', 'rhythm-90', 'rhythm-120', 'rhythm-128', 'rhythm-133', 'rhythm-134', 'rhythm-150',
  'rhythm-174', 'rhythm-180', 'rhythm-128-missing',
  'rhythm-128-false-transient', 'rhythm-128-jitter',
  'rhythm-tempo-change', 'rhythm-half-time', 'rhythm-dnb-174',
  'rhythm-sparse-128', 'rhythm-every-second-dominant', 'rhythm-offbeat-128',
  'rhythm-breakdown-128', 'rhythm-tempo-change-128-150',
  'rhythm-hardstyle-150-multipeak', 'rhythm-true-low-90',
  'rhythm-ambiguous-90-180', 'rhythm-soft-intro-128-150',
  'rhythm-breakdown-continuous-128', 'rhythm-transition-same-128',
  'rhythm-70', 'rhythm-76', 'rhythm-100', 'rhythm-true-low-76-vocal',
  'rhythm-double-152', 'rhythm-dnb-174-sparse-return', 'rhythm-change-174-87',
  'rhythm-weak-intro-128', 'rhythm-songchange-weak-150', 'rhythm-pause-resume-128',
]);

const RHYTHM_BPM = Object.freeze({
  'rhythm-60': 60,
  'rhythm-90': 90,
  'rhythm-120': 120,
  'rhythm-128': 128,
  'rhythm-133': 133,
  'rhythm-134': 134,
  'rhythm-150': 150,
  'rhythm-174': 174,
  'rhythm-180': 180,
  'rhythm-128-missing': 128,
  'rhythm-128-false-transient': 128,
  'rhythm-128-jitter': 128,
  'rhythm-half-time': 150,
  'rhythm-dnb-174': 174,
  'rhythm-sparse-128': 128,
  'rhythm-every-second-dominant': 128,
  'rhythm-offbeat-128': 128,
  'rhythm-breakdown-128': 128,
  'rhythm-hardstyle-150-multipeak': 150,
  'rhythm-true-low-90': 90,
  'rhythm-ambiguous-90-180': 90,
  'rhythm-70': 70,
  'rhythm-76': 76,
  'rhythm-100': 100,
  'rhythm-true-low-76-vocal': 76,
  'rhythm-double-152': 152,
});

const SINE_FREQUENCIES = Object.freeze({
  'sine-40': 40,
  'sine-60': 60,
  'sine-100': 100,
  'sine-120': 120,
  'sine-180': 180,
  'sine-300': 300,
  'sine-1000': 1000,
  'sine-8000': 8000,
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const deterministicNoise = (sampleIndex) => {
  const value = Math.sin((sampleIndex + 1) * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};

/** Development-only deterministic PCM generator. It produces no audible output. */
export class SyntheticAudioSource extends AudioSource {
  constructor({ sampleRate = 48000, channelCount = 1, now } = {}) {
    super({ sourceId: 'synthetic-audio', sourceType: 'synthetic', now });
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.channelCount = Number.isFinite(channelCount) && channelCount >= 1 ? Math.floor(channelCount) : 1;
    this.trackLabel = 'Synthetische Testquelle';
    this.signalType = 'silence';
    this.sampleCursor = 0;
    this.audioContextState = 'not-required';
  }

  async start(signalType = this.signalType) {
    this._prepareStart();
    this.setSignal(signalType, { resetPhase: true });
    this.startedAt = this._now();
    this.lastFrameAt = this.startedAt;
    this._setState(this.signalType === 'silence' ? 'silent' : 'active');
    return this.getStatus();
  }

  setSignal(signalType, { resetPhase = true } = {}) {
    if (!SYNTHETIC_SIGNAL_TYPES.includes(signalType)) throw new Error(`Unknown synthetic signal: ${signalType}`);
    this.signalType = signalType;
    if (resetPhase) this.sampleCursor = 0;
    if (this.state === 'active' || this.state === 'silent') {
      this._setState(signalType === 'silence' ? 'silent' : 'active');
    }
    return this.signalType;
  }

  readFrame({ frameSize = 2048, timestamp = this._now() } = {}) {
    if (!['active', 'silent'].includes(this.state)) return null;
    const size = Math.max(32, Math.floor(Number(frameSize) || 2048));
    const samples = new Float32Array(size);
    const isRhythmSignal = SYNTHETIC_RHYTHM_SIGNAL_TYPES.includes(this.signalType);
    const frameEndSeconds = Math.max(0, (timestamp - this.startedAt) / 1000);
    for (let offset = 0; offset < size; offset++) {
      const sampleIndex = this.sampleCursor + offset;
      const seconds = isRhythmSignal
        ? frameEndSeconds + (offset - size + 1) / this.sampleRate
        : sampleIndex / this.sampleRate;
      samples[offset] = isRhythmSignal
        ? this._rhythmSampleAt(sampleIndex, seconds)
        : this._sampleAt(sampleIndex, seconds);
    }
    this.sampleCursor += size;
    this.lastFrameAt = timestamp;
    if (this.signalType !== 'silence') this.lastAudioAt = timestamp;
    return Object.freeze({
      timestamp,
      sampleRate: this.sampleRate,
      channelCount: this.channelCount,
      fftSize: size,
      spectrumScale: 'pcm',
      timeDomainSamples: samples,
      frequencyData: null,
    });
  }

  async stop() {
    if (this.state !== 'idle') this._setState('idle');
    return this.getStatus();
  }

  _sampleAt(sampleIndex, seconds) {
    if (this.signalType === 'silence') return 0;
    if (SINE_FREQUENCIES[this.signalType]) {
      return 0.7 * Math.sin(2 * Math.PI * SINE_FREQUENCIES[this.signalType] * seconds);
    }
    if (this.signalType === 'broadband') return deterministicNoise(sampleIndex) * 0.55;
    if (this.signalType === 'sustained-120') {
      return 0.7 * Math.sin(2 * Math.PI * 120 * seconds);
    }
    if (this.signalType === 'impulse-60' || this.signalType === 'impulse-100') {
      const frequency = this.signalType === 'impulse-60' ? 60 : 100;
      const periodSamples = Math.round(this.sampleRate * 0.75);
      const withinImpulse = sampleIndex % periodSamples;
      const impulseLength = Math.round(this.sampleRate * 0.07);
      if (withinImpulse >= impulseLength) return 0;
      const attackSamples = Math.max(1, Math.round(this.sampleRate * 0.004));
      const attack = Math.min(1, withinImpulse / attackSamples);
      const decay = Math.exp(-5 * withinImpulse / impulseLength);
      return 0.95 * attack * decay * Math.sin(2 * Math.PI * frequency * seconds);
    }
    if (this.signalType === 'ramp-120') {
      const envelope = clamp01(seconds / 8);
      return 0.75 * envelope * Math.sin(2 * Math.PI * 120 * seconds);
    }
    if (this.signalType === 'low-mid-broadband') {
      return 0.24 * (
        Math.sin(2 * Math.PI * 280 * seconds)
        + Math.sin(2 * Math.PI * 330 * seconds + 0.4)
        + Math.sin(2 * Math.PI * 410 * seconds + 1.1)
        + Math.sin(2 * Math.PI * 470 * seconds + 2.2)
      );
    }
    if (this.signalType === 'vocal-like') {
      const fundamental = 125;
      const fadeIn = clamp01(seconds / 0.6);
      const modulation = 0.78 + 0.14 * Math.sin(2 * Math.PI * 2.1 * seconds);
      const harmonic = (
        0.48 * Math.sin(2 * Math.PI * fundamental * seconds)
        + 0.26 * Math.sin(2 * Math.PI * fundamental * 2 * seconds + 0.2)
        + 0.14 * Math.sin(2 * Math.PI * fundamental * 3 * seconds + 0.7)
        + 0.08 * Math.sin(2 * Math.PI * fundamental * 4 * seconds + 1.2)
        + 0.04 * Math.sin(2 * Math.PI * fundamental * 6 * seconds + 0.5)
      );
      return 0.75 * fadeIn * modulation * harmonic;
    }
    if (this.signalType === 'impulses') {
      const withinImpulse = sampleIndex % Math.round(this.sampleRate * 0.5);
      const impulseLength = Math.round(this.sampleRate * 0.008);
      return withinImpulse < impulseLength ? 0.9 * (1 - withinImpulse / impulseLength) : 0;
    }
    const rampPhase = clamp01(seconds / 8);
    const envelope = this.signalType === 'ramp-up' ? rampPhase : 1 - rampPhase;
    return 0.75 * envelope * Math.sin(2 * Math.PI * 1000 * seconds);
  }

  _rhythmSampleAt(sampleIndex, seconds) {
    if (seconds < 0) return 0;
    if (this.signalType === 'rhythm-true-low-76-vocal') {
      const event = this._rhythmEventAt(seconds);
      const transient = this._renderRhythmEvent(sampleIndex, seconds, event);
      const pad = 0.075 * (
        Math.sin(2 * Math.PI * 190 * seconds) * 0.44
        + Math.sin(2 * Math.PI * 380 * seconds + 0.6) * 0.34
        + Math.sin(2 * Math.PI * 570 * seconds + 1.2) * 0.22
      ) * (0.82 + 0.18 * Math.sin(2 * Math.PI * 0.17 * seconds));
      return clamp01(Math.abs(transient + pad)) * Math.sign(transient + pad);
    }
    if (this.signalType === 'rhythm-weak-intro-128' && seconds < 8) {
      return this._weakIntroSample(sampleIndex, seconds, 0);
    }
    if (this.signalType === 'rhythm-songchange-weak-150' && seconds >= 10 && seconds < 20) {
      return this._weakIntroSample(sampleIndex, seconds - 10, 19);
    }
    if (this.signalType === 'rhythm-soft-intro-128-150' && seconds >= 10 && seconds < 18) {
      const fade = Math.min(1, (seconds - 10) / 1.5);
      return fade * 0.11 * (
        Math.sin(2 * Math.PI * 420 * seconds) * 0.55
        + Math.sin(2 * Math.PI * 690 * seconds + 0.7) * 0.30
        + Math.sin(2 * Math.PI * 980 * seconds + 1.4) * 0.15
      );
    }
    if (this.signalType === 'rhythm-transition-same-128' && seconds >= 10 && seconds < 16) {
      return 0.10 * (
        Math.sin(2 * Math.PI * 350 * seconds) * 0.62
        + Math.sin(2 * Math.PI * 760 * seconds + 0.8) * 0.38
      );
    }
    if (this.signalType === 'rhythm-breakdown-continuous-128' && seconds >= 10 && seconds < 20) {
      return 0.13 * (
        Math.sin(2 * Math.PI * 95 * seconds) * 0.42
        + Math.sin(2 * Math.PI * 380 * seconds + 0.4) * 0.36
        + Math.sin(2 * Math.PI * 760 * seconds + 1.1) * 0.22
      );
    }
    const event = this._rhythmEventAt(seconds);
    return this._renderRhythmEvent(sampleIndex, seconds, event);
  }

  _renderRhythmEvent(sampleIndex, seconds, event) {
    if (!event || event.within < 0 || event.within >= 0.065) return 0;
    const attack = Math.min(1, event.within / 0.0035);
    const decay = Math.exp(-5.5 * event.within / 0.065);
    const envelope = attack * decay * event.amplitude;
    const low = Math.sin(2 * Math.PI * 95 * seconds);
    const noise = deterministicNoise(Math.floor(seconds * this.sampleRate) + sampleIndex % 17);
    return envelope * (low * event.lowMix + noise * (1 - event.lowMix));
  }

  _weakIntroSample(sampleIndex, seconds, seedOffset = 0) {
    const pad = 0.085 * (
      Math.sin(2 * Math.PI * 240 * seconds) * 0.48
      + Math.sin(2 * Math.PI * 415 * seconds + 0.7) * 0.31
      + Math.sin(2 * Math.PI * 705 * seconds + 1.6) * 0.21
    ) * (0.78 + 0.22 * Math.sin(2 * Math.PI * 0.19 * seconds));
    const onsetTimes = [0.85, 2.15, 3.92, 5.08, 6.74, 7.52];
    const onset = onsetTimes.reduce((value, time, index) => {
      const within = seconds - time;
      if (within < 0 || within >= 0.055) return value;
      const envelope = Math.exp(-6 * within / 0.055) * (0.10 + (index % 3) * 0.025);
      return value + envelope * deterministicNoise(sampleIndex + seedOffset * 97 + index * 31);
    }, 0);
    return pad + onset;
  }

  _rhythmEventAt(seconds) {
    if (this.signalType === 'rhythm-dnb-174-sparse-return') {
      const event = this._constantRhythmEvent(seconds, 174);
      if (!event) return null;
      if (seconds < 12 || seconds >= 28) {
        return { ...event, amplitude: event.index % 2 === 0 ? 1 : 0.66, lowMix: event.index % 2 === 0 ? 0.78 : 0.24 };
      }
      if (event.index % 2 === 0) return { ...event, amplitude: 1, lowMix: 0.42 };
      if (event.index % 4 === 1) return null;
      return { ...event, amplitude: 0.20, lowMix: 0.06 };
    }
    if (this.signalType === 'rhythm-change-174-87') {
      if (seconds < 12) return this._constantRhythmEvent(seconds, 174);
      const event = this._constantRhythmEvent(seconds - 12, 87);
      return event ? { ...event, index: event.index + 35, lowMix: 0.58 } : null;
    }
    if (this.signalType === 'rhythm-weak-intro-128') {
      if (seconds < 8) return null;
      const event = this._constantRhythmEvent(seconds - 8, 128);
      return event ? { ...event, index: event.index + 18 } : null;
    }
    if (this.signalType === 'rhythm-songchange-weak-150') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 20) return null;
      const event = this._constantRhythmEvent(seconds - 20, 150);
      return event ? { ...event, index: event.index + 43 } : null;
    }
    if (this.signalType === 'rhythm-pause-resume-128') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 18) return null;
      const event = this._constantRhythmEvent(seconds - 18, 128);
      return event ? { ...event, index: event.index + 39 } : null;
    }
    if (this.signalType === 'rhythm-true-low-76-vocal') {
      const main = this._constantRhythmEvent(seconds, 76);
      const subdivision = this._subdivisionEvent(seconds, 76, 0.5);
      if (subdivision && [3, 7, 13].includes(subdivision.index % 16)) {
        return { ...subdivision, amplitude: 0.14 + (subdivision.index % 3) * 0.025, lowMix: 0.04 };
      }
      return main ? { ...main, amplitude: main.index % 4 === 2 ? 0.82 : 0.96, lowMix: 0.62 } : null;
    }
    if (this.signalType === 'rhythm-hardstyle-150-multipeak') {
      return this._hardstyleRhythmEvent(seconds, 150);
    }
    if (this.signalType === 'rhythm-true-low-90') {
      const main = this._constantRhythmEvent(seconds, 90);
      const eighth = this._subdivisionEvent(seconds, 90, 0.5);
      if (eighth && eighth.index % 4 !== 1) {
        return { ...eighth, amplitude: eighth.index % 4 === 3 ? 0.25 : 0.16, lowMix: 0.08 };
      }
      return main;
    }
    if (this.signalType === 'rhythm-ambiguous-90-180') {
      const event = this._constantRhythmEvent(seconds, 180);
      return event ? {
        ...event,
        amplitude: event.index % 2 === 0 ? 0.95 : (seconds < 7 ? 0.22 : 0.62),
        lowMix: event.index % 2 === 0 ? 0.74 : (seconds < 7 ? 0.08 : 0.48),
      } : null;
    }
    if (this.signalType === 'rhythm-soft-intro-128-150') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 18) return null;
      const event = this._constantRhythmEvent(seconds - 18, 150);
      return event ? { ...event, index: event.index + 38 } : null;
    }
    if (this.signalType === 'rhythm-breakdown-continuous-128') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 20) return null;
      const event = this._constantRhythmEvent(seconds - 20, 128);
      return event ? { ...event, index: event.index + 43 } : null;
    }
    if (this.signalType === 'rhythm-transition-same-128') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 16) return null;
      const event = this._constantRhythmEvent(seconds - 16, 128);
      return event ? { ...event, index: event.index + 34, lowMix: 0.34 } : null;
    }
    if (this.signalType === 'rhythm-tempo-change') {
      if (seconds < 8) return this._constantRhythmEvent(seconds, 120);
      const offset = seconds - 8;
      const event = this._constantRhythmEvent(offset, 128);
      return event ? { ...event, index: event.index + 16 } : null;
    }
    if (this.signalType === 'rhythm-tempo-change-128-150') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      const event = this._constantRhythmEvent(seconds - 10, 150);
      return event ? { ...event, index: event.index + 22 } : null;
    }
    if (this.signalType === 'rhythm-breakdown-128') {
      if (seconds < 10) return this._constantRhythmEvent(seconds, 128);
      if (seconds < 16) return null;
      const event = this._constantRhythmEvent(seconds - 16, 128);
      return event ? { ...event, index: event.index + 35 } : null;
    }
    const bpm = RHYTHM_BPM[this.signalType];
    if (!bpm) return null;
    if (['rhythm-128-false-transient', 'rhythm-offbeat-128'].includes(this.signalType)) {
      const period = 60 / bpm;
      const offset = this.signalType === 'rhythm-offbeat-128' ? 0.5 : 0.48;
      const extraIndex = Math.floor((seconds - period * offset) / period);
      const extraTime = extraIndex * period + period * offset;
      const shouldEmit = extraIndex >= 0
        && (this.signalType === 'rhythm-offbeat-128' ? extraIndex % 5 === 2 : extraIndex % 6 === 4);
      if (shouldEmit && seconds >= extraTime && seconds - extraTime < 0.065) {
        return {
          index: extraIndex, time: extraTime, within: seconds - extraTime,
          amplitude: 0.62, lowMix: 0.2,
        };
      }
    }
    const event = this._constantRhythmEvent(seconds, bpm, this.signalType === 'rhythm-128-jitter');
    if (!event) return null;
    if (this.signalType === 'rhythm-128-missing' && event.index % 8 === 7) return null;
    if (this.signalType === 'rhythm-sparse-128' && event.index % 2 === 1) return null;
    if (this.signalType === 'rhythm-every-second-dominant') {
      return { ...event, amplitude: event.index % 2 === 0 ? 1 : 0.28, lowMix: event.index % 2 === 0 ? 0.78 : 0.3 };
    }
    if (this.signalType === 'rhythm-half-time') {
      return { ...event, amplitude: event.index % 2 === 0 ? 1 : 0.46, lowMix: event.index % 2 === 0 ? 0.82 : 0.32 };
    }
    if (this.signalType === 'rhythm-dnb-174') {
      return { ...event, amplitude: event.index % 3 === 1 ? 0.72 : 1, lowMix: event.index % 2 === 0 ? 0.78 : 0.22 };
    }
    return event;
  }

  _constantRhythmEvent(seconds, bpm, jitter = false) {
    const period = 60 / bpm;
    let index = Math.floor(seconds / period);
    const eventTime = (eventIndex) => eventIndex * period
      + (jitter ? Math.sin((eventIndex + 1) * 2.17) * 0.012 : 0);
    let time = eventTime(index);
    if (time > seconds) {
      index--;
      time = eventTime(index);
    }
    if (index < 0) return null;
    return { index, time, within: seconds - time, amplitude: 0.95, lowMix: 0.72 };
  }

  _subdivisionEvent(seconds, bpm, fraction) {
    const period = 60 / bpm;
    const step = period * fraction;
    const index = Math.floor(seconds / step);
    if (index < 0 || index % Math.round(1 / fraction) === 0) return null;
    const time = index * step;
    return { index, time, within: seconds - time, amplitude: 0.25, lowMix: 0.08 };
  }

  _hardstyleRhythmEvent(seconds, bpm) {
    const period = 60 / bpm;
    const beatIndex = Math.floor(seconds / period);
    const offsets = [0, 0.052 + (beatIndex % 3) * 0.006, 0.106 - (beatIndex % 2) * 0.009];
    const amplitudes = beatIndex % 4 === 2 ? [0.82, 1, 0.72] : [1, 0.88, 0.68];
    for (let index = offsets.length - 1; index >= 0; index--) {
      const time = beatIndex * period + offsets[index];
      if (seconds >= time && seconds - time < 0.065) {
        return {
          index: beatIndex,
          time,
          within: seconds - time,
          amplitude: amplitudes[index],
          lowMix: index === 0 ? 0.72 : (index === 1 ? 0.48 : 0.82),
        };
      }
    }
    return null;
  }
}
