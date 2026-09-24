// ============================================================
// AutoPunctuation.js – Auto-Strobe & Auto-Blackout
//
// Automatische, musik-reaktive "Punktuierung" unabhängig von
// Autopilot/Choreographer – funktioniert auch im rein manuellen
// Modus (Effekt-Tabs von Hand ausgewählt). Nutzt dieselbe Phasen-
// Erkennung (intro/verse/build/drop/break/outro + dropImminent),
// die die Audio-Engine ohnehin schon für jeden Frame berechnet
// (data.energy, siehe src/audio/EnergyTracker.js) – bisher wurde
// das nur vom (standardmäßig ausgeschalteten) Choreographer
// genutzt, jetzt zusätzlich hier, unabhängig davon:
//
// - Auto-Strobe: aggressives Dauer-Strobing WÄHREND eines Drops
//   (jeder Kick blitzt), plus ein sanfteres Anspannungs-Strobing
//   während eines Build-ups mit dropImminent (die "Rampe" vor dem
//   Drop). Legt kurz den bestehenden Hot-Beams-Strobe-Effekt als
//   Overlay über den aktuell gewählten Effekt (config._overlayEffect,
//   derselbe Mechanismus wie beim Choreographer-Layering).
// - Auto-Blackout: EIN kurzer, dramatischer "Hit-to-Black"-Akzent
//   genau beim Einstieg in einen Drop (der Moment, in dem die
//   Anspannung sich entlädt), plus vereinzelte Akzente auf harte
//   Hits während eines Break/Breakdowns (sparsame, ruhigere
//   Abschnitte, in denen ein Blackout-Punch dramaturgisch wirkt).
//   Anders als Auto-Strobe bewusst SELTEN/einmalig, nicht dauerhaft.
//
// Fällt auf eine einfache "harter Kick"-Heuristik zurück, falls
// data.energy (aus welchem Grund auch immer) fehlt, damit die
// Funktion nicht komplett stumm bleibt, wenn die Phasen-Erkennung
// mal keine Daten liefert.
//
// Bewusst als reine, zustandsarme Klasse gebaut (nur Cooldown-
// Timestamps + letzte Phase als internen State) statt direkt in
// ControlPanel verdrahtet, damit die Trigger-Logik isoliert
// unit-testbar ist.
// ============================================================

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// Kandidaten für den Strobe-Overlay, absteigend bevorzugt. Hot Beams
// steht bewusst hinten: der Effekt kam vorher bei praktisch jedem
// Drop und war damit alles andere als eine Punktierung.
const STROBE_OVERLAY_CANDIDATES = ['chaosBlades', 'hotBeams'];

/**
 * Wählt einen Strobe-Overlay, der sich vom laufenden Effekt
 * unterscheidet - sonst blitzt der Effekt gegen sich selbst.
 */
export function pickStrobeOverlay(currentEffect, preferred = 'auto') {
  if (preferred && preferred !== 'auto') return preferred;
  const pool = STROBE_OVERLAY_CANDIDATES.filter((e) => e !== currentEffect);
  return pool[0] || STROBE_OVERLAY_CANDIDATES[0];
}

export class AutoPunctuation {
  constructor() {
    this._lastStrobeAt = -Infinity;
    this._lastBlackoutAt = -Infinity;
    this._strobeUntil = -Infinity;
    this._blackoutUntil = -Infinity;
    // Expliziter Zustand statt bei jedem Aufruf neu aus (now vs. *Until)
    // abgeleitet: sonst wird der aktiv->inaktiv-Übergang verpasst, wenn
    // zwischen zwei evaluate()-Aufrufen mehr Zeit als burstMs/flashMs
    // liegt (z.B. bei unregelmäßigem Polling) – strobeReleased/
    // blackoutReleased müssen trotzdem genau einmal feuern.
    this._strobeActive = false;
    this._blackoutActive = false;
    this._lastPhase = null;
  }

  /**
   * @param {object} data - ein Audio-Analyse-Frame. Erwartet idealerweise
   *   data.energy = { phase, dropImminent, trend, level } (siehe
   *   EnergyTracker.getSnapshot()), sowie isBeat/transients.kick.hit,
   *   bass, amplitude als Fallback-Heuristik.
   * @param {object} config - vollständige App-Config (liest
   *   config.autoStrobe / config.autoBlackout)
   * @param {number} now - Zeitstempel in ms (z.B. performance.now())
   * @returns {{
   *   strobeTriggered: boolean, blackoutTriggered: boolean,
   *   strobeActive: boolean, blackoutActive: boolean,
   *   strobeReleased: boolean, blackoutReleased: boolean,
   * }}
   */
  evaluate(data, config, now) {
    const strobeCfg = config?.autoStrobe || {};
    const blackoutCfg = config?.autoBlackout || {};

    const kickHit = Boolean(data?.transients?.kick?.hit ?? data?.isBeat);
    // "Punch" = kombinierte Bass+Amplitude-Stärke des aktuellen Frames.
    const punch = (Number(data?.bass) || 0) + (Number(data?.amplitude) || 0);

    const energy = data?.energy;
    const hasPhaseData = Boolean(energy && energy.phase);
    const phase = hasPhaseData ? energy.phase : null;
    const dropImminent = Boolean(energy?.dropImminent);

    const phaseChanged = hasPhaseData && phase !== this._lastPhase;
    const enteredDrop = phaseChanged && phase === 'drop';
    if (hasPhaseData) this._lastPhase = phase;

    // "War aktiv" VOR dem Schließen abgelaufener Bursts festhalten,
    // damit der Übergang aktiv->inaktiv korrekt einmalig erkannt wird.
    const wasStrobeActive = this._strobeActive;
    const wasBlackoutActive = this._blackoutActive;

    if (this._strobeActive && now >= this._strobeUntil) this._strobeActive = false;
    if (this._blackoutActive && now >= this._blackoutUntil) this._blackoutActive = false;

    // ── Auto-Strobe ──────────────────────────────────────────
    let strobeTriggered = false;
    if (strobeCfg.enabled && kickHit) {
      const baseThreshold = 1.2 - clamp01(strobeCfg.sensitivity ?? 0.65) * 0.9;
      const baseMinGap = Number(strobeCfg.minGapMs) || 140;

      let eligible;
      let threshold = baseThreshold;
      let minGap = baseMinGap;

      if (hasPhaseData) {
        if (phase === 'drop') {
          // Im Drop: aggressiv, auf praktisch jeden Kick, deutlich
          // schnellere Wiederholrate als der konfigurierte Basiswert.
          eligible = true;
          threshold = baseThreshold * 0.7;
          minGap = Math.max(70, baseMinGap * 0.5);
        } else if (phase === 'build' && dropImminent) {
          // Anspannungsphase vor dem Drop: spürbar, aber zurück-
          // haltender als im Drop selbst.
          eligible = true;
          threshold = baseThreshold * 0.9;
        } else {
          eligible = false;
        }
      } else {
        // Fallback ohne Phasen-Daten: einfache Kick-Härte-Heuristik.
        eligible = true;
      }

      if (eligible && punch >= threshold && now - this._lastStrobeAt >= minGap) {
        this._lastStrobeAt = now;
        this._strobeUntil = now + (Number(strobeCfg.burstMs) || 220);
        this._strobeActive = true;
        strobeTriggered = true;
      }
    }

    // ── Auto-Blackout ────────────────────────────────────────
    let blackoutTriggered = false;
    if (blackoutCfg.enabled) {
      const minGap = Number(blackoutCfg.minGapMs) || 500;
      const baseThreshold = 1.2 - clamp01(blackoutCfg.sensitivity ?? 0.85) * 0.9;

      let eligible = false;
      if (hasPhaseData) {
        // Der dramatische Moment ist der EINSTIEG in den Drop (Hit-to-
        // Black direkt am Übergang), nicht jeder einzelne Kick während
        // des laufenden Drops (dafür ist Auto-Strobe da) - und
        // vereinzelte harte Hits in einem Break/Breakdown.
        eligible = enteredDrop || (phase === 'break' && kickHit);
      } else {
        // Fallback ohne Phasen-Daten: alte Heuristik (harter Kick +
        // deutlich steigender energyTrend = "es baut sich was auf").
        const energyTrend = Number(data?.energyTrend) || 0;
        eligible = kickHit && punch >= baseThreshold && energyTrend > 0.5;
      }

      if (eligible && now - this._lastBlackoutAt >= minGap) {
        this._lastBlackoutAt = now;
        this._blackoutUntil = now + (Number(blackoutCfg.flashMs) || 90);
        this._blackoutActive = true;
        blackoutTriggered = true;
      }
    }

    return {
      strobeTriggered,
      strobeOverlayEffect: pickStrobeOverlay(config?.effect, strobeCfg.overlayEffect),
      blackoutTriggered,
      strobeActive: this._strobeActive,
      blackoutActive: this._blackoutActive,
      strobeReleased: wasStrobeActive && !this._strobeActive,
      blackoutReleased: wasBlackoutActive && !this._blackoutActive,
    };
  }
}
