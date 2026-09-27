// node --test: the audio device runs only while wanted (game running, page shown), and comes back from iOS's 'interrupted'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from './AudioEngine.ts';

function fakeContext(state: string) {
  const calls: string[] = [];
  const ctx = {
    state,
    async resume() { calls.push('resume'); ctx.state = 'running'; },
    async suspend() { calls.push('suspend'); ctx.state = 'suspended'; },
  };
  return { ctx, calls };
}

function engineWith(state: string) {
  const engine = new AudioEngine();
  const fake = fakeContext(state);
  (engine as unknown as { context: unknown }).context = fake.ctx;
  return { engine, ...fake };
}

test('pausing suspends a running context, playing resumes it', async () => {
  const { engine, ctx, calls } = engineWith('running');
  await engine.setWanted(false);
  assert.equal(ctx.state, 'suspended');
  await engine.setWanted(false); // already suspended: nothing more
  await engine.setWanted(true);
  assert.equal(ctx.state, 'running');
  assert.deepEqual(calls, ['suspend', 'resume']);
});

test("a wanted context comes back from iOS's 'interrupted'", async () => {
  const { engine, ctx } = engineWith('interrupted');
  await engine.setWanted(true);
  assert.equal(ctx.state, 'running');
});

test('a closed context, or none yet, is left alone', async () => {
  const { engine, calls } = engineWith('closed');
  await engine.setWanted(true);
  await engine.setWanted(false);
  assert.deepEqual(calls, []);
  await new AudioEngine().setWanted(true); // before init(): no throw
});
