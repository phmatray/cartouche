import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileIndices, rgb555, cgbPalette, mapEntry, oamEntry } from './ppu-view.ts';

const vram = () => new Uint8Array(0x4000);

test('a tile row of $3C $7E decodes to color ids 0 2 3 3 3 3 2 0 (Pan Docs)', () => {
  const v = vram();
  // Tile 5 of bank 1, row 3: tile data starts at bank * $2000 + tile * 16, two bytes per row.
  v[0x2000 + 5 * 16 + 6] = 0x3c;
  v[0x2000 + 5 * 16 + 7] = 0x7e;
  const ids = tileIndices(v, 1, 5);
  assert.equal(ids.length, 64);
  assert.deepEqual([...ids.slice(24, 32)], [0, 2, 3, 3, 3, 3, 2, 0]);
  assert.deepEqual([...tileIndices(v, 0, 5)], new Array(64).fill(0));
});

test('mapEntry resolves the signed $8800 addressing mode', () => {
  const v = vram();
  v[0x1800] = 0x80; // BG map $9800, (0, 0)
  v[0x1800 + 1] = 0x7f; // (1, 0)
  const lcdc = 0x81; // bit 3 = 0: BG map $9800, bit 4 = 0: tile data $8800 signed
  assert.equal(mapEntry(v, lcdc, 'bg', 0, 0).addr, 0x8800);
  assert.equal(mapEntry(v, lcdc, 'bg', 1, 0).addr, 0x97f0);
  // Unsigned $8000 mode: tile $7F sits at $87F0.
  assert.equal(mapEntry(v, lcdc | 0x10, 'bg', 1, 0).addr, 0x87f0);
});

test('mapEntry picks the BG and window maps from LCDC bits 3 and 6', () => {
  const v = vram();
  v[0x1c00 + 2 * 32 + 3] = 0x11; // $9C00 map, (3, 2)
  v[0x1800 + 2 * 32 + 3] = 0x22; // $9800 map, (3, 2)
  assert.equal(mapEntry(v, 0x08, 'bg', 3, 2).tile, 0x11);
  assert.equal(mapEntry(v, 0x00, 'bg', 3, 2).tile, 0x22);
  assert.equal(mapEntry(v, 0x40, 'win', 3, 2).tile, 0x11);
  assert.equal(mapEntry(v, 0x08, 'win', 3, 2).tile, 0x22);
});

test('mapEntry reads the CGB attributes from VRAM bank 1', () => {
  const v = vram();
  v[0x1800 + 33] = 0x04;
  v[0x2000 + 0x1800 + 33] = 0b1110_1101; // priority, Y flip, X flip, bank 1, palette 5
  assert.deepEqual(mapEntry(v, 0x90, 'bg', 1, 1), {
    tile: 4, bank: 1, palette: 5, xflip: true, yflip: true, priority: true, addr: 0x8040,
  });
  v[0x2000 + 0x1800 + 33] = 0b0000_0010;
  assert.deepEqual(mapEntry(v, 0x90, 'bg', 1, 1), {
    tile: 4, bank: 0, palette: 2, xflip: false, yflip: false, priority: false, addr: 0x8040,
  });
});

test('rgb555 expands 5-bit channels to 8 bits', () => {
  assert.deepEqual(rgb555(0xff, 0x7f), [255, 255, 255]);
  assert.deepEqual(rgb555(0x1f, 0x00), [255, 0, 0]);
  assert.deepEqual(rgb555(0xe0, 0x03), [0, 255, 0]);
  assert.deepEqual(rgb555(0x00, 0x7c), [0, 0, 255]);
});

test('cgbPalette reads four little-endian colors of palette n', () => {
  const cram = new Uint8Array(64);
  cram.set([0xff, 0x7f, 0x1f, 0x00, 0xe0, 0x03, 0x00, 0x7c], 3 * 8);
  assert.deepEqual(cgbPalette(cram, 3), [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]]);
});

test('oamEntry returns raw Y/X and decodes every flag bit', () => {
  const oam = new Uint8Array(0xa0);
  oam.set([16, 8, 0x42, 0xff], 39 * 4);
  oam.set([100, 50, 0x07, 0b0101_0010], 1 * 4);
  assert.deepEqual(oamEntry(oam, 39), {
    y: 16, x: 8, tile: 0x42, palette: 7, bank: 1, xflip: true, yflip: true, priority: true, dmgPalette: 1,
  });
  assert.deepEqual(oamEntry(oam, 1), {
    y: 100, x: 50, tile: 7, palette: 2, bank: 0, xflip: false, yflip: true, priority: false, dmgPalette: 1,
  });
  assert.deepEqual(oamEntry(oam, 0), {
    y: 0, x: 0, tile: 0, palette: 0, bank: 0, xflip: false, yflip: false, priority: false, dmgPalette: 0,
  });
});
