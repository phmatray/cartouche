/**
 * Live translate, step 1: read the text a game shows, from the PPU state rather than from pixels.
 *
 * A traced frame (gb-core/src/trace.rs) gives the tile maps, the tiles and every scanline's registers. The
 * BG and window rows on screen become cells of 8x8 colour ids; a cell drawn in two colours, one of them the
 * row's background, is a character candidate, and its ink is matched against a reference set of 8x8 glyphs
 * (the Misaki font, glyphs.bin) with a distance that forgives one-pixel shifts and strokes. Rows with enough
 * characters make a text box; lines are read top to bottom, left to right, with the dakuten and handakuten
 * games draw on the row above folded into the kana below.
 * Pure functions, no DOM: unit-tested in ocr.test.ts.
 */
import { BG_CRAM_OFF, H, L, W, bgCombo, decodeCell, isCgb, lineReg, rendered, vramOf, winCombo } from '../neural/trace.ts';

// ---- 8x8 bitmaps as two 32-bit words: rows 0-3 in `hi`, rows 4-7 in `lo`, bit 7 of each row byte = left pixel.

export function pop(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const left = (x: number) => ((x << 1) & 0xfefefefe) >>> 0;
const right = (x: number) => (x >>> 1) & 0x7f7f7f7f;
/** Shift a bitmap by (dx, dy) pixels (positive: right, down); what leaves the cell is dropped. */
export function shift(hi: number, lo: number, dx: number, dy: number): [number, number] {
  if (dx > 0) { hi = right(hi); lo = right(lo); } else if (dx < 0) { hi = left(hi); lo = left(lo); }
  if (dy > 0) return [hi >>> 8, ((lo >>> 8) | ((hi & 0xff) << 24)) >>> 0];
  if (dy < 0) return [((hi << 8) | (lo >>> 24)) >>> 0, (lo << 8) >>> 0];
  return [hi >>> 0, lo >>> 0];
}
/** Every pixel within one pixel (8-neighbourhood) of the ink. */
export function dilate(hi: number, lo: number): [number, number] {
  const h = hi | left(hi) | right(hi), l = lo | left(lo) | right(lo);
  const [uh, ul] = shift(h, l, 0, -1), [dh, dl] = shift(h, l, 0, 1);
  return [(h | uh | dh) >>> 0, (l | ul | dl) >>> 0];
}
export const bitsOf = (rows: ArrayLike<number>): [number, number] =>
  [((rows[0] << 24) | (rows[1] << 16) | (rows[2] << 8) | rows[3]) >>> 0, ((rows[4] << 24) | (rows[5] << 16) | (rows[6] << 8) | rows[7]) >>> 0];
export const keyOf = (hi: number, lo: number) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');

// ---- the reference glyphs

export interface Glyphs {
  chars: string[];
  hi: Uint32Array; lo: Uint32Array;
  /** Dilated ink, for the stroke-tolerant part of the distance. */
  dhi: Uint32Array; dlo: Uint32Array;
  ink: Uint8Array;
  /**
   * Added to a glyph's distance: kanji, symbols and rare kana a little (games use far more common kana;
   * scenery looks like kanji and symbols), so a common kana wins a close call.
   */
  penalty: Float32Array;
  /** Small kana (ぁ, っ, ゃ...): only for ink that is small too. */
  small: Uint8Array;
}

/** glyphs.bin: "CGLY", u16 count, count x 8 row bytes, then the characters as UTF-8 (see scripts/build-glyphs.mjs). */
export function parseGlyphs(buf: Uint8Array): Glyphs {
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'CGLY') throw new Error('Not a glyph set');
  const n = buf[4] | (buf[5] << 8);
  const chars = [...new TextDecoder().decode(buf.subarray(6 + n * 8))];
  if (chars.length !== n) throw new Error('Damaged glyph set');
  return fromBitmaps(chars, (i) => buf.subarray(6 + i * 8, 14 + i * 8));
}

export function fromBitmaps(chars: string[], rows: (i: number) => ArrayLike<number>): Glyphs {
  const n = chars.length;
  const g: Glyphs = { chars, hi: new Uint32Array(n), lo: new Uint32Array(n), dhi: new Uint32Array(n), dlo: new Uint32Array(n), ink: new Uint8Array(n), penalty: new Float32Array(n), small: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const [hi, lo] = bitsOf(rows(i));
    const [dh, dl] = dilate(hi, lo);
    g.hi[i] = hi; g.lo[i] = lo; g.dhi[i] = dh; g.dlo[i] = dl;
    g.ink[i] = pop(hi) + pop(lo);
    const ch = chars[i];
    g.small[i] = +SMALL.includes(ch);
    g.penalty[i] = RARE.includes(ch) ? 0.08 : /[\u3041-\u30ff、。，．・：！？「」『』（）…‥ー〜]/.test(ch) ? 0 : /[\uff10-\uff19\uff21-\uff3a]/.test(ch) ? 0.05 : /[\u4e00-\u9fff]/.test(ch) ? 0.15 : 0.12;
  }
  return g;
}

const SMALL = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ';
/** Kana seldom written: a close call goes to the common one (ぱ against な, ぢ against ち...). */
const RARE = 'ぱぴぷぺぽぢづゐゑゎヰヱヴヮヵヶ';
/** Height of the ink's bounding box, in rows. */
function height(hi: number, lo: number): number {
  let top = -1, bottom = -1;
  for (let r = 0; r < 8; r++) if (((r < 4 ? hi : lo) >>> (24 - (r & 3) * 8)) & 0xff) { if (top < 0) top = r; bottom = r; }
  return top < 0 ? 0 : bottom - top + 1;
}

export interface Match {
  char: string; score: number;
  /** The next closest characters, best first (distinct, the best included): a line's context or the player picks among them. */
  alts?: { char: string; score: number }[];
}
/** How many look-alikes a match keeps. */
const ALTS = 6;

/** Chessboard distance from each of the 64 pixels to the nearest ink pixel, capped at 3. */
export function distances(hi: number, lo: number): Uint8Array {
  const d = new Uint8Array(64).fill(3), ink: number[] = [];
  for (let p = 0; p < 64; p++) if (((p < 32 ? hi : lo) >>> (31 - (p & 31))) & 1) ink.push(p);
  for (let p = 0; p < 64; p++) {
    for (const q of ink) {
      const v = Math.max(Math.abs((p >> 3) - (q >> 3)), Math.abs((p & 7) - (q & 7)));
      if (v < d[p]) { d[p] = v; if (!v) break; }
    }
  }
  return d;
}
/** Chamfer cost of an ink pixel 0, 1, 2 or 3+ pixels from the other bitmap's ink. */
const COST = [0, 1, 4, 9];
function sumAt(hi: number, lo: number, d: Uint8Array): number {
  let s = 0;
  for (let p = 0; p < 64; p++) if (((p < 32 ? hi : lo) >>> (31 - (p & 31))) & 1) s += COST[d[p]];
  return s;
}

/**
 * The closest glyph to a cell's ink, trying the cell shifted by up to one pixel each way (fonts sit at
 * different places in their 8x8 box). First a bitwise pass over every glyph (pixels that differ, plus twice
 * those farther than a pixel from the other's ink) keeps the best few; then a chamfer distance ranks them:
 * each ink pixel of one bitmap costs by how far it is from the other's ink (COST), in both directions, plus
 * 0.3 per pixel that differs (keeps look-alikes apart), over the ink of both, plus the glyph's penalty.
 * `score` is that average cost per ink pixel (0: identical). `null` for an empty cell. The weights were
 * tuned by hand on captures of a few games' dialog screens (kept outside the repository).
 * ponytail: linear scan of ~3600 glyphs x 9 shifts (a few ms per new tile); callers cache the result per
 * bitmap, so this only runs when a game draws a tile it never drew before.
 */
export function bestGlyph(g: Glyphs, hi: number, lo: number, keep = 24): Match | null {
  const ink = pop(hi) + pop(lo);
  if (!ink) return null;
  const n = g.chars.length, rough = new Float64Array(n).fill(Infinity);
  const shifted: [number, number, number, Uint8Array][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [sh, sl] = shift(hi, lo, dx, dy);
      const lost = ink - pop(sh) - pop(sl);
      if (lost > 1) continue;
      shifted.push([sh, sl, lost, distances(sh, sl)]);
      const [th, tl] = dilate(sh, sl);
      for (let i = 0; i < n; i++) {
        const gi = g.ink[i];
        if (gi > ink * 2 + 2 || ink > gi * 2 + 2) continue;
        const d = 2 * lost + pop(sh ^ g.hi[i]) + pop(sl ^ g.lo[i]) +
          2 * (pop(sh & ~g.dhi[i]) + pop(sl & ~g.dlo[i]) + pop(g.hi[i] & ~th) + pop(g.lo[i] & ~tl));
        if (d < rough[i]) rough[i] = d;
      }
    }
  }
  const order = [...rough.keys()].filter((i) => rough[i] < Infinity).sort((a, b) => rough[a] - rough[b]).slice(0, keep);
  const tall = height(hi, lo) > 5;
  const scored: { char: string; score: number }[] = [];
  for (const i of order) {
    const dg = glyphDistances(g, i);
    let best = Infinity;
    for (const [sh, sl, lost, dt] of shifted) {
      const s = (sumAt(sh, sl, dg) + sumAt(g.hi[i], g.lo[i], dt) + 3 * lost + 0.3 * (pop(sh ^ g.hi[i]) + pop(sl ^ g.lo[i]))) / (ink + g.ink[i]) + g.penalty[i] + (tall && g.small[i] ? 0.3 : 0);
      if (s < best) best = s;
    }
    scored.push({ char: g.chars[i], score: best });
  }
  const alts = topAlts(scored);
  return alts.length ? { ...alts[0], alts } : null;
}

/** The best few distinct characters of a list of readings (a character may have several drawings). */
function topAlts(list: { char: string; score: number }[]): { char: string; score: number }[] {
  const out: { char: string; score: number }[] = [];
  for (const m of [...list].sort((a, b) => a.score - b.score)) {
    if (!out.some((o) => o.char === m.char)) out.push(m);
    if (out.length === ALTS) break;
  }
  return out;
}

const dtCache = new WeakMap<Glyphs, Map<number, Uint8Array>>();
function glyphDistances(g: Glyphs, i: number): Uint8Array {
  let m = dtCache.get(g);
  if (!m) dtCache.set(g, (m = new Map()));
  let d = m.get(i);
  if (!d) m.set(i, (d = distances(g.hi[i], g.lo[i])));
  return d;
}

/** A match good enough to call it a character. */
export const accepted = (m: Match | null): m is Match => !!m && m.score <= ACCEPT;
export const ACCEPT = 0.5;

// ---- the screen as rows of cells

export interface Cell {
  /** Screen position of the cell's top-left pixel. */
  x: number; y: number;
  /** 64 colour ids, row-major (flips and CGB bank applied). */
  px: Uint8Array;
  /** CGB palette number (attribute bits 0-2), 0 on DMG. */
  pal: number;
}
export interface Row { layer: 'bg' | 'win'; y: number; cells: Cell[] }

/**
 * The BG and window tile rows that start on screen, with the cells each one shows, from a traced frame's
 * meta (per-line registers + VBlank VRAM). A row counts where its first line is drawn; BG cells the window
 * covers on that line are left out. Rows cut by the screen's top edge are skipped.
 */
export function screenRows(meta: Uint8Array): Row[] {
  const rows: Row[] = [];
  const cgb = isCgb(meta);
  for (let y = 0; y <= H - 8; y++) {
    if (!rendered(meta, y)) continue;
    const lcdc = lineReg(meta, y, L.LCDC);
    if (!(lcdc & 0x80)) continue;
    const wline = lineReg(meta, y, L.WIN_LINE), winX = wline === 0xff ? W : lineReg(meta, y, L.WIN_X);
    if (wline !== 0xff && (wline & 7) === 0) {
      const combo = winCombo(lcdc), x0 = lineReg(meta, y, L.WX) - 7;
      const cells: Cell[] = [];
      for (let c = 0; x0 + c * 8 <= W - 8 && c < 32; c++) {
        if (x0 + c * 8 < 0) continue;
        cells.push(cell(meta, combo, (wline >> 3) * 32 + c, x0 + c * 8, y));
      }
      rows.push({ layer: 'win', y, cells });
    }
    const scy = lineReg(meta, y, L.SCY), scx = lineReg(meta, y, L.SCX);
    const my = (scy + y) & 255;
    // Top row of the picture: a BG row may start above the screen. Skip it unless it's aligned.
    if ((my & 7) !== 0 || (!cgb && !(lcdc & 1))) continue;
    const combo = bgCombo(lcdc), cells: Cell[] = [];
    for (let c = 0; c <= 20; c++) {
      const x = c * 8 - (scx & 7);
      if (x < 0 || x > W - 8 || x + 8 > winX) continue;
      cells.push(cell(meta, combo, (my >> 3) * 32 + (((scx >> 3) + c) & 31), x, y));
    }
    if (cells.length) rows.push({ layer: 'bg', y, cells });
  }
  return rows;
}

/**
 * A map cell as it shows: colour ids that the palette draws the same are merged into the lowest of them, so
 * text faded out (or not faded in yet) reads as blank, not as text. DMG: the line's BGP; CGB: the palette RAM.
 */
function cell(meta: Uint8Array, combo: number, index: number, x: number, y: number): Cell {
  const px = new Uint8Array(64), cgb = isCgb(meta);
  const attr = decodeCell(vramOf(meta), combo, index, cgb, px);
  const pal = cgb ? attr & 7 : 0;
  const colour = (id: number) => (cgb
    ? meta[BG_CRAM_OFF + pal * 8 + id * 2] | ((meta[BG_CRAM_OFF + pal * 8 + id * 2 + 1] & 0x7f) << 8)
    : (lineReg(meta, y, L.BGP) >> (id * 2)) & 3);
  const same = [0, 1, 2, 3].map((id) => [0, 1, 2, 3].find((j) => colour(j) === colour(id))!);
  if (same.some((v, i) => v !== i)) for (let i = 0; i < 64; i++) px[i] = same[px[i]];
  return { x, y, px, pal };
}

// ---- reading
// ---- reading

/**
 * The ways to see a cell's ink against background colour `bg`: each other colour alone, and both together
 * (fonts with a drop shadow draw the letter in one colour and the shadow in another). Empty for a blank cell,
 * null for a cell with three colours besides the background (a picture).
 */
export function inks(c: Cell, bg: number): [number, number][] | null {
  const rows = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
  const used = new Set<number>();
  for (let i = 0; i < 64; i++) {
    const v = c.px[i];
    if (v === bg) continue;
    used.add(v);
    rows[v][i >> 3] |= 0x80 >> (i & 7);
  }
  if (used.size > 2) return null;
  const out = [...used].map((v) => bitsOf(rows[v]));
  if (out.length === 2) out.push([(out[0][0] | out[1][0]) >>> 0, (out[0][1] | out[1][1]) >>> 0]);
  return out;
}

/**
 * The background colour id of each palette in a row: the most common colour of its one-colour cells (a text
 * line is mostly gaps between words and margins), else its most common colour id.
 */
function backgrounds(r: Row): Map<number, number> {
  const plain = new Map<number, number[]>(), any = new Map<number, number[]>();
  for (const c of r.cells) {
    const k = any.get(c.pal) ?? [0, 0, 0, 0];
    for (const v of c.px) k[v]++;
    any.set(c.pal, k);
    if (c.px.every((v) => v === c.px[0])) {
      const p = plain.get(c.pal) ?? [0, 0, 0, 0];
      p[c.px[0]]++;
      plain.set(c.pal, p);
    }
  }
  return new Map([...any].map(([pal, k]) => {
    const p = plain.get(pal), n = p && Math.max(...p) ? p : k;
    return [pal, n.indexOf(Math.max(...n))];
  }));
}

export interface Box {
  layer: 'bg' | 'win';
  /** Screen rectangle of the text (pixels, 160 x 144). */
  x: number; y: number; w: number; h: number;
  lines: string[];
  /** Every recognised cell: its bitmap key, what it was read as, and where (for teaching corrections). */
  glyphs: { key: string; char: string; x: number; y: number; score: number; alts?: string[] }[];
}

const DAKUTEN = 'かきくけこさしすせそたちつてとはひふへほカキクケコサシスセソタチツテトハヒフヘホウ';
const VOICED = 'がぎぐげござじずぜぞだぢづでどばびぶべぼガギグゲゴザジズゼゾダヂヅデドバビブベボヴ';
const HANDAKU = 'はひふへほハヒフヘホ', HALF = 'ぱぴぷぺぽパピプペポ';
export type Mark = '゛' | '゜';
/** A kana with a mark (゛ or ゜), or null when that kana takes no such mark. */
export function voice(ch: string, mark: Mark): string | null {
  const s = mark === '゛' ? DAKUTEN : HANDAKU, t = mark === '゛' ? VOICED : HALF;
  const i = s.indexOf(ch);
  return i < 0 ? null : t[i];
}

const rowOf = (hi: number, lo: number, r: number) => ((r < 4 ? hi : lo) >>> (24 - (r & 3) * 8)) & 0xff;
/** A small ring (handakuten) rather than ticks (dakuten): an empty pixel with ink above, below, left and right. */
function ring(hi: number, lo: number): boolean {
  for (let r = 1; r < 7; r++) {
    const row = rowOf(hi, lo, r), up = rowOf(hi, lo, r - 1), down = rowOf(hi, lo, r + 1);
    for (let c = 1; c < 7; c++) {
      const b = 0x80 >> c;
      if (!(row & b) && up & b && down & b && row & (b << 1) && row & (b >> 1)) return true;
    }
  }
  return false;
}

/**
 * A mark alone in its cell: low in the cell, the way games draw it on the row above the kana, or in the top
 * half, drawn in the cell after the kana.
 */
function loneMark(hi: number, lo: number): Mark | null {
  const ink = pop(hi) + pop(lo);
  if (ink < 2 || ink > 8 || (pop(hi & 0xffff0000) && lo)) return null;
  return ring(hi, lo) ? '゜' : '゛';
}

/**
 * Font tiles leave a blank line on at least one edge (the gap between two characters); picture tiles
 * rarely do. Cheap and good at keeping scenery out of the text.
 */
export const spaced = (hi: number, lo: number) =>
  pop(hi >>> 24) <= 1 || pop(lo & 0xff) <= 1 || pop(hi & 0x80808080) + pop(lo & 0x80808080) <= 1 || pop(hi & 0x01010101) + pop(lo & 0x01010101) <= 1;

/** Where games put the mark of a voiced kana drawn in one tile: the top-right corner. */
const MARK_AREAS: [number, number][] = [[0x0f0f0f00, 0], [0x07070000, 0], [0x03030300, 0]];

export interface Reader {
  glyphs: Glyphs;
  /** Bitmap key -> character, learned while playing or taught by the player; '' means "not text". */
  learned: Map<string, string>;
  /** Bitmap key -> best match, so a bitmap is matched once. */
  cache?: Map<string, Match | null>;
}

/** What a cell shows. `unknown`: shaped like a character (two colours, a blank edge) but matching no glyph well. */
export type Seen =
  | { kind: 'blank' } | { kind: 'other' } | { kind: 'mark'; mark: Mark }
  | { kind: 'char'; key: string; char: string; score: number; alts?: Match['alts'] }
  | { kind: 'unknown'; key: string };

/** Placeholder for a character that could not be read (the translation providers are told what it means). */
export const UNKNOWN = '□';
/** The reference font's double quotes: games draw a lone dakuten the same way. */
const QUOTES = '〝〟＂';

/**
 * Many games use a bold font: vertical strokes two pixels wide. Its tiles are matched against the reference
 * glyphs emboldened the same way (each pixel smeared one to the right), and the better reading wins.
 */
const bolds = new WeakMap<Glyphs, Glyphs>();
function boldOf(g: Glyphs): Glyphs {
  let b = bolds.get(g);
  if (!b) {
    b = fromBitmaps(g.chars, (i) => {
      const [hi, lo] = [(g.hi[i] | right(g.hi[i])) >>> 0, (g.lo[i] | right(g.lo[i])) >>> 0];
      return [0, 1, 2, 3, 4, 5, 6, 7].map((r) => rowOf(hi, lo, r));
    });
    bolds.set(g, b);
  }
  return b;
}
/** Two-by-two blocks of ink: a bold font draws them all over, a thin one hardly ever. */
const blocks = (hi: number, lo: number) => {
  const h = hi & left(hi), l = lo & left(lo); // ink with ink to its right
  return pop(h & (h << 8)) + pop(l & (l << 8)) + pop((h & 0xff) & (l >>> 24));
};

function match(r: Reader, hi: number, lo: number): Match | null {
  const cache = (r.cache ??= new Map());
  const key = keyOf(hi, lo);
  let m = cache.get(key);
  if (m === undefined) {
    m = bestGlyph(r.glyphs, hi, lo);
    if (blocks(hi, lo) >= 2) {
      const b = bestGlyph(boldOf(r.glyphs), hi, lo);
      if (b) { const alts = topAlts([...(m?.alts ?? []), ...b.alts!]); m = { ...alts[0], alts }; }
    }
    cache.set(key, m);
  }
  return m;
}

/**
 * What a cell shows: a character (the best reading of its inks, a voiced kana with its mark in the corner
 * included; a taught reading first), a lone mark, a blank, an unreadable character, or something else.
 */
export function readCell(c: Cell, bg: number, r: Reader): Seen {
  const vs = inks(c, bg);
  if (!vs) return { kind: 'other' };
  if (!vs.length) return { kind: 'blank' };
  let best: (Seen & { kind: 'char' }) | null = null, shaped = '';
  const consider = (key: string, char: string, score: number, alts?: Match['alts']) => { if (!best || score < best.score) best = { kind: 'char', key, char, score, alts }; };
  for (const [hi, lo] of vs) {
    const key = keyOf(hi, lo);
    const taught = r.learned.get(key);
    if (taught !== undefined) return taught ? { kind: 'char', key, char: taught, score: 0 } : { kind: 'other' };
    if (!spaced(hi, lo)) continue;
    shaped ||= key;
    const m = match(r, hi, lo);
    if (m) consider(key, m.char, m.score, m.alts);
    for (const [mh, ml] of MARK_AREAS) {
      const markH = (hi & mh) >>> 0, markL = (lo & ml) >>> 0, n = pop(markH) + pop(markL);
      if (n < 2 || n > 6) continue;
      const b = match(r, (hi & ~mh) >>> 0, (lo & ~ml) >>> 0);
      const v = b && voice(b.char, ring(markH, markL) ? '゜' : '゛');
      if (v) consider(key, v, b.score + 0.05);
    }
  }
  const found = best as (Seen & { kind: 'char' }) | null;
  // A dakuten alone in its cell matches the font's double quotes: it's a mark (for the kana before or below).
  if (found && found.score <= ACCEPT) return QUOTES.includes(found.char) ? { kind: 'mark', mark: '゛' } : found;
  const mark = vs.length === 1 ? loneMark(vs[0][0], vs[0][1]) : null;
  if (mark) return { kind: 'mark', mark };
  return shaped ? { kind: 'unknown', key: shaped } : { kind: 'other' };
}

interface Segment { layer: 'bg' | 'win'; y: number; x0: number; x1: number; text: string; glyphs: Box['glyphs'] }

/**
 * The text boxes on screen, top to bottom. A frame's sides (the same tile at the same x on three rows or
 * more) are set aside first. Each row is then cut into runs of cells sharing a palette, broken by anything
 * that isn't a blank, a character, a mark or an unreadable character. A run is a line of text when it has
 * at least two characters, more of them than unreadable cells and marks, a gap somewhere (words, margins),
 * and isn't one or two tiles repeated (a frame's top, a wall). Lines of the same layer that overlap
 * horizontally and are at most one row apart make one box; runs on the same row join into one line.
 */
export function readBoxes(rows: Row[], r: Reader): Box[] {
  const read = rows.map((row) => {
    const bgs = backgrounds(row);
    return { row, seen: row.cells.map((c) => readCell(c, bgs.get(c.pal)!, r)) };
  });
  // A frame's sides: the same tile at the same x on three consecutive rows or more.
  const run = new Map<string, { y: number; n: number; at: [number, number][] }>();
  read.forEach(({ row, seen }, ri) => seen.forEach((s, j) => {
    if (s.kind !== 'char' && s.kind !== 'unknown') return;
    const k = `${row.layer}:${row.cells[j].x}:${s.key}`, cur = run.get(k);
    const next = cur && row.y - cur.y === 8 ? { y: row.y, n: cur.n + 1, at: [...cur.at, [ri, j] as [number, number]] } : { y: row.y, n: 1, at: [[ri, j] as [number, number]] };
    run.set(k, next);
    if (next.n >= 3) for (const [a, b] of next.at) read[a].seen[b] = { kind: 'other' };
  }));

  const segs: Segment[] = [];
  for (const { row, seen } of read) {
    // Marks for this row, where games keep them apart: the row just above.
    const above = read.find((a) => a.row.layer === row.layer && a.row.y === row.y - 8);
    let start = 0;
    const blank = (j: number) => j >= 0 && seen[j].kind === 'blank';
    for (let j = 0; j <= seen.length; j++) {
      // A wide gap (three blanks) also ends a run: columns of a menu, a name apart from a decoration.
      const gap = j < seen.length && !blank(j) && j - 3 > start && blank(j - 1) && blank(j - 2) && blank(j - 3);
      const brk = j === seen.length || seen[j].kind === 'other' || gap || (j > start && row.cells[j].pal !== row.cells[j - 1].pal);
      if (!brk) continue;
      const seg = segment(row, seen, start, j, above);
      if (seg) segs.push(seg);
      start = seen[j]?.kind === 'other' ? j + 1 : gap ? j - 1 : j;
    }
  }
  const boxes: (Box & { ys: number[] })[] = [];
  for (const s of segs) {
    const b = boxes.find((b) => b.layer === s.layer && s.y >= b.y && s.y - (b.y + b.h) <= 8 && s.x0 < b.x + b.w + 16 && s.x1 + 16 > b.x);
    if (!b) { boxes.push({ layer: s.layer, x: s.x0, y: s.y, w: s.x1 - s.x0, h: 8, lines: [s.text], glyphs: s.glyphs, ys: [s.y] }); continue; }
    const x0 = Math.min(b.x, s.x0), x1 = Math.max(b.x + b.w, s.x1);
    b.x = x0; b.w = x1 - x0; b.h = Math.max(b.h, s.y + 8 - b.y);
    const same = b.ys.indexOf(s.y);
    if (same >= 0) b.lines[same] += `  ${s.text}`;
    else { b.lines.push(s.text); b.ys.push(s.y); }
    b.glyphs.push(...s.glyphs);
  }
  return boxes.filter(text).sort((a, b) => a.y - b.y || a.x - b.x).map(({ ys, ...b }) => (void ys, b));
}

/**
 * A box worth translating, not a label, a status bar, a logo or a picture read as letters. Numbers alone need
 * no translation. Latin text (an English game): a few letters and no kana. Japanese: three different common kana at least
 * (status bars and logos read as a scatter of rare kana, kanji, symbols and Latin letters), characters that
 * match fairly well on average, and on a single line, not mostly kanji, symbols or Latin letters.
 */
export function text(b: Box): boolean {
  const g = b.glyphs, n = g.length;
  if (n < 3 || g.filter((x) => WORDY.test(x.char)).length < 2) return false;
  const latin = g.filter((x) => LATIN.test(x.char)).length;
  if (latin >= 3 && latin * 2 >= n && !g.some((x) => KANA.test(x.char))) return true;
  const common = new Set(g.filter((x) => COMMON.test(x.char) && !SMALL.includes(x.char) && !RARE.includes(x.char)).map((x) => x.char)).size;
  const odd = g.filter((x) => !KANA.test(x.char) && !PUNCT.test(x.char) && !/^[0-9０-９]$/.test(x.char)).length;
  const mean = g.reduce((s, x) => s + x.score, 0) / n;
  return common >= 3 && mean <= MEAN_MAX && (b.lines.length > 1 || odd * 2 < n);
}
/** Hiragana and katakana, marks and the long vowel left out. */
const COMMON = /^[ぁ-んァ-ン]$/;
const LATIN = /^[A-Za-zＡ-Ｚａ-ｚ]$/;
/** The worst average match of a real text box (unreadable cells count 1; tuned on captures of dialogue, menus, titles and status bars). */
const MEAN_MAX = 0.5;

const WORDY = /^[\u3041-\u30fa\uff21-\uff3a\uff41-\uff5a\u4e00-\u9fff]$/;
const CORE = /^[\u3041-\u30fb\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]$/;

function segment(row: Row, seen: Seen[], a: number, b: number, above?: { row: Row; seen: Seen[] }): Segment | null {
  const idx: number[] = [];
  let blanks = 0, odd = 0;
  const keys = new Set<string>();
  for (let j = a; j < b; j++) {
    const s = seen[j];
    if (s.kind === 'char') { idx.push(j); keys.add(s.key); } else if (s.kind === 'blank') blanks++; else odd++;
  }
  const n = idx.length;
  if (n < 2 || !blanks || n <= odd || keys.size * 3 < n || (n >= 4 && keys.size <= 2) || (n >= 3 && keys.size === 1)) return null;
  // Words, not scenery: most characters are kana, letters or digits (scenery reads as dashes, symbols, kanji).
  const core = idx.filter((j) => CORE.test((seen[j] as { char: string }).char)).length;
  if (core < 2 || core * 2 < n) return null;
  // A line of kana: a Latin letter, digit, bracket or kanji in it is more likely a misread kana (び as Ｄ,
  // く as 〈, ろ as ５), so a kana (or ! ?) close behind wins instead.
  const kanaLine = idx.filter((j) => KANA.test((seen[j] as { char: string }).char)).length * 5 >= n * 3;
  const chars = new Map<number, string>();
  for (const j of idx) {
    const s = seen[j] as Seen & { kind: 'char' };
    let ch = s.char;
    if (kanaLine && s.score > 0 && !KANA.test(ch) && !PUNCT.test(ch)) {
      const alt = s.alts?.find((m) => (KANA.test(m.char) || PUNCT.test(m.char)) && m.score <= Math.min(ACCEPT, s.score + FOREIGN));
      if (alt) ch = alt.char;
    }
    chars.set(j, ch);
  }
  // "!" drawn like ノ in most fonts: a ノ ending a word of hiragana, or doubled, is one.
  if (kanaLine) for (const j of idx) {
    if (chars.get(j) !== 'ノ') continue;
    const prev = chars.get(j - 1) ?? '', next = chars.get(j + 1);
    if ((next === undefined || next === 'ノ' || next === '！') && (/[ぁ-ゖ！ノ]/.test(prev) || next === 'ノ')) chars.set(j, '！');
  }
  // From the first to the last character (unreadable cells at the ends are cursors and decorations), and a
  // mark drawn in the cell after the last one.
  const first = idx[0];
  let last = idx[n - 1];
  if (last + 1 < b && seen[last + 1].kind === 'mark') last++;
  let text = '';
  for (let j = first; j <= last; j++) {
    const s = seen[j];
    if (s.kind === 'unknown') { text += UNKNOWN; continue; }
    if (s.kind === 'mark') {
      // A mark in its own cell after a kana voices it.
      const v = voice(text.slice(-1), s.mark);
      text = v ? text.slice(0, -1) + v : `${text} `;
      continue;
    }
    if (s.kind !== 'char') { text += ' '; continue; }
    const ch = chars.get(j)!;
    const k = above ? above.row.cells.findIndex((c) => c.x === row.cells[j].x) : -1;
    const m = k >= 0 ? above!.seen[k] : null;
    text += (m?.kind === 'mark' && (voice(ch, m.mark) ?? voice(ch, '゛'))) || ch;
  }
  const cells = row.cells;
  const glyphs: Box['glyphs'] = [];
  for (let j = first; j <= last; j++) {
    const s = seen[j];
    if (s.kind === 'char') glyphs.push({ key: s.key, char: chars.get(j)!, x: cells[j].x, y: cells[j].y, score: s.score, alts: s.alts?.map((m) => m.char) });
    else if (s.kind === 'unknown') glyphs.push({ key: s.key, char: UNKNOWN, x: cells[j].x, y: cells[j].y, score: 1 });
  }
  return { layer: row.layer, y: row.y, x0: cells[first].x, x1: cells[last].x + 8, text: tidy(text), glyphs };
}

/** Hiragana and katakana (with the long vowel mark). */
const KANA = /^[ぁ-ー]$/;
/** Punctuation a line of kana uses. */
const PUNCT = /^[、。，．・：！？「」『』…‥ー〜]$/;
/** How much worse a kana may match than a foreign character in a kana line and still win. */
const FOREIGN = 0.2;

const HIRA_LOOK = 'へべぺり', KATA_LOOK = 'ヘベペリ';
/**
 * Clean a line: full-width Latin letters and digits to ASCII, look-alike kana to the script of their word
 * (へ/ヘ, べ/ベ, ぺ/ペ and り/リ are drawn the same), a dash between kana to the long vowel mark, runs of
 * spaces to two.
 */
export function tidy(s: string): string {
  s = s.replace(/[\uff01-\uff5e]/g, (c) => (/[０-９Ａ-Ｚａ-ｚ]/.test(c) ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c));
  s = s.split(/( +)/).map((w) => {
    const hira = (w.match(/[\u3041-\u3096]/g) ?? []).length, kata = (w.match(/[\u30a1-\u30fa]/g) ?? []).length;
    const [from, to] = hira >= kata ? [KATA_LOOK, HIRA_LOOK] : [HIRA_LOOK, KATA_LOOK];
    return [...w].map((c) => { const i = from.indexOf(c); return i >= 0 ? to[i] : c; }).join('');
  }).join('');
  return s.replace(/(?<=[\u3041-\u30ff])[－―─一]+/g, (m) => 'ー'.repeat(m.length)).replace(/ {3,}/g, '  ').trim();
}

/** The text of a box as one passage: its lines joined by spaces (games break lines between words). */
export const passage = (b: Box) => b.lines.join(' ').replace(/\s+/g, ' ').trim();

/** Kana in the text: Japanese. */
export const hasKana = (s: string) => /[ぁ-ヿ]/.test(s);
