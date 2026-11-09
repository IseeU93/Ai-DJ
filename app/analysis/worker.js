import { analyzeTrack } from './analyze.js';
import { detectBeats, NN_SR } from './beatnet.js';

// Beat-Tracker-Netz (beatnet.js): einmal pro Worker geladen – mit Grafikkarte (WebGPU) schnell,
// sonst per WebAssembly auf einem CPU-Kern. Klappt beides nicht, analysiert der Worker wie bisher.
let session = null;
let ort = null;
let broken = false;

async function nnRunner() {
  if (broken) return null;
  if (!session) {
    try {
      ort = await import('../vendor/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      const model = await (await fetch(new URL('../models/beat_this.onnx', import.meta.url))).arrayBuffer();
      try {
        if (!self.navigator?.gpu || !(await self.navigator.gpu.requestAdapter())) throw new Error('keine GPU');
        session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] });
      } catch {
        session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      }
    } catch (err) {
      console.warn('Beat-Netz nicht verfügbar – eigene Rastererkennung', err);
      broken = true;
      return null;
    }
  }
  return async (chunk) => {
    const o = await session.run({ spect: new ort.Tensor('float32', chunk, [1, 1500, 128]) });
    return { beat: o.beat.data, downbeat: o.downbeat.data };
  };
}

self.onmessage = async (e) => {
  const { id, L, R, sr, override } = e.data;
  try {
    let nn = null;
    if (sr === NN_SR) {
      try {
        const run = await nnRunner();
        if (run) {
          const mono = new Float32Array(L.length);
          for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
          nn = await detectBeats(mono, run);
        }
      } catch (err) {
        console.warn('Beat-Netz fehlgeschlagen', err);
        nn = null;
      }
    }
    const result = analyzeTrack(L, R, sr, override, nn);
    const w = result.waveform;
    self.postMessage({ id, result }, [w.low.buffer, w.mid.buffer, w.high.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
