// Songtext-Erkennung (Whisper) mit Wort-Zeitstempeln – läuft lokal im Worker.
// Das Modell wird beim ersten Einsatz einmalig geladen und danach im Browser-Cache gehalten.
// Mit WebGPU (Grafikkarte) deutlich schneller; gibt es keine nutzbare Grafikkarte (oder scheitert
// sie), läuft es per WebAssembly auf der CPU – ohne dass man etwas einstellen muss.
import { pipeline, env } from '../vendor/transformers.min.js';

const MODEL = 'onnx-community/whisper-base_timestamped';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
// ein einziger CPU-Kern: läuft auch auf einem Laptop neben Wiedergabe und Lasershow ruhig mit
env.backends.onnx.wasm.numThreads = 1;

let asr = null;
let device = null;
let gpuBroken = false;

const progress = (p) => {
  if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
};

async function gpuUsable() {
  if (gpuBroken || !self.navigator?.gpu) return false;
  try {
    return !!(await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load() {
  if (asr) return asr;
  if (await gpuUsable()) {
    try {
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: progress,
      });
      device = 'webgpu';
      return asr;
    } catch (err) {
      console.warn('WebGPU nicht nutzbar, weiter mit WebAssembly:', err?.message || err);
      gpuBroken = true;
    }
  }
  asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: 'q8', progress_callback: progress });
  device = 'wasm';
  return asr;
}

async function transcribe(audio, language) {
  const model = await load();
  return model(audio, {
    return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: language || 'english', task: 'transcribe',
    // gegen Endlosschleifen erfundener Wörter (Whisper in Instrumentalteilen): mehr als ~120 Wörter
    // passen nicht in 30 s Gesang – so dauert kein Song ewig
    max_new_tokens: 192,
  });
}

self.onmessage = async (e) => {
  const { id, audio, language } = e.data;
  try {
    const t0 = performance.now();
    let out;
    try {
      out = await transcribe(audio, language);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      // Grafikkarte hat mitten drin versagt: einmal auf der CPU wiederholen
      console.warn('WebGPU-Fehler, wiederhole auf der CPU:', err?.message || err);
      gpuBroken = true;
      asr = null;
      out = await transcribe(audio, language);
    }
    const words = (out.chunks || [])
      .map((c) => ({ w: c.text.trim(), t: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((x) => x.w && Number.isFinite(x.t));
    self.postMessage({ type: 'result', id, words, device, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: String(err?.message || err) });
  }
};
