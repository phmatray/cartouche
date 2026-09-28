import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delayFor, isLockMsg, Lockstep, type LockMsg } from './lockstep.ts';

// Literal input scripts: what each player holds when their console is about to run frame n.
const P1 = (n: number) => (n * 7) & 0xff;
const P2 = (n: number) => (n * 13 + 1) & 0xff;

test('two sides joined by a 5-tick network run the same button pairs, never ahead of the inputs', () => {
  const D = 3, LAG = 5, FRAMES = 300;
  const sides = [1, 2].map((seat) => ({
    seat, lock: new Lockstep(seat as 1 | 2, D), next: 0, sent: -1,
    script: seat === 1 ? P1 : P2, pairs: [] as [number, number][], inbox: [] as { at: number; m: LockMsg }[],
  }));
  // Frames each side has sent (or starts with: the first D frames are empty).
  const sentFor = [new Set<number>(), new Set<number>()];
  for (let f = 0; f < D; f++) { sentFor[0].add(f); sentFor[1].add(f); }
  for (let tick = 0; tick < 5000 && sides.some((s) => s.next < FRAMES); tick++) {
    for (const [i, s] of sides.entries()) {
      while (s.inbox.length && s.inbox[0].at <= tick) s.lock.remote(s.inbox.shift()!.m);
      if (s.sent < s.next) {
        const m = s.lock.local(s.next, s.script(s.next));
        s.sent = s.next;
        sentFor[i].add(m.f);
        sides[1 - i].inbox.push({ at: tick + LAG, m });
      }
      const pair = s.next < FRAMES ? s.lock.ready(s.next) : null;
      if (pair) {
        assert.ok(sentFor[0].has(s.next) && sentFor[1].has(s.next), `frame ${s.next} ran before both inputs were sent`);
        s.pairs.push(pair);
        s.next++;
      }
    }
  }
  const expected = Array.from({ length: FRAMES }, (_, n) => (n < D ? [0, 0] : [P1(n - D), P2(n - D)]));
  assert.deepEqual(sides[0].pairs, expected);
  assert.deepEqual(sides[1].pairs, expected);
});

test('a duplicate or early input is kept once', () => {
  const l = new Lockstep(2, 2);
  l.remote({ t: 'i', f: 3, b: 9 });
  l.remote({ t: 'i', f: 3, b: 1 });
  l.remote({ t: 'i', f: 2, b: 4 });
  l.local(0, 5); l.local(1, 6);
  assert.deepEqual(l.ready(0), [0, 0]);
  assert.deepEqual(l.ready(2), [4, 5]);
  assert.deepEqual(l.ready(3), [9, 6]);
  assert.equal(l.ready(4), null);
});

test('delayFor: half the round trip in frames, plus one, 2 to 10', () => {
  assert.equal(delayFor(50), 3);
  assert.equal(delayFor(150), 6);
  assert.equal(delayFor(0), 2);
  assert.equal(delayFor(1000), 10);
});

test('isLockMsg rejects bad frames and buttons', () => {
  assert.equal(isLockMsg({ t: 'i', f: -1, b: 0 }), false);
  assert.equal(isLockMsg({ t: 'i', f: 1, b: 256 }), false);
  assert.equal(isLockMsg({ t: 'i', f: '1', b: 0 }), false);
  assert.equal(isLockMsg({ t: 'i', f: 1.5, b: 0 }), false);
  assert.equal(isLockMsg({ t: 'i', f: 0, b: 255 }), true);
});
