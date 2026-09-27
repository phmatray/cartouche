// Opening the audio device blocks the main thread for a few hundred ms: done ahead, while idle, so it never lands
// in the first second of play. Created suspended (no gesture yet); the player's Play click resumes it.
let spare: AudioContext | null = null;
export function warmAudio() {
  if (spare || typeof AudioContext === 'undefined') return;
  try { spare = new AudioContext({ sampleRate: 44100 }); } catch { /* the player makes its own */ }
}

/**
 * Slowed play (½×): the game makes half the samples the device plays, so each stereo frame is played
 * `1 / speed` times over (an octave down at ½×) instead of the device running dry every other frame.
 * ponytail: plain repeats, no interpolation; enough for the ½× the player offers.
 */
export function stretch(samples: Float32Array, speed: number): Float32Array {
  const n = Math.round(1 / speed);
  if (n <= 1) return samples;
  const out = new Float32Array(samples.length * n);
  for (let i = 0, o = 0; i + 1 < samples.length; i += 2) {
    for (let r = 0; r < n; r++, o += 2) { out[o] = samples[i]; out[o + 1] = samples[i + 1]; }
  }
  return out;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  // One setup for every caller: taps arriving while the worklet loads must not each create an AudioContext.
  private ready: Promise<void> | null = null;

  init(): Promise<void> {
    this.ready ??= this.setup().catch((e) => { this.destroy(); throw e; });
    return this.ready;
  }

  private async setup(): Promise<void> {
    this.context = spare && spare.state !== 'closed' ? spare : new AudioContext({ sampleRate: 44100 });
    spare = null;
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = 0.5;
    this.gainNode.connect(this.context.destination);

    await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-worklet-processor.js`);
    this.workletNode = new AudioWorkletNode(this.context, 'gameboy-audio-processor', {
      outputChannelCount: [2],
    });
    this.workletNode.connect(this.gainNode);
  }

  /** null before init(). */
  getContextState(): AudioContextState | null {
    return this.context?.state ?? null;
  }

  // The audio device only runs while the game does and the page is shown: a paused game or a hidden tab suspends it,
  // so the audio thread stops rendering silence and the phone can idle.
  private wanted = false;

  /** Whether the sound should run (game running, page visible); applied at once when the context exists. */
  setWanted(on: boolean): Promise<void> {
    this.wanted = on;
    return this.apply();
  }

  /** Brings the context to the wanted state: resumed (also from iOS's 'interrupted') or suspended. */
  private async apply(): Promise<void> {
    const ctx = this.context;
    if (!ctx || ctx.state === 'closed') return;
    // Not only 'suspended': iOS parks the context as 'interrupted' after a call, Siri or the app going to the background.
    if (this.wanted && ctx.state !== 'running') await ctx.resume();
    else if (!this.wanted && ctx.state === 'running') await ctx.suspend();
  }

  feedSamples(samples: Float32Array): void {
    if (!this.workletNode || samples.length === 0) return;
    this.workletNode.port.postMessage({ type: 'samples', samples: new Float32Array(samples) });
  }

  setVolume(value: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  getVolume(): number {
    return this.gainNode?.gain.value ?? 0.5;
  }

  mute(): void {
    if (this.gainNode) this.gainNode.gain.value = 0;
  }

  unmute(volume = 0.5): void {
    if (this.gainNode) this.gainNode.gain.value = volume;
  }

  destroy(): void {
    this.workletNode?.disconnect();
    this.gainNode?.disconnect();
    this.context?.close();
    this.workletNode = null;
    this.gainNode = null;
    this.context = null;
    this.ready = null;
  }
}
