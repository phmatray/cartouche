import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine } from './held.ts';

const core = () => {
  const log: string[] = [];
  return { log, c: combine((b, p = 0) => log.push(`+${p}:${b}`), (b, p = 0) => log.push(`-${p}:${b}`)) };
};

test('a button stays down until every source that holds it lets go', () => {
  const { log, c } = core();
  c.press('key', 0); c.press('pad', 0);
  c.release('key', 0);
  assert.deepEqual(log, ['+0:0']);
  c.release('pad', 0);
  assert.deepEqual(log, ['+0:0', '-0:0']);
});

test('a release from a source that never pressed changes nothing', () => {
  const { log, c } = core();
  c.press('pad', 1);
  c.release('key', 1); c.release('touch', 1);
  assert.deepEqual(log, ['+0:1']);
});

test('a second press from the same source is not a new press', () => {
  const { log, c } = core();
  c.press('key', 3); c.press('key', 3); c.release('key', 3);
  assert.deepEqual(log, ['+0:3', '-0:3']);
});

test('clearing one source keeps what the others hold', () => {
  const { log, c } = core();
  c.press('pad', 0); c.press('key', 0); c.press('key', 4); c.press('touch', 5);
  c.clear('key'); c.clear('touch');
  assert.deepEqual(log, ['+0:0', '+0:4', '+0:5', '-0:4', '-0:5']);
  c.release('pad', 0);
  assert.equal(log.at(-1), '-0:0');
});

test('players are held apart', () => {
  const { log, c } = core();
  c.press('pad', 0, 0); c.press('pad', 0, 2);
  c.release('pad', 0, 2);
  assert.deepEqual(log, ['+0:0', '+2:0', '-2:0']);
});
