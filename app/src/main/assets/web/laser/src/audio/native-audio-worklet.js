// ============================================================
// native-audio-worklet.js – AudioWorkletProcessor
//
// Empfängt f32-PCM-Chunks (interleaved, stereo) vom Haupt-Thread
// (die dort per Tauri-Event von der Rust-WASAPI-Aufnahme kommen)
// und schreibt sie in einen Ringpuffer, den der Audio-Rendering-
// Thread bei jedem process()-Aufruf ausliest. Das Ergebnis wird
// über einen zweiten Ausgang an eine MediaStreamAudioDestinationNode
// weitergereicht, sodass DeviceManager.js daraus einen ganz
// normalen MediaStream bauen kann – die bestehende AudioEngine.js
// muss dafür NICHT verändert werden.
// ============================================================

class NativeAudioSourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._channels = 2;
    // ~2s Ringpuffer bei 48kHz stereo, ausreichend Headroom
    this._capacity = 48000 * 2 * 2;
    this._ring = new Float32Array(this._capacity);
    this._writeIdx = 0;
    this._readIdx = 0;
    this._available = 0;

    // Vorpuffer: erst abspielen, wenn ~80ms Audio im Ring liegen.
    // Ohne das würde der allererste process()-Aufruf (und jeder kurze
    // Nachschub-Hänger durch IPC-Jitter) sofort in Stille laufen, was
    // beim Onset-/Tempo-Tracker als Phantom-Transiente ankommt und die
    // erkannte BPM verfälscht. 80ms Anlaufpuffer kostet praktisch
    // keine hörbare/spürbare Latenz, macht die Auslieferung aber
    // deutlich robuster gegenüber kurzen Verzögerungen.
    this._prebufferSamples = Math.round(48000 * 0.08) * this._channels;
    this._primed = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'format') {
        this._channels = msg.channels || 2;
        this._prebufferSamples = Math.round(48000 * 0.08) * this._channels;
        return;
      }
      if (msg.type === 'chunk') {
        this._write(msg.samples);
      }
    };
  }

  _write(samples) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      this._ring[this._writeIdx] = samples[i];
      this._writeIdx = (this._writeIdx + 1) % this._capacity;
      if (this._available < this._capacity) {
        this._available++;
      } else {
        // Ringpuffer voll -> ältesten Sample verwerfen (Reader nachziehen)
        this._readIdx = (this._readIdx + 1) % this._capacity;
      }
    }
    if (!this._primed && this._available >= this._prebufferSamples) {
      this._primed = true;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    const channels = this._channels;

    // Solange noch nicht vorgepuffert ist, bewusst Stille ausgeben statt
    // in einzelnen, schon eingetroffenen Samples zu "stottern" – ein
    // sauberer, kurzer Stille-Block zu Beginn ist für den Tempo-Tracker
    // harmlos (er wartet ohnehin auf den ersten echten Onset), viele
    // Mikro-Unterbrechungen mittendrin wären es nicht.
    if (!this._primed) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    for (let frame = 0; frame < frames; frame++) {
      for (let ch = 0; ch < output.length; ch++) {
        if (this._available >= channels) {
          const srcCh = Math.min(ch, channels - 1);
          const sample = this._ring[(this._readIdx + srcCh) % this._capacity];
          output[ch][frame] = sample;
        } else {
          output[ch][frame] = 0;
        }
      }
      if (this._available >= channels) {
        this._readIdx = (this._readIdx + channels) % this._capacity;
        this._available -= channels;
      } else if (this._primed) {
        // Puffer während des Betriebs leergelaufen (z.B. IPC-Hänger) ->
        // zurück in den Vorpuffer-Zustand statt weiter Stille-Samples
        // einzeln durchzureichen, die als Onset-Rauschen ankommen würden.
        this._primed = false;
      }
    }
    return true;
  }
}

registerProcessor('native-audio-source', NativeAudioSourceProcessor);
