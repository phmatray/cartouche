// node --test: the audio worklet (public/audio-worklet-processor.js) keeps the sound close behind the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Processor = { port: { onmessage: (e: { data: unknown }) => void }; process: (i: unknown, o: Float32Array[][]) => boolean };
let Worklet: new () => Processor;
const g = globalThis as unknown as Record<string, unknown>;
g.AudioWorkletProcessor = class { port = {}; };
g.registerProcessor = (_: string, c: new () => Processor) => { Worklet = c; };
await import(new URL('../../public/audio-worklet-processor.js', import.meta.url).href);

const FRAME = 768; // stereo frames per Game Boy frame (738 at 44.1 kHz; 6 whole 128-frame blocks here, as fast as played)
/** `frames` Game Boy frames of sound: left +1, right -1. */
const sound = (frames: number) => Float32Array.from({ length: frames * FRAME * 2 }, (_, i) => (i % 2 ? -1 : 1));
/** Plays `n` stereo frames; returns how many were sound (not silence), checking left and right never swap. */
function play(p: Processor, n: number) {
  let heard = 0;
  for (let done = 0; done < n; done += 128) {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    p.process([], out);
    out[0][0].forEach((l, i) => { assert.ok(l === -out[0][1][i], 'left and right in step'); if (l) heard++; });
  }
  return heard;
}

test('sound made while the device was not running yet does not delay the sound for good', () => {
  const p = new Worklet();
  // Two seconds of play before the device starts (resume() still pending, or waiting for a tap).
  for (let f = 0; f < 120; f++) p.port.onmessage({ data: { type: 'samples', samples: sound(1) } });
  // Then the game and the device run at the same rate: the queue ahead of the device stays what it was.
  for (let f = 0; f < 600; f++) { p.port.onmessage({ data: { type: 'samples', samples: sound(1) } }); play(p, FRAME); }
  // At most 93 ms (before: the writer had lapped the reader, leaving 232 ms queued for the rest of the session).
  const queued = play(p, 16384 * 2);
  assert.ok(queued <= 4096 + FRAME, `${queued} frames queued`);
});
