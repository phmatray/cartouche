// node --test: a thumb sliding across the touch controls holds what's under it, arm to arm and button to button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dpadAt, slide } from './touch-slide.ts';

test('the D-pad: arms, narrow diagonals, nothing in the middle', () => {
  assert.deepEqual(dpadAt(-60, 0, 150), ['Left']);
  assert.deepEqual(dpadAt(0, -60, 150), ['Up']);
  assert.deepEqual(dpadAt(60, 10, 150), ['Right']); // 10° off the axis: still the arm alone
  assert.deepEqual(dpadAt(-50, -50, 150), ['Up', 'Left']);
  assert.deepEqual(dpadAt(40, 50, 150), ['Down', 'Right']);
  assert.deepEqual(dpadAt(5, -5, 150), []);
  assert.deepEqual(dpadAt(-30, 0, 150), ['Left']); // the inner end of an arm
});

test('sliding from Left onto Up lets Left go, from B onto A swaps them, a second finger keeps its own', () => {
  const held = new Map<number, string[]>();
  assert.deepEqual(slide(held, 1, ['Left']), { press: ['Left'], release: [] });
  assert.deepEqual(slide(held, 1, ['Up', 'Left']), { press: ['Up'], release: [] });
  assert.deepEqual(slide(held, 1, ['Up']), { press: [], release: ['Left'] });
  assert.deepEqual(slide(held, 2, ['B']), { press: ['B'], release: [] });
  assert.deepEqual(slide(held, 2, ['A']), { press: ['A'], release: ['B'] });
  // Two fingers on the same button: it stays down until both have gone.
  slide(held, 3, ['A']);
  assert.deepEqual(slide(held, 2, []), { press: [], release: [] });
  assert.deepEqual(slide(held, 3, []), { press: [], release: ['A'] });
  assert.deepEqual(slide(held, 1, []), { press: [], release: ['Up'] });
  assert.equal(held.size, 0);
});
