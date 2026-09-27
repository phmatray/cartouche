// node --test: the tile-map bookkeeping of the neural upscaler, on synthetic VRAM only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BG_CRAM_OFF, H, LINES_OFF, LINE_LEN, L, META_LEN, MapState, VRAM_OFF, W, clearRect, decodeCell, diffVram, linePalettes,
  planRegion, wrapSpans, type FrameTrace,
} from './trace.ts';

/** A tile whose row r has colour id (r % 4) in its left half and 3 - (r % 4) in its right half. */
function tileBytes(): number[] {
  const b: number[] = [];
  for (let r = 0; r < 8; r++) {
    const a = r % 4, z = 3 - a;
    let lo = 0, hi = 0;
    for (let c = 0; c < 8; c++) {
      const id = c < 4 ? a : z, bit = 7 - c;
      lo |= (id & 1) << bit; hi |= ((id >> 1) & 1) << bit;
    }
    b.push(lo, hi);
  }
  return b;
}

test('decodeCell: signed/unsigned tile data, CGB bank and flips', () => {
  const vram = new Uint8Array(0x4000);
  vram.set(tileBytes(), 0x0010); // tile 1 at 0x8000 (unsigned index 1)
  vram.set(tileBytes(), 0x1000 + 0x10); // tile 1 at 0x9000 (signed index 1)
  vram.set(tileBytes(), 0x2000 + 0x0010); // bank 1, tile 1
  vram[0x1800] = 1; // map 0, cell 0 -> tile 1
  const out = new Uint8Array(64);
  decodeCell(vram, 2, 0, false, out); // unsigned
  assert.deepEqual([...out.subarray(0, 8)], [0, 0, 0, 0, 3, 3, 3, 3]);
  assert.deepEqual([...out.subarray(8, 16)], [1, 1, 1, 1, 2, 2, 2, 2]);
  decodeCell(vram, 0, 0, false, out); // signed: 256 + 1 -> 0x9010
  assert.deepEqual([...out.subarray(8, 16)], [1, 1, 1, 1, 2, 2, 2, 2]);
  vram[0x3800] = 0x08 | 0x20 | 0x40; // CGB attr: bank 1, h flip, v flip
  vram.fill(0, 0x0010, 0x0020); // bank 0 tile 1 cleared: only bank 1 can give ids
  assert.equal(decodeCell(vram, 2, 0, true, out), 0x68);
  assert.deepEqual([...out.subarray(0, 8)], [0, 0, 0, 0, 3, 3, 3, 3]); // tile row 7 (3 3 3 3 0 0 0 0), flipped
  assert.deepEqual([...out.subarray(56, 64)], [3, 3, 3, 3, 0, 0, 0, 0]); // row 0 of the tile, flipped both ways
});

test('diffVram flags changed tiles and map entries', () => {
  const a = new Uint8Array(0x4000), b = a.slice();
  assert.equal(diffVram(a, b).any, false);
  b[0x2000 + 5 * 16 + 3] = 1; // bank 1 tile 5
  b[0x1c00 + 7] = 9; // map 1 cell 7
  b[0x3800 + 2] = 1; // attribute of map 0 cell 2
  const d = diffVram(a, b);
  assert.equal(d.any, true);
  assert.deepEqual([...d.tiles.keys()].filter((i) => d.tiles[i]), [384 + 5]);
  assert.deepEqual([...d.map.keys()].filter((i) => d.map[i]), [2, 1024 + 7]);
});

test('MapState.sync: only changed cells and their neighbours become pending, with wrap-around', () => {
  const vram = new Uint8Array(0x4000);
  vram.set(tileBytes(), 0x0010);
  const m = new MapState();
  assert.deepEqual(m.sync(vram, false, 2), { ids: true, attr: true });
  m.pending.fill(0);
  assert.deepEqual(m.sync(vram, false, 2), { ids: false, attr: false });
  vram[0x1800 + 31] = 1; // cell (x 31, y 0) now shows tile 1
  assert.equal(m.sync(vram, false, 2).ids, true);
  const marked = [...m.pending.keys()].filter((i) => m.pending[i]).sort((x, y) => x - y);
  assert.deepEqual(marked, [0, 30, 31, 32, 62, 63, 992, 1022, 1023]);
  assert.equal(m.ids[1 * 256 + 31 * 8], 1); // row 1, first pixel of the cell
  m.pending.fill(0);
  vram.set(tileBytes().map((v) => v ^ 0xff), 0x0010); // tile 1 changes: every cell showing it is stale
  m.sync(vram, false, 2);
  assert.equal(m.pending[31], 1);
  assert.equal(m.pending[500], 0);
});

test('planRegion: budgeted rows, one-cell margin, whole axis at the map edge', () => {
  const p = new Uint8Array(1024);
  assert.equal(planRegion(p, 100), null);
  p[5 * 32 + 10] = 1; p[9 * 32 + 12] = 1;
  const a = planRegion(p, 1000)!;
  assert.deepEqual(a.out, { x0: 10, y0: 5, x1: 13, y1: 10 });
  assert.deepEqual(a.calc, { x0: 9, y0: 4, x1: 14, y1: 11 });
  const b = planRegion(p, 6)!; // 3 cells wide: two rows fit
  assert.deepEqual(b.out, { x0: 10, y0: 5, x1: 13, y1: 7 });
  clearRect(p, b.out);
  assert.equal(p[5 * 32 + 10], 0);
  assert.deepEqual(planRegion(p, 6)!.out, { x0: 12, y0: 9, x1: 13, y1: 10 });
  const e = new Uint8Array(1024); e[0] = 1;
  assert.deepEqual(planRegion(e, 10)!.calc, { x0: -1, y0: -1, x1: 2, y1: 2 });
  assert.deepEqual(wrapSpans(-1, 2), [[31, 32], [0, 2]]);
  assert.deepEqual(wrapSpans(30, 33), [[30, 32], [0, 1]]);
  e.fill(1, 0, 64); // two full rows: the whole width, rows -1..3 wrapped
  assert.deepEqual(planRegion(e, 64)!.calc, { x0: 0, y0: -1, x1: 32, y1: 3 });
});

test('linePalettes: DMG uses each line BGP, CGB takes what the line drew over the CRAM snapshot', () => {
  const plane = () => new Uint8Array(W * H * 4);
  const t: FrameTrace = { meta: new Uint8Array(META_LEN), final: plane(), bg: plane(), win: plane(), obj: plane(), info: plane() };
  t.meta.set([0x43, 0x54, 0x52, 0x43, 1, 0]);
  t.meta[LINES_OFF + 3 * LINE_LEN + L.BGP] = 0b00011011; // id 0 -> shade 3 ... id 3 -> shade 0
  const maps = [0, 1, 2, 3].map(() => new MapState());
  const out = new Uint8Array(H * 32 * 4);
  linePalettes(t, maps, out);
  assert.deepEqual([...out.subarray(3 * 128, 3 * 128 + 4)], [0x08, 0x18, 0x20, 255]);
  assert.deepEqual([...out.subarray(3 * 128 + 12, 3 * 128 + 16)], [0xe0, 0xf8, 0xd0, 255]);

  t.meta[5] = 1; // CGB
  t.meta[BG_CRAM_OFF + 2 * 5] = 31; // palette 1 id 1 = pure red in the snapshot
  const y = 10;
  t.meta[LINES_OFF + y * LINE_LEN + L.FLAGS] = 3;
  t.meta[LINES_OFF + y * LINE_LEN + L.LCDC] = 0x91; // BG map 0x9800, unsigned tiles: combo 2
  t.meta[LINES_OFF + y * LINE_LEN + L.WIN_LINE] = 0xff;
  const vram = t.meta.subarray(VRAM_OFF);
  vram.set(tileBytes(), 0x0010);
  vram[0x1800 + 1 * 32] = 1; // map row 1 (lines 8..15), cell 0 -> tile 1
  vram[0x3800 + 1 * 32] = 1; // palette 1
  maps[2].sync(vram, true, 2);
  const p = (y * W + 2) * 4; // x 2 of line 10: tile row 2 -> id 2
  t.bg.set([1, 2, 3, 255], p);
  linePalettes(t, maps, out);
  assert.deepEqual([...out.subarray(y * 128 + (4 + 1) * 4, y * 128 + (4 + 1) * 4 + 4)], [255, 0, 0, 255]); // snapshot
  assert.deepEqual([...out.subarray(y * 128 + (4 + 2) * 4, y * 128 + (4 + 2) * 4 + 3)], [1, 2, 3]); // observed
});
