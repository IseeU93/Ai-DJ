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
   *
   * Früher wurde hart umgeschaltet ("Überblenden sieht matschig aus").
   * Ein Schnitt mitten in der Bewegung wirkt auf dem Schirm aber wie ein
   * Bildfehler - jetzt blendet der alte Effekt kurz aus (0,5 s), während
   * der neue schneller einblendet (0,3 s). Nur mit `instant` (Drop-
   * Einschlag, Start) wird geschnitten - dort soll es knallen.
   *
   * @param {string} effectKey – e.g. 'scanner', 'tunnel'
   * @param {boolean} instant – harter Schnitt statt Überblendung
   */
  setPrimaryEffect(effectKey, instant = false) {
    if (effectKey === this.primaryEffect) return;

    const previous = this.primaryEffect;
    this.primaryEffect   = effectKey;
    this._transitioning  = false;
    this._transProgress  = 1;
    this._pushHistory(effectKey);

    if (!previous || instant) {
      this._outgoing = null;
      this._primaryAlpha = 1;
      return;
    }
    // Der gerade sichtbare Stand blendet aus - auch wenn er selbst noch
    // am Einblenden war (kein Aufblitzen bei schnellen Wechseln).
    this._outgoing = { effectKey: previous, alpha: this._primaryAlpha ?? 1 };
    this._primaryAlpha = 0;
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
   * @param {number} dt – Sekunden seit dem letzten Bild (Standard 1/60)
   */
  update(dt = 1 / 60) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 1 / 60;

    // ── Überblendung des Haupteffekts ─────────────────────
    if ((this._primaryAlpha ?? 1) < 1) {
      this._primaryAlpha = Math.min(1, (this._primaryAlpha ?? 0) + step / 0.3);
    }
    if (this._outgoing) {
      this._outgoing.alpha -= step / 0.5;
      if (this._outgoing.alpha <= 0.01 || this._outgoing.effectKey === this.primaryEffect) this._outgoing = null;
    }

    // ── Overlay opacity interpolation (per layer) ─────────
    const rate = 1 - Math.pow(1 - this._overlayFadeRate, step * 60);
    for (const layer of this.overlayLayers) {
      const diff = layer.target - layer.opacity;
      layer.opacity += diff * rate;
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
    // ── Auslaufender Effekt (Überblendung) ─────────────────
    const out = this._outgoing;
    if (out && effects[out.effectKey]) {
      ctx.globalAlpha = Math.max(0, Math.min(1, out.alpha * out.alpha));
      this._renderEffect(out.effectKey, effects[out.effectKey], ctx, W, H, audioData, config);
    }

    // ── Primary effect ─────────────────────────────────────
    const effect = effects[this.primaryEffect];
    if (effect) {
      const a = this._primaryAlpha ?? 1;
      ctx.globalAlpha = a * (2 - a); // schnell sichtbar, weich angesetzt
      this._renderEffect(this.primaryEffect, effect, ctx, W, H, audioData, config);
    }

    // ── Overlay effects, in draw order ─────────────────────
    for (const layer of this.overlayLayers) {
      if (!layer.effectKey || layer.opacity <= 0.01) continue;
      const overlay = effects[layer.effectKey];
      if (!overlay) continue;
      // Voll deckend zeichnen: ein Laser ist an oder aus - nur beim
      // Ein-/Ausblenden der Ebene kurz weicher.
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      this._renderEffect(layer.effectKey, overlay, ctx, W, H, audioData, config);
    }
    ctx.globalAlpha = 1;
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
      transitioning:  Boolean(this._outgoing),
      transProgress:  this._primaryAlpha ?? 1,
      transitionFrom: this._outgoing?.effectKey ?? null,
      transitionTo:   this._outgoing ? this.primaryEffect : null,
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
