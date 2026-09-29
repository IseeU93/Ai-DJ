import { DeckCore } from './deck-core.js';

const REPORT_EVERY = 6; // Blöcke (~16 ms bei 48 kHz)

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new DeckCore(sampleRate);
    this.blocks = 0;
    this.port.onmessage = (e) => this.onCommand(e.data);
  }

  onCommand(msg) {
    const c = this.core;
    switch (msg.type) {
      case 'load':
        c.load(msg.L, msg.R);
        this.port.postMessage({ type: 'loaded', id: msg.id, length: c.length });
        break;
      case 'play':
        c.schedulePlay(msg.frame ?? currentFrame, msg.real ?? null);
        break;
      case 'stop':
        c.scheduleStop(msg.frame ?? currentFrame);
        break;
      case 'rate':
        c.scheduleRate(msg.frame ?? currentFrame, msg.value, msg.ramp || 0);
        break;
      case 'segment':
        c.addSegment(msg.v, msg.real, msg.len || 0);
        break;
      case 'pitch':
        c.setPitch(msg.value);
        break;
      case 'seek':
        c.seek(msg.real);
        break;
      case 'keylock':
        c.setKeylock(!!msg.on);
        break;
      case 'bend':
        c.setBend(msg.value);
        break;
      case 'scratch':
        if (msg.on) c.scratchStart();
        else c.scratchEnd();
        break;
      case 'jog':
        c.scratchMove(msg.frames);
        break;
      case 'search':
        c.searchBy(msg.frames);
        break;
      case 'cancel':
        // geplante Aktionen eines abgebrochenen Übergangs verwerfen
        if (msg.transport) c.cancelTransport();
        if (msg.ratesAfter !== undefined) c.cancelRatesAfter(msg.ratesAfter);
        if (msg.segmentsAfter !== undefined) c.cancelSegmentsAfter(msg.segmentsAfter);
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    this.core.process(L, R, currentFrame, L.length);
    if (++this.blocks % REPORT_EVERY === 0) {
      this.port.postMessage({ type: 'status', ...this.core.status(currentFrame + L.length) });
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
