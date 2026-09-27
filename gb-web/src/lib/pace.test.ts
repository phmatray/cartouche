// node --test: the link cable and the library's live screen run at the Game Boy's 59.7 frames/s whatever the display rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GB_FPS, pacer } from './pace.ts';

/** Frames run per second on a display refreshing `hz` times a second. */
const perSecond = (hz: number) => {
  const due = pacer();
  let n = 0;
  for (let i = 1; i <= hz * 10; i++) n += due((i * 1000) / hz);
  return n / 10;
};

test('59.7 frames/s at 30, 60, 120 and 144 Hz', () => {
  for (const hz of [30, 60, 120, 144]) assert.ok(Math.abs(perSecond(hz) - GB_FPS) < 0.2, `${hz} Hz: ${perSecond(hz)}`);
});

test('a stall is dropped, not caught up', () => {
  const due = pacer();
  due(0);
  assert.equal(due(5000), 4);
  assert.ok(due(5016) <= 2);
});
