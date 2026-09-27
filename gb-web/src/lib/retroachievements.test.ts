// node --test: the RetroAchievements hash (MD5 of the whole ROM) against Node's own MD5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5 } from './retroachievements.ts';

test('md5 matches node:crypto at every padding boundary and on a ROM-sized buffer', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 32768 * 4]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 13) & 255);
    assert.equal(md5(data), createHash('md5').update(data).digest('hex'), `length ${n}`);
  }
});
