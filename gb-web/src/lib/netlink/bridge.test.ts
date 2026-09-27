import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkMsg, SerialBridge, type LinkCore, type LinkMsg } from './bridge.ts';

/** A core that clocks `out` when asked to, and answers the partner's clock with `sb` (listening). */
function core(sb: number) {
  const c = { request: -1, reply: -1, clocked: [] as number[], got: [] as number[] };
  const api: LinkCore = {
    link_take_request: () => { const r = c.request; c.request = -1; return r; },
    link_take_reply: () => { const r = c.reply; c.reply = -1; return r; },
    link_remote_clock: (b) => { c.clocked.push(b); c.reply = sb; },
    link_remote_reply: (b) => { c.got.push(b); },
  };
  return { c, api };
}

test('a transfer crosses and is answered once, even when messages are repeated', () => {
  const a = core(0x11), b = core(0x99);
  const wire: [SerialBridge, LinkMsg][] = [];
  const A: SerialBridge = new SerialBridge(a.api, (m) => wire.push([B, m]), () => 1);
  const B: SerialBridge = new SerialBridge(b.api, (m) => wire.push([A, m]), () => 1);
  a.c.request = 0x42 | 4096 << 8;
  A.pump();
  assert.equal(A.waitingSince, 1);
  const [to, x] = wire.shift()!;
  assert.deepEqual({ ...x, s: 0 }, { t: 'x', s: 0, b: 0x42, c: 4096 });
  to.receive(x);
  to.receive(x); // the same request again (resent after a reconnection)
  assert.deepEqual(b.c.clocked, [0x42], 'clocked into the partner once');
  assert.equal(wire.length, 2, 'answered twice, with the same byte');
  for (const [dst, m] of wire.splice(0)) dst.receive(m);
  assert.deepEqual(a.c.got, [0x99], 'the answer completes our transfer once');
  assert.equal(A.waitingSince, 0);
  assert.equal(A.bytes + B.bytes, 2);
});

test('resend repeats a pending request; a late answer after giving up is ignored', () => {
  const a = core(0);
  const sent: LinkMsg[] = [];
  const A = new SerialBridge(a.api, (m) => sent.push(m));
  a.c.request = 0x10 | 512 << 8;
  A.pump();
  A.resend();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  A.giveUp();
  assert.deepEqual(a.c.got, [0xff], 'gave up: the game reads an unplugged cable');
  A.receive({ t: 'r', s: sent[0].s, b: 0x55 });
  assert.deepEqual(a.c.got, [0xff]);
  A.resend();
  assert.equal(sent.length, 2, 'nothing left to resend');
});

test('a new request while the core holds an older one: the real answer goes to the new one', () => {
  // A core that isn't listening: it holds the partner's clock, refusing (0xFF) one it held already.
  let held = false, reply = -1;
  const api: LinkCore = {
    link_take_request: () => -1,
    link_take_reply: () => { const r = reply; reply = -1; return r; },
    link_remote_clock: () => { if (held) reply = 0xff; held = true; },
    link_remote_reply: () => {},
  };
  const sent: LinkMsg[] = [];
  const B = new SerialBridge(api, (m) => sent.push(m));
  B.receive({ t: 'x', s: 1, b: 0x42, c: 4096 });
  B.receive({ t: 'x', s: 2, b: 0x43, c: 4096 }); // the partner gave up on 1 and clocks again
  assert.deepEqual(sent, [], 'no answer yet, and none given to 2 by mistake');
  reply = 0x77; held = false; // the game listens now
  B.pump();
  assert.deepEqual(sent, [{ t: 'r', s: 2, b: 0x77 }]);
});

test('only well-formed cable messages get through', () => {
  assert.ok(isLinkMsg({ t: 'x', s: 1, b: 2, c: 4096 }));
  assert.ok(isLinkMsg({ t: 'r', s: 1, b: 2 }));
  assert.ok(!isLinkMsg({ t: 'x', s: 1, b: 2 }));
  assert.ok(!isLinkMsg({ t: 'r', s: '1', b: 2 }));
});
