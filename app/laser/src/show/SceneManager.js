// ============================================================
// SceneManager.js – Effect Transitions & Layering
//
// Manages smooth transitions between effects and supports
// rendering several effects simultaneously (primary + N overlays -
// how many depends on the Autopilot escalation tier, see
// Choreographer._maxEffectLayers).
//
// Features:
//   - Crossfade transitions (opacity blend over N frames)
//   - Overlay compositing (further effects drawn on top, each its
//     own layer with its own fade)
//   - Parameter interpolation during transitions
//   - Scene history for undo/recall
// ============================================================

export class SceneManager {
  constructor() {
    // ── Current Scene ────────────────────────────────────
    this.primaryEffect   = null;
    // Overlay-Ebenen: [{ effectKey, opacity, target }, ...], in
    // Zeichenreihenfolge. overlayEffect/overlayOpacity bleiben als
    // Alias auf die erste Ebene erhalten - bestehende Konsumenten
    // (Debug-UI, AutoPunctuation) brauchen sich nicht zu ändern.
    this.overlayLayers   = [];

    // ── Transition State ─────────────────────────────────
    this._transitioning  = false;
    this._transitionFrom = null;   // Effect key being faded out
    this._transitionTo   = null;   // Effect key being faded in
    this._transProgress  = 1;      // 0–1
    this._transSpeed     = 0.06;   // Per-frame progress (0.06 ≈ ~17 frames ≈ 280ms)

    // ── Overlay ──────────────────────────────────────────
    this._overlayFadeRate = 0.25;  // Per-frame: schnell auf voll, kein Einschleichen

    // ── Scene History ────────────────────────────────────
    this._history     = [];
    this._maxHistory  = 20;

    // Repeated render failures are reported immediately and then throttled.
    // This keeps the console usable while preserving the full first error.
    this._renderErrors = new Map();
  }

  get overlayEffect() {
    return this.overlayLayers[0]?.effectKey ?? null;
  }

  get overlayOpacity() {
    return this.overlayLayers[0]?.opacity ?? 0;
  }

  /**
   * Request a transition to a new primary effect.
   * @param {string} effectKey – e.g. 'scanner', 'tunnel'
   * @param {boolean} instant – ignored (always instant now for sharpness)
   */
  setPrimaryEffect(effectKey, instant = true) {
    if (effectKey === this.primaryEffect) return;

    // Snap instantly (crossfading laser geometries looks muddy)
    this._transitioning  = false;
    this._transProgress  = 1;
    this.primaryEffect   = effectKey;
    this._pushHistory(effectKey);
  }

  /**
   * Set a single overlay effect (or null to disable). Convenience
   * wrapper around setOverlays() for callers that only know about one
   * overlay layer (e.g. AutoPunctuation's strobe punctuation).
   * @param {string|null} effectKey
   * @param {number} targetOpacity – 0–1
   */
  setOverlay(effectKey, targetOpacity = 1) {
    this.setOverlays(effectKey ? [effectKey] : [], targetOpacity);
  }

  /**
   * Set the full stack of overlay effects for this frame, in draw
   * order. Layers no longer requested fade out and get removed;
   * layers still requested keep their current opacity (no flicker on
   * reorder).
   * @param {string[]} effectKeys
   * @param {number} targetOpacity – 0–1, applied to newly-added layers
   */
  setOverlays(effectKeys = [], targetOpacity = 1) {
    const keys = (effectKeys || []).filter(Boolean);

    for (const layer of this.overlayLayers) {
      layer.target = keys.includes(layer.effectKey) ? targetOpacity : 0;
    }
    for (const key of keys) {
      if (this.overlayLayers.some((l) => l.effectKey === key)) continue;
      this.overlayLayers.push({ effectKey: key, opacity: 0, target: targetOpacity });
    }
  }

  /**
   * Call once per frame to advance transitions.
   */
  update() {
    // Primary transition logic removed; primary effects snap instantly.

    // ── Overlay opacity interpolation (per layer) ─────────
    for (const layer of this.overlayLayers) {
      const diff = layer.target - layer.opacity;
      layer.opacity += diff * this._overlayFadeRate;
    }

    // Clean up fully-faded overlays
    this.overlayLayers = this.overlayLayers.filter(
      (layer) => !(layer.target === 0 && layer.opacity < 0.01),
    );
  }

  /**
   * Render the current scene.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W – canvas width
   * @param {number} H – canvas height
   * @param {object} audioData – full pipeline data
   * @param {object} config – current config
   * @param {object} effects – map of effect name → effect instance
   */
  render(ctx, W, H, audioData, config, effects) {
    // ── Primary effect (snapped, no crossfade) ────────────
    const effect = effects[this.primaryEffect];
    if (effect) {
      ctx.globalAlpha = 1;
      this._renderEffect(this.primaryEffect, effect, ctx, W, H, audioData, config);
    }

    // ── Overlay effects, in draw order ─────────────────────
    for (const layer of this.overlayLayers) {
      if (!layer.effectKey || layer.opacity <= 0.01) continue;
      const overlay = effects[layer.effectKey];
      if (!overlay) continue;
      // Voll deckend zeichnen: ein Laser ist an oder aus.
      ctx.globalAlpha = 1;
      this._renderEffect(layer.effectKey, overlay, ctx, W, H, audioData, config);
    }
  }

  /**
   * Returns current rendering state.
   */
  getState() {
    return {
      primaryEffect:  this.primaryEffect,
      overlayEffect:  this.overlayEffect,
      overlayOpacity: this.overlayOpacity,
      overlayEffects: this.overlayLayers.map((l) => l.effectKey),
      transitioning:  this._transitioning,
      transProgress:  this._transProgress,
      transitionFrom: this._transitionFrom,
      transitionTo:   this._transitionTo,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  _renderEffect(effectName, effect, ctx, W, H, audioData, config) {
    try {
      effect.render(ctx, W, H, audioData, config);
      this._renderErrors.delete(effectName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack
        ? error.stack
        : '(no stack available)';
      const signature = `${message}\n${stack}`;
      const now = performance.now();
      const previous = this._renderErrors.get(effectName);
      const occurrences = (previous?.occurrences || 0) + 1;

      if (!previous || previous.signature !== signature || now - previous.lastLogged >= 2000) {
        console.error(
          `[SceneManager] Render error in effect "${effectName}"\n` +
          `Message: ${message}\n` +
          `Stack: ${stack}\n` +
          `Occurrences: ${occurrences}`,
          error,
        );
        this._renderErrors.set(effectName, { signature, lastLogged: now, occurrences });
      } else {
        previous.occurrences = occurrences;
      }
    }
  }

  _easeInOut(t) {
    // Smooth step for natural-looking crossfades
    return t * t * (3 - 2 * t);
  }

  _pushHistory(effectKey) {
    this._history.push({ effect: effectKey, time: performance.now() });
    if (this._history.length > this._maxHistory) this._history.shift();
  }
}
