import { analyzeTrack } from './analyze.js';

self.onmessage = (e) => {
  const { id, L, R, sr, override } = e.data;
  try {
    const result = analyzeTrack(L, R, sr, override);
    const w = result.waveform;
    self.postMessage({ id, result }, [w.low.buffer, w.mid.buffer, w.high.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
