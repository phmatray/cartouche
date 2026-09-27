import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from './governor.ts';

test('Governor steps down once per full window over budget; the median decides', () => {
  const g = new Governor(2, 4, 10, 1000);
  for (let i = 0; i < 9; i++) assert.equal(g.sample(9), false);
  assert.equal(g.sample(9), true);
  assert.equal(g.level, 1);
  // bursts do not count
  for (let i = 0; i < 20; i++) g.sample(i % 3 === 0 ? 40 : 2);
  assert.equal(g.level, 1);
  for (let i = 0; i < 10; i++) g.sample(50);
  assert.equal(g.level, 0);
});

test('Governor tries one level up after a calm spell, and waits twice as long after each drop', () => {
  const g = new Governor(2, 4, 5, 20);
  for (let i = 0; i < 5; i++) g.sample(9);
  assert.equal(g.level, 1); // retry is now 40
  let n = 0;
  while (g.level === 1 && n < 100) { g.sample(1); n++; }
  assert.equal(g.level, 2);
  assert.equal(n, 4 + 40); // window fill, then 40 calm samples
  for (let i = 0; i < 5; i++) g.sample(9);
  assert.equal(g.level, 1); // retry is now 80
  n = 0;
  while (g.level === 1 && n < 200) { g.sample(1); n++; }
  assert.equal(n, 4 + 80);
});

test('Governor comes back from off through idle frames', () => {
  const g = new Governor(1, 4, 5, 10);
  for (let i = 0; i < 5; i++) g.sample(9);
  assert.equal(g.level, 0);
  let n = 0;
  while (g.level === 0 && n < 100) { g.idle(); n++; }
  assert.equal(g.level, 1);
});
