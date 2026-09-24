import { SCANNER_RUNTIME_SCHEMA_VERSION } from '../../shared/Version.js';

export const SCANNER_RUNTIME_STATE_SCHEMA_VERSION = SCANNER_RUNTIME_SCHEMA_VERSION;

const normalizeEffect = (effect, fallback = 'scanner') =>
  typeof effect === 'string' && effect.length > 0 ? effect : fallback;

export class ScannerEffectState {
  constructor({ selectedEffect = 'scanner', prototypeEnabled = false } = {}) {
    const effect = normalizeEffect(selectedEffect);
    this._listeners = new Set();
    this._state = {
      schemaVersion: SCANNER_RUNTIME_STATE_SCHEMA_VERSION,
      sequence: 0,
      generation: 0,
      selectedEffect: effect,
      activeEffect: effect,
      testActive: false,
      testPhase: null,
      source: 'manual',
      prototypeEnabled: Boolean(prototypeEnabled),
      resetToken: 0,
    };
  }

  subscribe(listener, { emitCurrent = true } = {}) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    if (emitCurrent) listener(this.snapshot());
    return () => this._listeners.delete(listener);
  }

  selectManual(effect) {
    const selectedEffect = normalizeEffect(effect, this._state.selectedEffect);
    if (selectedEffect === this._state.selectedEffect) return this.snapshot();
    if (this._state.testActive) {
      return this._advance({ selectedEffect });
    }
    const visibleChange = selectedEffect !== this._state.activeEffect;
    return this._advance({
      selectedEffect,
      activeEffect: selectedEffect,
      source: 'manual',
      testPhase: null,
      generation: this._state.generation + (visibleChange ? 1 : 0),
      resetToken: this._state.resetToken + (visibleChange ? 1 : 0),
    });
  }

  setPrototypeEnabled(enabled) {
    const prototypeEnabled = Boolean(enabled);
    if (prototypeEnabled === this._state.prototypeEnabled) return this.snapshot();
    return this._advance({ prototypeEnabled, resetToken: this._state.resetToken + 1 });
  }

  startTest(effect, phase = 0) {
    const activeEffect = normalizeEffect(effect, this._state.selectedEffect);
    if (this._state.testActive && this._state.activeEffect === activeEffect &&
        this._state.testPhase === phase) return this.snapshot();
    return this._transitionActive({
      activeEffect,
      source: 'load-test',
      testPhase: phase,
      testActive: true,
    });
  }

  updateTest(effect, phase = 0) {
    if (!this._state.testActive) return this.startTest(effect, phase);
    const activeEffect = normalizeEffect(effect, this._state.activeEffect);
    if (activeEffect === this._state.activeEffect && phase === this._state.testPhase) {
      return this.snapshot();
    }
    return this._transitionActive({
      activeEffect,
      source: 'load-test',
      testPhase: phase,
      testActive: true,
    });
  }

  stopTest() {
    if (!this._state.testActive) return this.snapshot();
    return this._transitionActive({
      activeEffect: this._state.selectedEffect,
      source: 'manual',
      testPhase: null,
      testActive: false,
    });
  }

  applySnapshot(snapshot) {
    if (Number(snapshot?.schemaVersion) !== SCANNER_RUNTIME_STATE_SCHEMA_VERSION) {
      return { accepted: false, reason: 'schema-mismatch', state: this.snapshot() };
    }
    const sequence = Number(snapshot.sequence);
    const generation = Number(snapshot.generation);
    if (!Number.isInteger(sequence) || !Number.isInteger(generation) ||
        sequence <= this._state.sequence || generation < this._state.generation) {
      return { accepted: false, reason: 'stale', state: this.snapshot() };
    }
    this._state = {
      schemaVersion: SCANNER_RUNTIME_STATE_SCHEMA_VERSION,
      sequence,
      generation,
      selectedEffect: normalizeEffect(snapshot.selectedEffect),
      activeEffect: normalizeEffect(snapshot.activeEffect),
      testActive: Boolean(snapshot.testActive),
      testPhase: snapshot.testPhase ?? null,
      source: snapshot.source === 'load-test' ? 'load-test' : 'manual',
      prototypeEnabled: Boolean(snapshot.prototypeEnabled),
      resetToken: Math.max(0, Number(snapshot.resetToken) || 0),
    };
    this._emit();
    return { accepted: true, reason: null, state: this.snapshot() };
  }

  snapshot() { return { ...this._state }; }

  _transitionActive({ activeEffect, source, testPhase, testActive }) {
    const visibleChange = activeEffect !== this._state.activeEffect ||
      source !== this._state.source || testPhase !== this._state.testPhase;
    return this._advance({
      activeEffect,
      source,
      testPhase,
      testActive,
      generation: this._state.generation + (visibleChange ? 1 : 0),
      resetToken: this._state.resetToken + (visibleChange ? 1 : 0),
    });
  }

  _advance(changes) {
    this._state = { ...this._state, ...changes, sequence: this._state.sequence + 1 };
    this._emit();
    return this.snapshot();
  }

  _emit() {
    const snapshot = this.snapshot();
    this._listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[ScannerEffectState] Listener failed', {
          message: error?.message || String(error),
          stack: error?.stack || 'no stack',
          sequence: snapshot.sequence,
          generation: snapshot.generation,
        });
      }
    });
  }
}
