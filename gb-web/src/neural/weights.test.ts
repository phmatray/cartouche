// node --test: weight file parsing and the std140 layout the shaders index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfToFloat, lcTexture, packTileNet, parseLc, parseTileNet } from './weights.ts';

test('halfToFloat', () => {
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  assert.equal(halfToFloat(0x3555), 0.333251953125);
  assert.equal(halfToFloat(0x0001), 2 ** -24);
  assert.equal(halfToFloat(0x7c00), Infinity);
});

/** A tiny tile network (C 4, L 2) whose every weight is its own index, as fp16 (exact for small integers). */
function tinyNet(): ArrayBuffer {
  const C = 4, sizes = [C * 5 * 9, C, C * C * 9, C, 64 * C, 64];
  const n = sizes.reduce((a, b) => a + b, 0);
  const b = new Uint8Array(8 + 2 * n);
  b.set([0x43, 0x54, 0x41, 0x57, 1, C, 2, 0]);
  const dv = new DataView(b.buffer);
  let o = 8;
  for (const s of sizes) for (let i = 0; i < s; i++, o += 2) {
    const v = i % 1024; // exact in fp16: 1.m x 2^e with a 10-bit mantissa
    const e = v ? Math.floor(Math.log2(v)) : 0;
    dv.setUint16(o, v ? ((e + 15) << 10) | Math.round((v / 2 ** e - 1) * 1024) : 0, true);
  }
  return b.buffer;
}

test('parseTileNet + packTileNet: every weight lands where the shaders read it', () => {
  const net = parseTileNet(tinyNet());
  assert.equal(net.layers.length, 3);
  assert.equal(net.layers[1].w[37], 37);
  const { data, blocks } = packTileNet(net, 256);
  assert.deepEqual(blocks.map((g) => g.length), [1, 1, 1]);
  for (const g of blocks) for (const b of g) assert.equal(b.offset % 256, 0);
  // input: w[tap * 4 + id][i] = W[i][id][tap]
  const inp = blocks[0][0].offset / 4, t = 5, id = 2, i = 3;
  assert.equal(data[inp + (t * 4 + id) * 4 + i], (i * 5 + id) * 9 + t);
  // body: w[tap * G + g] column j row i = W[4o + i][4g + j][tap]  (G = 1, o = 0)
  const body = blocks[1][0].offset / 4, j = 1;
  assert.equal(data[body + t * 16 + j * 4 + i], (i * 4 + j) * 9 + t);
  assert.equal(data[body + 9 * 16 + 2], net.layers[1].b[2]);
  // head: w[s * G + g] column j row i = W[4s + i][4g + j]; b[s][i] = bias[4s + i]
  const head = blocks[2][0].offset / 4, s = 7;
  assert.equal(data[head + s * 16 + j * 4 + i], (4 * s + i) * 4 + j);
  assert.equal(data[head + 16 * 16 + 4 * s + i], 4 * s + i);
});

test('parseLc + lcTexture', () => {
  const b = new Uint8Array(8 + 4 + 4 * 3);
  b.set([0x47, 0x42, 0x4c, 0x43, 1, 2, 2, 0, 12, 7, 12, 17]);
  b.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 12);
  const lc = parseLc(b.buffer);
  assert.deepEqual(lc.pairs, [[12, 7], [12, 17]]);
  const tex = lcTexture(lc);
  assert.equal(tex.h, 1);
  assert.deepEqual([...tex.data.subarray(4, 8)], [4, 5, 6, 0]);
  assert.throws(() => parseLc(b.buffer.slice(0, 20)));
});
