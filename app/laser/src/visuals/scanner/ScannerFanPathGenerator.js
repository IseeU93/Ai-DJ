import { getPaletteColors } from '../../shared/Config.js';

const SNAP_PRESETS = [-70, -45, -20, 0, 20, 45, 70]
  .map((degrees) => degrees * Math.PI / 180);
const SNAP_SEQUENCE = [3, 5, 3, 1];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function seedPhase(seed, salt) {
  let value = ((Number(seed) >>> 0) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0x100000000) * Math.PI * 2;
}

/**
 * Produces normalized scanner and fan paths solely from scene state.
 * No Canvas, viewport or mutable animation clock is used.
 */
export class ScannerFanPathGenerator {
  generate(audioData, config, scene = {}, runtime = {}) {
    const audio = audioData || {};
    const settings = config.scanner;
    const show = config.show || {};
    const showTime = Math.max(0, Number(scene.showTime) || 0);
    const seed = Number(scene.seed) >>> 0;
    const phaseOffset = seedPhase(seed, 0x5343414e);
    const speed = Math.max(0, config.speed || 0);
    const sensitivity = Math.max(0, config.sensitivity || 0);
    const colors = getPaletteColors(config.palette, config.customColor);
    const beatCount = Number.isFinite(audio.beatCount) ? Math.max(0, audio.beatCount) : 0;
    const colorStep = show.colorMode === 'beat'
      ? beatCount
      : show.colorMode === 'bar' ? Math.floor(beatCount / 4) : 0;
    const colorIndex = colorStep % colors.length;
    const sweepRadians = clamp(settings.sweepWidth, 10, 360) * Math.PI / 180;
    const mode = settings.mode;
    const motionSpeed = Math.max(0.1, settings.sweepSpeed * speed);
    const measurePhase = Number.isFinite(audio.measurePhase)
      ? audio.measurePhase
      : (showTime * 0.25) % 1;

    let angle = 0;
    let crossAngle = Math.PI / 4;
    if (mode === 'sweep' || mode === 'cross') {
      const motionPhase = measurePhase * Math.PI * 2 * motionSpeed + phaseOffset;
      angle = Math.sin(motionPhase) * sweepRadians / 2;
      crossAngle = Math.cos(motionPhase) * sweepRadians / 2;
    } else if (mode === 'snap') {
      const beatIndex = Number.isFinite(audio.beatIndex) ? audio.beatIndex : 0;
      angle = SNAP_PRESETS[SNAP_SEQUENCE[Math.abs(beatIndex) % SNAP_SEQUENCE.length]];
    } else if (mode === 'fan') {
      angle = Math.sin(showTime * 0.3 + phaseOffset) * sweepRadians * 0.15;
    }

    const pathScale = clamp(Number(runtime.fanPathScale) || 1, 0.5, 1);
    const count = clamp(Math.round(settings.count * pathScale), 1, 8);
    const intensity = clamp(
      (0.65 + (audio.amplitude || 0) * sensitivity * 0.35) * config.brightness,
      0,
      1,
    );
    const paths = [];

    if (mode === 'fan') {
      for (let index = 0; index < count; index++) {
        const ratio = count > 1 ? index / (count - 1) : 0.5;
        const beamAngle = -sweepRadians / 2 + ratio * sweepRadians + angle;
        this._appendBeam(paths, beamAngle, colors[index % colors.length], intensity);
        if (show.mirror) this._appendBeam(paths, -beamAngle, colors[index % colors.length], intensity * 0.9);
      }
    } else if (mode === 'cross') {
      this._appendBeam(paths, angle, colors[colorIndex], intensity);
      this._appendBeam(paths, crossAngle, colors[(colorIndex + 1) % colors.length], intensity);
    } else {
      for (let index = 0; index < count; index++) {
        const offset = count > 1
          ? ((index / (count - 1)) - 0.5) * 0.1 * sweepRadians
          : 0;
        const beamAngle = angle + offset;
        const color = colors[(colorIndex + index) % colors.length];
        this._appendBeam(paths, beamAngle, color, intensity);
        if (show.mirror) this._appendBeam(paths, -beamAngle, color, intensity * 0.9);
      }
    }

    return paths;
  }

  _appendBeam(paths, angle, color, intensity) {
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const scale = 1 / Math.max(Math.abs(dx), Math.abs(dy), 0.0001);
    paths.push({
      points: [{ x: 0, y: 0 }, { x: dx * scale, y: dy * scale }],
      color,
      intensity,
      closed: false,
    });
  }
}
