import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from './governor.ts';

test('Governor steps down once per full window over budget, never up', () => {
  const g = new Governor(2, 4, 25, 10);
  for (let i = 0; i < 9; i++) assert.equal(g.gpu(9), false);
  assert.equal(g.gpu(9), true);
  assert.equal(g.level, 1);
  for (let i = 0; i < 30; i++) g.gpu(1);
  assert.equal(g.level, 1);
  // bursts do not count: the median decides
  for (let i = 0; i < 20; i++) g.gpu(i % 3 === 0 ? 40 : 2);
  assert.equal(g.level, 1);
  for (let i = 0; i < 10; i++) g.gpu(50);
  assert.equal(g.level, 0);
  assert.equal(g.gpu(50), false);
});

test('Governor frame timing ignores pauses', () => {
  const g = new Governor(1, 4, 25, 5);
  for (let i = 0; i < 20; i++) g.frame(500);
  assert.equal(g.level, 1);
  for (let i = 0; i < 5; i++) g.frame(40);
  assert.equal(g.level, 0);
});
