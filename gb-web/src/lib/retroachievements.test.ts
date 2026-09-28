// node --test: the RetroAchievements hash (MD5 of the whole ROM) against Node's own MD5, and unlocks in the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { earnedNow, md5, type RaGame } from './retroachievements.ts';

test('md5 matches node:crypto at every padding boundary and on a ROM-sized buffer', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 32768 * 4]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 13) & 255);
    assert.equal(md5(data), createHash('md5').update(data).digest('hex'), `length ${n}`);
  }
});

test('earnedNow marks an achievement unlocked in the player as earned, once', () => {
  const a = { title: '', description: '', points: 5, badge: '', order: 0 };
  const g: RaGame = { id: 1, title: 'G', achievements: [{ ...a, id: 10 }, { ...a, id: 11, earned: '2022-08-23 22:56:38' }] };
  const at = new Date(Date.UTC(2026, 8, 28, 12, 34, 56));
  const n = earnedNow(g, 10, at);
  assert.equal(n.achievements[0].earned, '2026-09-28 12:34:56');
  assert.equal(n.achievements[1].earned, '2022-08-23 22:56:38');
  assert.equal(g.achievements[0].earned, undefined, 'the cached original is left alone');
  assert.equal(earnedNow(g, 11, at), g, 'already earned: unchanged');
  assert.equal(earnedNow(g, 99, at), g, 'not this game: unchanged');
});
