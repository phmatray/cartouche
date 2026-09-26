class GameBoyAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringSize = 16384 * 2;
    this.ring = new Float32Array(this.ringSize);
    this.ringRead = 0;
    this.ringWrite = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'samples') {
        const samples = e.data.samples;
        for (let i = 0; i < samples.length; i++) {
          this.ring[this.ringWrite] = samples[i];
          this.ringWrite = (this.ringWrite + 1) % this.ringSize;
        }
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const left = output[0];
    const right = output[1];
    const frames = left.length;

    for (let i = 0; i < frames; i++) {
      if (this.ringRead !== this.ringWrite) {
        left[i] = this.ring[this.ringRead];
        this.ringRead = (this.ringRead + 1) % this.ringSize;
        right[i] = this.ring[this.ringRead];
        this.ringRead = (this.ringRead + 1) % this.ringSize;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('gameboy-audio-processor', GameBoyAudioProcessor);
