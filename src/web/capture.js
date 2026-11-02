class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(320); this.offset = 0; }
  process(inputs) {
    for (const sample of inputs[0]?.[0] || []) {
      this.samples[this.offset++] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767);
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(320); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
