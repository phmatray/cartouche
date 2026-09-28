// Pure decoding of PPU memory for the debugger views (Pan Docs: Tile Data, Tile Maps, OAM, Palettes).
// `vram` is both CGB banks (0x4000 bytes, bank 1 at 0x2000; all zero on DMG), `oam` 160 bytes, `cram` 64.

export type RGB = [number, number, number];

/** The 64 color ids (0-3, row-major) of tile 0-383 in a VRAM bank. */
export function tileIndices(vram: Uint8Array, bank: 0 | 1, tile: number): Uint8Array {
  const out = new Uint8Array(64);
  const base = bank * 0x2000 + tile * 16;
  for (let row = 0; row < 8; row++) {
    const lo = vram[base + row * 2], hi = vram[base + row * 2 + 1];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      out[row * 8 + x] = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
    }
  }
  return out;
}

/** A little-endian RGB555 color to 8-bit channels. */
export function rgb555(lo: number, hi: number): RGB {
  const v = lo | (hi << 8);
  const c = (s: number) => {
    const x = (v >> s) & 0x1f;
    return (x << 3) | (x >> 2);
  };
  return [c(0), c(5), c(10)];
}

/** The four colors of CGB palette n (0-7) in a 64-byte palette RAM. */
export function cgbPalette(cram: Uint8Array, n: number): RGB[] {
  return [0, 1, 2, 3].map((i) => rgb555(cram[n * 8 + i * 2], cram[n * 8 + i * 2 + 1]));
}

/** The tile map entry at tile (x, y) of the BG or window map, with its CGB attributes from bank 1. */
export function mapEntry(vram: Uint8Array, lcdc: number, which: 'bg' | 'win', x: number, y: number) {
  const high = which === 'bg' ? lcdc & 0x08 : lcdc & 0x40;
  const off = (high ? 0x1c00 : 0x1800) + y * 32 + x;
  const tile = vram[off], attr = vram[0x2000 + off];
  // LCDC bit 4: $8000 unsigned, else $9000 + signed index (so $80-$FF land in $8800-$8FFF).
  const addr = lcdc & 0x10 ? 0x8000 + tile * 16 : 0x9000 + ((tile << 24) >> 24) * 16;
  return {
    tile,
    bank: ((attr >> 3) & 1) as 0 | 1,
    palette: attr & 7,
    xflip: !!(attr & 0x20),
    yflip: !!(attr & 0x40),
    priority: !!(attr & 0x80),
    addr,
  };
}

/** OAM entry i (0-39), with raw Y/X (the screen position is Y - 16, X - 8). */
export function oamEntry(oam: Uint8Array, i: number) {
  const [y, x, tile, f] = oam.subarray(i * 4, i * 4 + 4);
  return {
    y,
    x,
    tile,
    palette: f & 7,
    bank: ((f >> 3) & 1) as 0 | 1,
    xflip: !!(f & 0x20),
    yflip: !!(f & 0x40),
    priority: !!(f & 0x80),
    dmgPalette: ((f >> 4) & 1) as 0 | 1,
  };
}
