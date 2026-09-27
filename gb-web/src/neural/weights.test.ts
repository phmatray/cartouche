// node --test: weight file parsing and the std140 layout the shaders index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SNAP, halfToFloat, lcTexture, packTileNet, parseLc, parseTileNet, type TileNet } from './weights.ts';

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

/** The tile network on a torus map of colour ids, on the CPU (the same maths as the shaders): 4 id weights per subpixel. */
function tileWeights(net: TileNet, ids: Uint8Array, n: number): Float32Array {
  const at = (x: number, y: number) => ((y + n) % n) * n + ((x + n) % n);
  let h = new Float32Array(0);
  for (const [l, { w, b, cin, cout, k }] of net.layers.entries()) {
    if (k === 1) break;
    const o = new Float32Array(cout * n * n);
    for (let co = 0; co < cout; co++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = b[co];
      for (let t = 0; t < 9; t++) {
        const p = at(x + (t % 3) - 1, y + Math.floor(t / 3) - 1);
        if (l === 0) s += w[(co * cin + ids[p]) * 9 + t];
        else for (let ci = 0; ci < cin; ci++) s += w[(co * cin + ci) * 9 + t] * h[ci * n * n + p];
      }
      o[co * n * n + y * n + x] = Math.max(s, 0) + (l ? h[co * n * n + y * n + x] : 0);
    }
    h = o;
  }
  const head = net.layers[net.L], out = new Float32Array(64 * n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let s = 0; s < 16; s++) {
    const sx = s & 3, sy = s >> 2, q = 4 * ((4 * y + sy) * 4 * n + 4 * x + sx);
    if (sx > 0 && sx < 3 && sy > 0 && sy < 3) { out[q + ids[at(x, y)]] = 1; continue; } // central 2x2: the source id
    const present = [0, 0, 0, 0];
    for (let t = 0; t < 9; t++) present[ids[at(x + (t % 3) - 1, y + Math.floor(t / 3) - 1)]] = 1;
    const lg = [0, 1, 2, 3].map((i) => {
      let v = head.b[4 * s + i];
      for (let c = 0; c < net.C; c++) v += head.w[(4 * s + i) * net.C + c] * h[c * n * n + y * n + x];
      return present[i] ? v : -1e4;
    });
    const m = Math.max(...lg), e = lg.map((v) => Math.exp(v - m)), sum = e.reduce((a, v) => a + v);
    const cut = Math.min(SNAP, Math.max(...e) / sum), wt = e.map((v) => (v / sum >= cut ? v / sum : 0)), kept = wt.reduce((a, v) => a + v);
    for (let i = 0; i < 4; i++) out[q + i] = wt[i] / kept;
  }
  return out;
}

test('tile network: outlined curves come out smooth, not zigzag', () => {
  // Rings of three bands (outline, thin line, fill) sampled at pixel centres, which is the pixel art, and at
  // subpixel centres, which is the curve it stands for. The error is measured on subpixels next to an edge.
  const net = parseTileNet(new Uint8Array(readFileSync(new URL('./weights/tile4x.bin', import.meta.url))).buffer);
  const n = 48, ids = new Uint8Array(n * n);
  let err = 0, errNearest = 0, count = 0;
  for (const R of [13.3, 19.6, 23.1]) {
    const id = (x: number, y: number) => { const d = R - Math.hypot(x - 24.3, (y - 23.8) * 1.3); return d < 0 ? 0 : d < 1.2 ? 3 : d < 2.3 ? 1 : 2; };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ids[y * n + x] = id(x + 0.5, y + 0.5);
    const w = tileWeights(net, ids, n);
    for (let y = 0; y < 4 * n; y++) for (let x = 0; x < 4 * n; x++) {
      const px = x >> 2, py = y >> 2, lo = ids[py * n + px];
      let edge = false;
      for (let t = 0; t < 9; t++) edge ||= ids[((py + Math.floor(t / 3) - 1 + n) % n) * n + (px + (t % 3) - 1 + n) % n] !== lo;
      if (!edge) continue;
      const truth = id((x + 0.5) / 4, (y + 0.5) / 4), q = 4 * (y * 4 * n + x);
      err += 1 - w[q + truth]; errNearest += +(lo !== truth); count++;
    }
  }
  err /= count; errNearest /= count;
  // Over 0.6 x nearest with the network trained on xBRZ alone, which drew these rings as zigzags; 0.49 now.
  assert.ok(err < 0.55 * errNearest, `outlined-curve error ${err} vs nearest ${errNearest}`);
});

test('tile network: straight bands stay exact, whatever lies 4 to 8 pixels away', () => {
  // Horizontal bands of 1 to 3 pixels on the pixel grid, unrelated noise past a gap (as a map's wrapped-around
  // rows above a straight stripe): the bands and the pixels next to them must come out exactly as nearest.
  const net = parseTileNet(new Uint8Array(readFileSync(new URL('./weights/tile4x.bin', import.meta.url))).buffer);
  const n = 40, ids = new Uint8Array(n * n);
  let seed = 1, bad = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 30;
  for (const gap of [4, 6, 8]) for (const bands of [[1, 1, 2], [2, 1], [3], [1, 2, 3]]) for (const flip of [false, true]) {
    const top = 14, bottom = top + bands.reduce((a, b) => a + b);
    const rows: number[] = [];
    for (let y = 0; y < n; y++) rows.push(y < top - gap || y >= bottom + gap ? -1 : 0);
    bands.reduce((y, t, i) => { rows.fill(1 + (i % 3), y, y + t); return y + t; }, top);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ids[flip ? x * n + y : y * n + x] = rows[y] < 0 ? rnd() : rows[y];
    const w = tileWeights(net, ids, n);
    for (let y = top - 2; y < bottom + 2; y++) for (let x = 0; x < n; x++) {
      const [px, py] = flip ? [y, x] : [x, y], lo = ids[py * n + px];
      for (let s = 0; s < 16; s++) bad += +(w[4 * ((4 * py + (s >> 2)) * 4 * n + 4 * px + (s & 3)) + lo] !== 1);
    }
  }
  assert.equal(bad, 0, `${bad} subpixels off nearest on straight bands`);
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
