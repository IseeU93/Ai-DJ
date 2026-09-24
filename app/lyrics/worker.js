// Spracherkennung (Whisper) mit Wort-Zeitstempeln – läuft lokal im Worker.
// Das Modell wird beim ersten Einsatz einmalig geladen und danach im Browser-Cache gehalten.
import { pipeline, env } from '../vendor/transformers.min.js';

const MODEL = 'onnx-community/whisper-base_timestamped';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let asr = null;

async function load() {
  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      },
    });
  }
  return asr;
}

self.onmessage = async (e) => {
  const { id, audio, language } = e.data;
  try {
    const model = await load();
    const out = await model(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: language || 'german', task: 'transcribe' });
    const words = (out.chunks || [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.text && Number.isFinite(w.start));
    self.postMessage({ type: 'result', id, words });
  } catch (err) {
    self.postMessage({ type: 'result', id, error: String(err?.message || err) });
  }
};
