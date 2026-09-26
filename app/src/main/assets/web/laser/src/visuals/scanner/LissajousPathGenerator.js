import { getPaletteColors } from '../../shared/Config.js';

const FREQ_PAIRS = [
  [1, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5],
  [5, 6], [2, 5], [1, 3], [3, 8], [5, 8], [4, 7],
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function seedPhase(seed, salt) {
  let value = ((Number(seed) >>> 0) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0x100000000) * Math.PI * 2;
}

/**
 * Produces deterministic normalized paths. Scene time and seed replace the
 * previous mutable per-renderer phase accumulator.
 */
export class LissajousPathGenerator {
  generate(audioData, config, scene = {}, runtime = {}) {
    const audio = audioData || {};
    const settings = config.lissajous;
    const show = config.show || {};
    const showTime = Math.max(0, Number(scene.showTime) || 0);
    const seed = Number(scene.seed) >>> 0;
    const speed = Math.max(0, config.speed || 0);
    const sensitivity = Math.max(0, config.sensitivity || 0);
    const colors = getPaletteColors(config.palette, config.customColor);
    const sampleScale = clamp(Number(runtime.geometryScale) || 1, 0.35, 1);
    const beatCount = Number.isFinite(audio.beatCount) ? Math.max(0, audio.beatCount) : 0;
    const pairIndex = settings.beatSnap
      ? (2 + beatCount) % FREQ_PAIRS.length
      : -1;
    const [baseX, baseY] = pairIndex >= 0
      ? FREQ_PAIRS[pairIndex]
      : [settings.freqX, settings.freqY];
    const freqX = baseX + (audio.bass || 0) * sensitivity * 0.4;
    const freqY = baseY + (audio.mid || 0) * sensitivity * 0.3;
    const phaseBase = seedPhase(seed, 0x4c495353);
    const phase = settings.autoPhase
      ? phaseBase + showTime * 0.24 * speed * (1 + (audio.bass || 0) * 0.5)
      : phaseBase;
    const colorStep = show.colorMode === 'beat'
      ? beatCount
      : show.colorMode === 'bar' ? Math.floor(beatCount / 4) : 0;
    const colorIndex = colorStep % colors.length;
    const radius = clamp(
      0.86 * (0.85 + (audio.amplitude || 0) * sensitivity * 0.2),
      0.4,
      0.96,
    );
    const paths = [this._makePath(
      freqX,
      freqY,
      phase,
      radius,
      colors[colorIndex],
      clamp(config.brightness || 0, 0, 1),
      Math.max(96, Math.round(384 * sampleScale)),
    )];

    if (audio.isBeat && colors.length > 1) {
      const [nextX, nextY] = FREQ_PAIRS[(Math.max(0, pairIndex) + 1) % FREQ_PAIRS.length];
      paths.push(this._makePath(
        nextX,
        nextY,
        phase + Math.PI * 0.5,
        radius * 0.7,
        colors[(colorIndex + 1) % colors.length],
        clamp((config.brightness || 0) * 0.5, 0, 1),
        Math.max(64, Math.round(256 * sampleScale)),
        Math.PI * 0.25,
      ));
    }

    return paths;
  }

  _makePath(freqX, freqY, phaseX, radius, color, intensity, samples, phaseY = 0) {
    const points = [];
    for (let index = 0; index < samples; index++) {
      const t = (index / samples) * Math.PI * 2;
      points.push({
        x: Math.sin(freqX * t + phaseX) * radius,
        y: Math.sin(freqY * t + phaseY) * radius,
      });
    }
    return { points, color, intensity, closed: true };
  }
}
