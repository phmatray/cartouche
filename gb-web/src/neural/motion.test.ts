// node --test: frame generation tables and guards, on synthetic traces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSprites, parse, predictability, steady, tables } from './motion.ts';
import { H, L, LINES_OFF, LINE_LEN, META_LEN, W, type FrameTrace } from './trace.ts';

/** A traced frame: every line drawn with the given scroll, sprites as [slot, y, x, tile, attr] on line 0. */
function frame(scx: number, scy: number, sprites: number[][] = [], paint?: (x: number, y: number) => number): FrameTrace {
  const plane = () => new Uint8Array(W * H * 4);
  const t: FrameTrace = { meta: new Uint8Array(META_LEN), final: plane(), bg: plane(), win: plane(), obj: plane(), info: plane() };
  t.meta.set([0x43, 0x54, 0x52, 0x43, 1, 0]);
  for (let y = 0; y < H; y++) {
    const o = LINES_OFF + y * LINE_LEN;
    t.meta[o + L.LCDC] = 0x91; t.meta[o + L.SCX] = scx; t.meta[o + L.SCY] = scy; t.meta[o + L.WIN_LINE] = 0xff; t.meta[o + L.FLAGS] = 1;
  }
  const o = LINES_OFF;
  t.meta[o + L.NSPR] = sprites.length;
  sprites.forEach((s, k) => t.meta.set(s, o + L.SPRITES + 5 * k));
  if (paint) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t.final.set([paint(x, y), 0, 0, 255], (y * W + x) * 4);
  return t;
}

test('tables: BG scroll interpolated per line at 4x, halves to even like the reference', () => {
  const A = parse(frame(10, 0)), B = parse(frame(12, 0));
  assert.equal(tables(A, B, 0).lp[0], 40);
  assert.equal(tables(A, B, 0.5).lp[0], 44);
  assert.equal(tables(A, B, 0.25).lp[0], 42);
  assert.equal(tables(A, B, 1).lp[0], 48);
  // wrap: 255 -> 1 is +2, not -254
  assert.equal(tables(parse(frame(255, 0)), parse(frame(1, 0)), 0.5).lp[0], 1024);
  assert.equal(tables(A, B, 0.5).lp[3] & 2, 2); // moved flag
});

test('matchSprites: same slot and tile first, then nearest same tile + attr', () => {
  const A = parse(frame(0, 0, [[0, 50, 50, 4, 0], [1, 80, 80, 6, 0]]));
  const B = parse(frame(0, 0, [[0, 52, 50, 4, 0], [5, 80, 83, 6, 0], [6, 80, 150, 6, 0]]));
  assert.deepEqual([...matchSprites(A, B)], [[0, 0], [1, 5]]);
  const T = tables(A, B, 0.5);
  assert.equal(T.nItems, 2);
  assert.deepEqual([...T.items.subarray(0, 2)], [(50 - 16 + 1) * 4, (50 - 8) * 4]);
});

test('predictability: a pure scroll is fully predicted, a new screen is not', () => {
  const pat = (s: number) => (x: number) => (((x + s) * 7919) % 251);
  const A = parse(frame(0, 0, [], pat(0))), B = parse(frame(3, 0, [], pat(3)));
  assert.ok(predictability(A, B) > 0.97);
  const C = parse(frame(3, 0, [], (x, y) => (x * 31 + y * 17) % 253));
  assert.ok(predictability(A, C) < 0.1);
});

test('steady: constant scroll passes, every-other-frame scroll fails', () => {
  assert.equal(steady(parse(frame(0, 0)), parse(frame(2, 0)), parse(frame(4, 0))), true);
  assert.equal(steady(parse(frame(0, 0)), parse(frame(2, 0)), parse(frame(2, 0))), false);
  assert.equal(steady(parse(frame(0, 0)), parse(frame(0, 0)), parse(frame(0, 0))), true);
});
