import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMode, delayFor, fromB64, isBootMsg, isLockMsg, isRomsMsg, Lockstep, toB64, type LockMsg } from './lockstep.ts';

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

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = '0123456789abcdef0123456789abcdef01234567';

test("chooseMode: lockstep only when each side holds the other one's game", () => {
  assert.equal(chooseMode([A, B], [B, A], A, B), 'lockstep');
  assert.equal(chooseMode([A], [A], A, A), 'lockstep'); // the same game on both sides
  assert.equal(chooseMode([A], [A, B], A, B), 'bytes'); // we don't have theirs
  assert.equal(chooseMode([A, B], [B], A, B), 'bytes'); // they don't have ours
});

test('isRomsMsg: SHA-1 lists only, at most 4096', () => {
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: [A, C] }), true);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: ['xyz'] }), false);
  assert.equal(isRomsMsg({ t: 'roms', g: 'nothex', s: [A] }), false);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: A }), false);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: Array(4097).fill(A) }), false);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: Array(4096).fill(A) }), true);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: [A], k: true }), true);
  assert.equal(isRomsMsg({ t: 'roms', g: C, s: [A], k: 1 }), false);
});

test('isBootMsg: seed, delay and save checked', () => {
  assert.equal(isBootMsg({ t: 'boot', seed: 1790000000, d: 3, save: 'AAEC' }), true);
  assert.equal(isBootMsg({ t: 'boot', save: 'AAEC' }), true); // the guest's answer
  assert.equal(isBootMsg({ t: 'boot' }), true); // a game with no battery save
  assert.equal(isBootMsg({ t: 'boot', seed: -1, d: 3 }), false);
  assert.equal(isBootMsg({ t: 'boot', seed: 1, d: 11 }), false);
  assert.equal(isBootMsg({ t: 'boot', seed: 1 }), false); // a seed comes with its delay
  assert.equal(isBootMsg({ t: 'boot', save: 'not base64!' }), false);
  assert.equal(isBootMsg({ t: 'boot', save: 'A'.repeat(300_000) }), false);
  assert.equal(isBootMsg({ t: 'boot', abort: true }), true); // lockstep couldn't start on that side
  assert.equal(isBootMsg({ t: 'boot', abort: false }), false);
  assert.equal(isBootMsg({ t: 'boot', abort: true, seed: 1, d: 3 }), false);
  assert.equal(isBootMsg({ t: 'boot', abort: true, save: 'AAEC' }), false);
});

test('a battery save survives the trip as base64', () => {
  const save = Uint8Array.from({ length: 0x8030 }, (_, i) => (i * 31) & 0xff);
  assert.deepEqual(fromB64(toB64(save)), save);
});
