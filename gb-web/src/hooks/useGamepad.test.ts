// node --test: a gamepad that disconnects mid-press lets go of what it held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldBy } from './useGamepad.ts';

test('buttons and stick still held, per player', () => {
  // Player 1: D-pad Right (15) held, A (0) released, Triangle (3, fullscreen) is no game button.
  // Player 2: Start (9); stick pushed left on player 1 and down on player 2, in the dead zone on X for player 2.
  const held = heldBy({ 15: true, 0: false, 3: true, '1:9': true }, { leftX: -0.9, leftY: 0.2, '1:leftY': 0.8, '1:leftX': 0.3 });
  assert.deepEqual(held.sort(), [[3, 1], [4, 0], [5, 0], [7, 1]].sort());
});

test('nothing held, nothing released', () => {
  assert.deepEqual(heldBy({}, {}), []);
});
