import { SCANNER_SNAPSHOT_SCHEMA_VERSION } from '../../shared/Version.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const CONTINUOUS_KEYS = [
  'amplitude', 'bass', 'mid', 'high', 'energyLevel', 'tension',
  'beatPhase', 'measurePhase', 'movementSpeed', 'movementIntensity',
];
const EVENT_KEYS = ['beat', 'virtualBeat', 'kick', 'snare', 'hihat', 'clap', 'sceneSwitch', 'blackout', 'freeze'];

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function interpolate(a, b, ratio) {
  const output = {};
  for (const key of CONTINUOUS_KEYS) {
    output[key] = finite(a?.[key]) + (finite(b?.[key]) - finite(a?.[key])) * ratio;
  }
  return output;
}

function eventList(data, extraEvents, sequence, showTime) {
  const flags = {
    beat: Boolean(data?.isBeat),
    virtualBeat: Boolean(data?.isVirtualBeat),
    kick: Boolean(data?.transients?.kick?.hit),
    snare: Boolean(data?.transients?.snare?.hit),
    hihat: Boolean(data?.transients?.hihat?.hit),
    clap: Boolean(data?.transients?.clap?.hit),
    ...extraEvents,
  };
  return EVENT_KEYS.filter((type) => flags[type]).map((type) => ({
    id: `${sequence}:${type}`,
    type,
    value: typeof flags[type] === 'object' ? flags[type].value : true,
    showTime,
  }));
}

export function createScannerAudioSnapshot(data, {
  sequence,
  capturedAtMs,
  analyzedAtMs = capturedAtMs,
  showTime,
  valid = true,
  confidence = null,
  events = {},
} = {}) {
  const seq = Math.max(0, Math.floor(finite(sequence)));
  const sharedShowTime = Math.max(0, finite(showTime));
  return {
    schemaVersion: SCANNER_SNAPSHOT_SCHEMA_VERSION,
    sequence: seq,
    capturedAtMs: finite(capturedAtMs),
    analyzedAtMs: finite(analyzedAtMs, finite(capturedAtMs)),
    showTime: sharedShowTime,
    valid: Boolean(valid),
    confidence: confidence === null ? null : clamp(finite(confidence), 0, 1),
    continuous: {
      amplitude: finite(data?.amplitude),
      bass: finite(data?.bass),
      mid: finite(data?.mid),
      high: finite(data?.high),
      energyLevel: finite(data?.energy?.level, finite(data?.amplitude)),
      tension: finite(data?.energy?.tension),
      beatPhase: finite(data?.beatPhase),
      measurePhase: finite(data?.measurePhase),
      movementSpeed: finite(data?.movementSpeed, 1),
      movementIntensity: finite(data?.movementIntensity, finite(data?.amplitude)),
    },
    discrete: {
      bpm: finite(data?.bpm),
      beatCount: Math.floor(finite(data?.beatCount)),
      beatIndex: Math.floor(finite(data?.beatIndex)),
      musicState: data?.musicState || 'unknown',
      energyPhase: data?.energy?.phase || null,
    },
    events: eventList(data, events, seq, sharedShowTime),
  };
}

export class AudioSnapshotBuffer {
  constructor({ maxSnapshots = 120, extrapolationMs = 120, fallbackMs = 500 } = {}) {
    this._maxSnapshots = Math.max(4, Math.floor(maxSnapshots));
    this._extrapolationSeconds = Math.max(0, extrapolationMs / 1000);
    this._fallbackSeconds = Math.max(this._extrapolationSeconds, fallbackMs / 1000);
    this._snapshots = [];
    this._pendingEvents = [];
    this._deliveredEvents = new Set();
    this._lastSequence = 0;
    this._diagnostics = {
      lateSnapshots: 0,
      droppedSnapshots: 0,
      outOfOrderSnapshots: 0,
      invalidSnapshots: 0,
      interpolationMode: 'empty',
    };
  }

  push(snapshot) {
    if (!this._isValidSnapshot(snapshot)) {
      this._diagnostics.invalidSnapshots++;
      return false;
    }
    if (snapshot.sequence <= this._lastSequence) {
      this._diagnostics.outOfOrderSnapshots++;
      this._diagnostics.droppedSnapshots++;
      return false;
    }
    if (this._lastSequence > 0 && snapshot.sequence > this._lastSequence + 1) {
      this._diagnostics.droppedSnapshots += snapshot.sequence - this._lastSequence - 1;
    }
    const latest = this._snapshots[this._snapshots.length - 1];
    if (latest && snapshot.showTime < latest.showTime) this._diagnostics.lateSnapshots++;
    this._lastSequence = snapshot.sequence;
    this._snapshots.push(structuredClone(snapshot));
    this._snapshots.sort((a, b) => a.showTime - b.showTime || a.sequence - b.sequence);
    if (this._snapshots.length > this._maxSnapshots) this._snapshots.shift();
    for (const event of snapshot.events || []) {
      if (!this._deliveredEvents.has(event.id)) this._pendingEvents.push({ ...event });
    }
    this._pendingEvents.sort((a, b) => a.showTime - b.showTime || a.id.localeCompare(b.id));
    return true;
  }

  sample(showTime, fallback = {}) {
    const time = Math.max(0, finite(showTime));
    if (this._snapshots.length === 0) {
      this._diagnostics.interpolationMode = 'empty';
      return { ...fallback, scannerSnapshotMode: 'empty', scannerEvents: [] };
    }
    let before = this._snapshots[0];
    let after = null;
    for (const snapshot of this._snapshots) {
      if (snapshot.showTime <= time) before = snapshot;
      if (snapshot.showTime >= time) { after = snapshot; break; }
    }
    if (!after) after = before;

    let continuous;
    let mode;
    const gap = time - before.showTime;
    if (after !== before && after.showTime > before.showTime) {
      continuous = interpolate(before.continuous, after.continuous,
        clamp((time - before.showTime) / (after.showTime - before.showTime), 0, 1));
      mode = 'interpolate';
    } else if (gap > 0 && gap <= this._extrapolationSeconds && this._snapshots.length >= 2) {
      const previous = this._snapshots[this._snapshots.length - 2];
      const dt = Math.max(1e-6, before.showTime - previous.showTime);
      continuous = {};
      for (const key of CONTINUOUS_KEYS) {
        const slope = (finite(before.continuous[key]) - finite(previous.continuous[key])) / dt;
        continuous[key] = finite(before.continuous[key]) + slope * gap;
      }
      mode = 'extrapolate';
    } else if (gap > this._fallbackSeconds) {
      const decay = Math.exp(-(gap - this._fallbackSeconds) / 0.35);
      continuous = {};
      for (const key of CONTINUOUS_KEYS) continuous[key] = finite(before.continuous[key]) * decay;
      continuous.movementSpeed = 1 + (finite(before.continuous.movementSpeed, 1) - 1) * decay;
      mode = 'fallback';
    } else {
      continuous = { ...before.continuous };
      mode = gap > 0 ? 'hold' : 'exact';
    }

    const events = [];
    this._pendingEvents = this._pendingEvents.filter((event) => {
      if (event.showTime > time) return true;
      if (!this._deliveredEvents.has(event.id)) {
        this._deliveredEvents.add(event.id);
        events.push(event);
      }
      return false;
    });
    this._diagnostics.interpolationMode = mode;
    const eventTypes = new Set(events.map((event) => event.type));
    return {
      ...fallback,
      amplitude: continuous.amplitude,
      bass: continuous.bass,
      mid: continuous.mid,
      high: continuous.high,
      beatPhase: continuous.beatPhase,
      measurePhase: continuous.measurePhase,
      movementSpeed: continuous.movementSpeed,
      movementIntensity: continuous.movementIntensity,
      bpm: before.discrete.bpm,
      beatCount: before.discrete.beatCount,
      beatIndex: before.discrete.beatIndex,
      musicState: before.discrete.musicState,
      isBeat: eventTypes.has('beat'),
      isVirtualBeat: eventTypes.has('virtualBeat'),
      transients: {
        kick: { hit: eventTypes.has('kick'), velocity: eventTypes.has('kick') ? 1 : 0 },
        snare: { hit: eventTypes.has('snare'), velocity: eventTypes.has('snare') ? 1 : 0 },
        hihat: { hit: eventTypes.has('hihat'), velocity: eventTypes.has('hihat') ? 1 : 0 },
        clap: { hit: eventTypes.has('clap'), velocity: eventTypes.has('clap') ? 1 : 0 },
      },
      energy: {
        ...(fallback.energy || {}),
        level: continuous.energyLevel,
        tension: continuous.tension,
        phase: before.discrete.energyPhase,
      },
      scannerEvents: events,
      scannerSnapshotMode: mode,
      scannerSnapshotSequence: before.sequence,
      scannerSnapshotValid: before.valid,
      scannerSnapshotConfidence: before.confidence,
    };
  }

  getDiagnostics() {
    return { ...this._diagnostics, bufferedSnapshots: this._snapshots.length };
  }

  _isValidSnapshot(snapshot) {
    return Boolean(snapshot && snapshot.valid !== false &&
      Number(snapshot.schemaVersion) === SCANNER_SNAPSHOT_SCHEMA_VERSION &&
      Number.isInteger(snapshot.sequence) && snapshot.sequence > 0 &&
      Number.isFinite(snapshot.showTime) && snapshot.continuous && snapshot.discrete);
  }
}
