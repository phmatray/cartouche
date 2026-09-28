// The most sound queued ahead of the device, in floats (stereo pairs): 4096 frames, 93 ms. Past it (a stall the game
// made up in one go, a device that started late, the two clocks drifting apart over a long session) the oldest is
// dropped down to KEEP (2048 frames, 46 ms, more than a 30 Hz display's two frames): otherwise each hiccup added its
// delay to the sound for good, and once the queue passed the ring's size the writer lapped the reader.
const MAX_QUEUED = 4096 * 2;
const KEEP = 2048 * 2;

class GameBoyAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringSize = 16384 * 2;
    this.ring = new Float32Array(this.ringSize);
    this.ringRead = 0;
    this.ringWrite = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'samples') {
        // Only the newest MAX_QUEUED can survive the trim below: the ring never overflows.
        const samples = e.data.samples.subarray(Math.max(0, e.data.samples.length - MAX_QUEUED));
        for (let i = 0; i < samples.length; i++) {
          this.ring[this.ringWrite] = samples[i];
          this.ringWrite = (this.ringWrite + 1) % this.ringSize;
        }
        if (this.queued() > MAX_QUEUED) this.ringRead = (this.ringWrite - KEEP + this.ringSize) % this.ringSize;
      }
    };
  }

  /** Floats written and not played yet. */
  queued() {
    return (this.ringWrite - this.ringRead + this.ringSize) % this.ringSize;
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
