// Iterative Radix-2-FFT (in place) mit gecachten Twiddles pro Größe.
const cache = new Map();

function tables(n) {
  let t = cache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  t = { rev, cos, sin, win };
  cache.set(n, t);
  return t;
}

export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/**
 * STFT-Magnituden (zentrierte Frames, Hann-Fenster).
 * Ruft onFrame(t, mag) für jeden Frame auf; mag hat n/2+1 Einträge und wird wiederverwendet.
 */
export function stft(signal, n, hop, onFrame) {
  const { win } = tables(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const frames = Math.floor(signal.length / hop) + 1;
  const half = n / 2;
  for (let t = 0; t < frames; t++) {
    const start = t * hop - half;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < signal.length ? signal[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(t, mag);
  }
  return frames;
}
