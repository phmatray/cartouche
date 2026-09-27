/**
 * The core's per-frame layer trace (gb-core/src/trace.rs) as the neural upscaler reads it, and the tile-map
 * bookkeeping of its tile-aware path: which map cells changed since the network last saw them, which
 * rectangle of a map to recompute next, and the colours each scanline used.
 * Pure functions, no WebGL: unit-tested in trace.test.ts.
 */

export const W = 160, H = 144;
export const LINES_OFF = 32, LINE_LEN = 64;
export const OAM_OFF = LINES_OFF + H * LINE_LEN;
export const BG_CRAM_OFF = OAM_OFF + 0xa0;
export const OBJ_CRAM_OFF = BG_CRAM_OFF + 64;
export const VRAM_OFF = OBJ_CRAM_OFF + 64;
export const META_LEN = VRAM_OFF + 0x4000;

/** Offsets inside a scanline record. */
export const L = { LCDC: 0, SCX: 1, SCY: 2, WX: 3, WY: 4, WIN_LINE: 5, WIN_X: 6, BGP: 7, OBP0: 8, OBP1: 9, FLAGS: 10, NSPR: 11, SPRITES: 12 } as const;
export const LAYER_BG = 0, LAYER_WIN = 1, LAYER_OBJ = 2;
/** The core's four DMG shades, lightest first (ppu.rs). */
export const DMG_RGB = [[0xe0, 0xf8, 0xd0], [0x88, 0xc0, 0x70], [0x34, 0x68, 0x56], [0x08, 0x18, 0x20]];

/**
 * One traced frame: views into the core's memory, valid until the next emulated frame.
 * `meta`: header, per-line registers, VBlank VRAM/OAM/CRAM snapshot. RGBA planes. `info`: [layer, slot, ids, attr].
 */
export interface FrameTrace {
  meta: Uint8Array;
  final: Uint8Array;
  bg: Uint8Array;
  win: Uint8Array;
  obj: Uint8Array;
  info: Uint8Array;
}

export const validTrace = (t: FrameTrace | null | undefined): t is FrameTrace =>
  !!t && t.meta.length >= META_LEN && t.meta[0] === 0x43 && t.meta[1] === 0x54 && t.meta[2] === 0x52 && t.meta[3] === 0x43 &&
  t.info.length >= W * H * 4 && t.bg.length >= W * H * 4 && t.win.length >= W * H * 4;

export const isCgb = (meta: Uint8Array) => meta[5] !== 0;
export const lineReg = (meta: Uint8Array, y: number, reg: number) => meta[LINES_OFF + y * LINE_LEN + reg];
export const rendered = (meta: Uint8Array, y: number) => (lineReg(meta, y, L.FLAGS) & 1) !== 0;
export const vramOf = (meta: Uint8Array) => meta.subarray(VRAM_OFF, VRAM_OFF + 0x4000);

/**
 * A BG/window map as the network sees it. Combo bit 0: the map at 0x9C00 (else 0x9800); bit 1: unsigned
 * tile data at 0x8000 (LCDC.4, else signed at 0x8800). Four combos, one cache each.
 */
export const COMBOS = 4;
export const bgCombo = (lcdc: number) => ((lcdc >> 3) & 1) | (((lcdc >> 4) & 1) << 1);
export const winCombo = (lcdc: number) => ((lcdc >> 6) & 1) | (((lcdc >> 4) & 1) << 1);

/** Map cell `cell` (0..1023) of `combo`: [VRAM bank, tile index 0..383, attribute byte]. */
function cellTile(vram: Uint8Array, combo: number, cell: number, cgb: boolean): [number, number, number] {
  const mi = 0x1800 + (combo & 1) * 0x400 + cell;
  const n = vram[mi];
  const attr = cgb ? vram[0x2000 + mi] : 0;
  return [(attr >> 3) & 1, combo & 2 ? n : 256 + ((n << 24) >> 24), attr];
}

/** The 8x8 colour ids of a map cell (flips and bank applied), row-major into `out`; returns its attribute byte. */
export function decodeCell(vram: Uint8Array, combo: number, cell: number, cgb: boolean, out: Uint8Array): number {
  const [bank, idx, attr] = cellTile(vram, combo, cell, cgb);
  const base = bank * 0x2000 + idx * 16;
  for (let r = 0; r < 8; r++) {
    const rr = attr & 0x40 ? 7 - r : r;
    const lo = vram[base + rr * 2], hi = vram[base + rr * 2 + 1];
    for (let c = 0; c < 8; c++) {
      const bit = attr & 0x20 ? c : 7 - c;
      out[r * 8 + c] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  }
  return attr;
}

/** What changed between two VRAM snapshots: 768 tile flags (bank * 384 + index) and 2048 map-entry flags (map * 1024 + cell, map byte or CGB attribute). */
export interface VramDiff { tiles: Uint8Array; map: Uint8Array; any: boolean }

export function diffVram(prev: Uint8Array, cur: Uint8Array): VramDiff {
  const tiles = new Uint8Array(768), map = new Uint8Array(2048);
  let any = false;
  for (let t = 0; t < 768; t++) {
    const o = (t >= 384 ? 0x2000 : 0) + (t % 384) * 16;
    for (let i = 0; i < 16; i++) if (prev[o + i] !== cur[o + i]) { tiles[t] = 1; any = true; break; }
  }
  for (let m = 0; m < 2048; m++) {
    const o = 0x1800 + m;
    if (prev[o] !== cur[o] || prev[0x2000 + o] !== cur[0x2000 + o]) { map[m] = 1; any = true; }
  }
  return { tiles, map, any };
}

/** A cell's network output depends on its 3x3 cell neighbourhood (receptive field 8 px): mark all nine (the map wraps). */
function markAround(pending: Uint8Array, cell: number): void {
  const cy = cell >> 5, cx = cell & 31;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) pending[((cy + dy) & 31) * 32 + ((cx + dx) & 31)] = 1;
}

/**
 * One map combo on the CPU side: the colour ids and attributes the GPU holds, and the cells whose network
 * output is stale (`pending`: drawn by the pixel-space fallback until recomputed).
 */
export class MapState {
  readonly ids = new Uint8Array(256 * 256);
  readonly attr = new Uint8Array(1024);
  readonly pending = new Uint8Array(1024).fill(1);
  /** The VRAM this map was last synced from (null: decode everything next time). */
  private snap: Uint8Array | null = null;
  private cgb = false;

  /** Forget everything: the next sync decodes the whole map and every cell is recomputed. */
  invalidate(): void { this.snap = null; this.pending.fill(1); }

  /**
   * Brings the map up to date with `vram` (16 KiB, bank 0 then 1): only cells whose map entry or tile changed
   * since the last sync are decoded, and cells whose ids changed (and their neighbours) become pending.
   * Returns what to upload.
   */
  sync(vram: Uint8Array, cgb: boolean, combo: number): { ids: boolean; attr: boolean } {
    const diff = this.snap && this.cgb === cgb ? diffVram(this.snap, vram) : null;
    if (diff && !diff.any) return { ids: false, attr: false };
    const all = !diff;
    if (all) this.pending.fill(1);
    this.snap = (this.snap ?? new Uint8Array(0x4000));
    this.snap.set(vram);
    this.cgb = cgb;
    const px = new Uint8Array(64);
    let ids = all, attrs = all;
    for (let cell = 0; cell < 1024; cell++) {
      if (!all) {
        const [bank, idx] = cellTile(vram, combo, cell, cgb);
        if (!diff!.map[(combo & 1) * 1024 + cell] && !diff!.tiles[bank * 384 + idx]) continue;
      }
      const attr = decodeCell(vram, combo, cell, cgb, px);
      if (attr !== this.attr[cell]) { this.attr[cell] = attr; attrs = true; }
      const o = (cell >> 5) * 8 * 256 + (cell & 31) * 8;
      let same = true;
      for (let r = 0; r < 8 && same; r++) for (let c = 0; c < 8; c++) if (this.ids[o + r * 256 + c] !== px[r * 8 + c]) { same = false; break; }
      if (same) continue;
      for (let r = 0; r < 8; r++) this.ids.set(px.subarray(r * 8, r * 8 + 8), o + r * 256);
      markAround(this.pending, cell);
      ids = true;
    }
    return { ids, attr: attrs };
  }
}

/** A rectangle of map cells, [x0, x1) x [y0, y1) within 0..32. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/**
 * The next piece of network work for a map: `out`, the cells whose output gets rewritten (every pending cell
 * of up to `maxCells` cells, whole rows of the pending bounding box), and `calc`, where the hidden layers must
 * be computed for `out` to be exact: one cell more on each side (8 px covers the 7 px a stale border creeps in
 * through the 7 residual layers). The map wraps, so `calc` may run past 0 or 32 (see `wrapSpans`); an axis
 * that would cover the whole map is [0, 32).
 * ponytail: one bounding box, so two far-apart changes compute everything between them; split it if that shows up in profiles.
 */
export function planRegion(pending: Uint8Array, maxCells: number): { out: Rect; calc: Rect } | null {
  let x0 = 32, x1 = 0, y0 = 32, y1 = 0;
  for (let c = 0; c < 1024; c++) {
    if (!pending[c]) continue;
    const x = c & 31, y = c >> 5;
    if (x < x0) x0 = x;
    if (x >= x1) x1 = x + 1;
    if (y < y0) y0 = y;
    if (y >= y1) y1 = y + 1;
  }
  if (x1 === 0) return null;
  y1 = Math.min(y1, y0 + Math.max(1, Math.floor(maxCells / (x1 - x0))));
  const grow = (a: number, b: number): [number, number] => (b - a + 2 >= 32 ? [0, 32] : [a - 1, b + 1]);
  const [cx0, cx1] = grow(x0, x1), [cy0, cy1] = grow(y0, y1);
  return { out: { x0, y0, x1, y1 }, calc: { x0: cx0, y0: cy0, x1: cx1, y1: cy1 } };
}

/** [a, b) on a 32-cell torus as at most two plain spans within [0, 32). */
export function wrapSpans(a: number, b: number): [number, number][] {
  if (a < 0) return [[a + 32, 32], [0, b]];
  if (b > 32) return [[a, 32], [0, b - 32]];
  return [[a, b]];
}

export function clearRect(pending: Uint8Array, r: Rect): void {
  for (let y = r.y0; y < r.y1; y++) pending.fill(0, y * 32 + r.x0, y * 32 + r.x1);
}

/** CGB palette RAM (64 bytes) -> 32 RGB colours, as the core converts them (x * 255 / 31). */
export function cramRgb(cram: Uint8Array, out: Uint8Array, at = 0): void {
  for (let i = 0; i < 32; i++) {
    const v = cram[2 * i] | (cram[2 * i + 1] << 8);
    out.set([((v & 31) * 255 / 31) | 0, (((v >> 5) & 31) * 255 / 31) | 0, (((v >> 10) & 31) * 255 / 31) | 0, 255], at + i * 4);
  }
}

/**
 * The BG colours each scanline used, 144 rows x 32 RGBA (palette * 4 + colour id), into `out`.
 * DMG: the line's BGP through the core's shades (palette 0 only). CGB: every (palette, id) a line visibly drew
 * from the BG or window plane is that line's colour; a line that did not draw it takes the nearest line that
 * did (the line above on a tie), and one no line drew takes the VBlank CRAM snapshot. This follows games that
 * rewrite palettes mid-frame: a neighbour pixel from the next line is coloured the way that line showed it.
 * `maps` must be synced for the combos these lines use.
 */
export function linePalettes(t: FrameTrace, maps: MapState[], out: Uint8Array): void {
  const meta = t.meta, cgb = isCgb(meta);
  const cram = new Uint8Array(128);
  const seen = new Uint8Array(H * 32);
  if (cgb) cramRgb(meta.subarray(BG_CRAM_OFF, BG_CRAM_OFF + 64), cram);
  for (let y = 0; y < H; y++) {
    const row = y * 128;
    if (!cgb) {
      const bgp = lineReg(meta, y, L.BGP);
      for (let id = 0; id < 4; id++) out.set([...DMG_RGB[(bgp >> (2 * id)) & 3], 255], row + id * 4);
      continue;
    }
    out.set(cram, row);
    if (!rendered(meta, y)) continue;
    const lcdc = lineReg(meta, y, L.LCDC), wline = lineReg(meta, y, L.WIN_LINE);
    for (const win of [false, true]) {
      if (win && wline === 0xff) continue;
      const m = maps[win ? winCombo(lcdc) : bgCombo(lcdc)];
      const plane = win ? t.win : t.bg;
      const my = win ? wline : (lineReg(meta, y, L.SCY) + y) & 255;
      const dx = win ? 7 - lineReg(meta, y, L.WX) : lineReg(meta, y, L.SCX);
      const xFrom = win ? lineReg(meta, y, L.WIN_X) : 0;
      for (let x = xFrom; x < W; x++) {
        const p = (y * W + x) * 4;
        if (!plane[p + 3]) continue;
        const mx = win ? Math.min(255, Math.max(0, x + dx)) : (x + dx) & 255;
        const k = (m.attr[(my >> 3) * 32 + (mx >> 3)] & 7) * 4 + m.ids[my * 256 + mx], e = row + k * 4;
        out[e] = plane[p]; out[e + 1] = plane[p + 1]; out[e + 2] = plane[p + 2];
        seen[y * 32 + k] = 1;
      }
    }
  }
  if (!cgb) return;
  const prev = new Int16Array(H);
  for (let k = 0; k < 32; k++) {
    let q = -1, n = -1;
    for (let y = 0; y < H; y++) { if (seen[y * 32 + k]) q = y; prev[y] = q; }
    for (let y = H - 1; y >= 0; y--) {
      if (seen[y * 32 + k]) { n = y; continue; }
      const src = prev[y] < 0 ? n : n < 0 || y - prev[y] <= n - y ? prev[y] : n;
      if (src >= 0) out.copyWithin(y * 128 + k * 4, src * 128 + k * 4, src * 128 + k * 4 + 3);
    }
  }
}
