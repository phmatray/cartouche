// node --test: Live translate's reader, on synthetic screens drawn with the reference font itself (no game data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { H, LINES_OFF, LINE_LEN, L, META_LEN, VRAM_OFF } from '../neural/trace.ts';
import { bestGlyph, parseGlyphs, passage, readBoxes, screenRows, shift, tidy, voice, type Glyphs, type Reader } from './ocr.ts';

const G: Glyphs = parseGlyphs(new Uint8Array(fs.readFileSync(new URL('./glyphs.bin', import.meta.url))));
const reader = (): Reader => ({ glyphs: G, learned: new Map() });

/** The 8 row bytes of a reference glyph (its first drawing). */
function rows(ch: string): number[] {
  const i = G.chars.indexOf(ch);
  assert.ok(i >= 0, `no glyph for ${ch}`);
  return [0, 1, 2, 3, 4, 5, 6, 7].map((r) => ((r < 4 ? G.hi[i] : G.lo[i]) >>> (24 - (r & 3) * 8)) & 0xff);
}

/**
 * A DMG frame: the window from line `wy` (map 0x9C00), BG map 0x9800 elsewhere, tile data at 0x8000.
 * `tiles`: row bytes per tile index (drawn in colour 3 on colour 0); `win` / `bg`: map rows of tile indices.
 */
function frame(tiles: number[][], win: number[][], wy = 112, bg: number[][] = [], scx = 0): Uint8Array {
  const meta = new Uint8Array(META_LEN);
  meta.set([0x43, 0x54, 0x52, 0x43, 1, 0, H, 0], 0);
  for (let y = 0; y < H; y++) {
    const o = LINES_OFF + y * LINE_LEN;
    meta[o + L.LCDC] = 0xf1; meta[o + L.BGP] = 0xe4; meta[o + L.SCX] = scx; meta[o + L.WX] = 7; meta[o + L.WY] = wy;
    meta[o + L.WIN_LINE] = y >= wy ? y - wy : 0xff; meta[o + L.WIN_X] = 0; meta[o + L.FLAGS] = 1;
  }
  const vram = meta.subarray(VRAM_OFF);
  tiles.forEach((t, i) => t.forEach((b, r) => { vram[i * 16 + r * 2] = b; vram[i * 16 + r * 2 + 1] = b; }));
  win.forEach((row, r) => row.forEach((t, c) => { vram[0x1c00 + r * 32 + c] = t; }));
  bg.forEach((row, r) => row.forEach((t, c) => { vram[0x1800 + r * 32 + c] = t; }));
  return meta;
}

/** Tiles for a set of strings: 0 blank, then one per distinct character; and the map rows spelling them. */
function spell(lines: string[], extra: number[][] = []): { tiles: number[][]; rowsOf: (s: string) => number[] } {
  const tiles = [new Array(8).fill(0), ...extra];
  const index = new Map<string, number>();
  for (const ch of lines.join('')) if (ch !== ' ' && !index.has(ch)) { index.set(ch, tiles.length); tiles.push(rows(ch)); }
  return { tiles, rowsOf: (s) => [...s].map((ch) => (ch === ' ' ? 0 : index.get(ch)!)) };
}

test('every kana of the reference set reads as itself, also moved by a pixel', () => {
  for (const ch of 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコ') {
    const [hi, lo] = [G.hi[G.chars.indexOf(ch)], G.lo[G.chars.indexOf(ch)]];
    assert.equal(bestGlyph(G, hi, lo)?.char, ch);
    assert.equal(bestGlyph(G, hi, lo)?.score, 0);
    const [sh, sl] = shift(hi, lo, 0, -1); // Misaki leaves the top row empty: up by one loses nothing
    assert.equal(bestGlyph(G, sh, sl)?.char, ch, `${ch} one pixel higher`);
  }
});

test('a dialog box in the window: two lines, in reading order, with the frame left out', () => {
  const lines = ['むらの ためにも', 'ゆうこうりよう'];
  const edge = [0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff]; // a frame tile: ink on every edge
  const { tiles, rowsOf } = spell(lines, [edge]);
  const row = (s: string) => [1, 0, ...rowsOf(s), ...new Array(18 - s.length).fill(0), 1].slice(0, 20);
  const win = [new Array(20).fill(1), row(lines[0]), row(''), row(lines[1])];
  const boxes = readBoxes(screenRows(frame(tiles, win)), reader());
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].lines, lines);
  assert.equal(passage(boxes[0]), 'むらの ためにも ゆうこうりよう');
  assert.deepEqual([boxes[0].layer, boxes[0].x, boxes[0].y, boxes[0].h], ['win', 16, 120, 24]);
  assert.equal(boxes[0].glyphs.length, 14);
});

test('dakuten drawn on the row above join the kana below', () => {
  const mark = [0, 0, 0, 0, 0, 0, 0x0a, 0x0a]; // two ticks low in the cell
  const { tiles, rowsOf } = spell(['かきくさしす'], [mark]);
  const kana = rowsOf('かきくさしす');
  const win = [[0, 1, 0, 1, 0, 0, 0, 0], [0, ...kana, 0]];
  const boxes = readBoxes(screenRows(frame(tiles, win, 128)), reader());
  assert.deepEqual(boxes.map((b) => b.lines), [['がきぐさしす']]);
});

test('a voiced kana drawn in one tile, its mark in the top-right corner', () => {
  const ka = rows('か');
  const ga = ka.slice(); ga[0] |= 0x05; // Misaki leaves row 0 empty: two dots at the top right
  const { tiles, rowsOf } = spell(['いと'], [ga]);
  const [i, to] = rowsOf('いと');
  const boxes = readBoxes(screenRows(frame(tiles, [[0, 0, 1, i, to, 0]], 128)), reader());
  assert.deepEqual(boxes.map((b) => b.lines), [['がいと']]);
});

test('a picture is not text; text on the BG layer is', () => {
  // Scenery: tiles in three colours, and walls of one repeated tile.
  const pic = [0x3c, 0x7e, 0xff, 0xdb, 0xff, 0x66, 0x3c, 0x18];
  const { tiles, rowsOf } = spell(['はい いいえ']);
  const t = tiles.length;
  tiles.push(pic);
  const meta = frame(tiles, [], 200, [
    new Array(21).fill(t), new Array(21).fill(t),
    [0, 0, ...rowsOf('はい いいえ'), 0, 0],
  ]);
  // Make the scenery tile three-coloured: its high bitplane differs from the low one.
  const vram = meta.subarray(VRAM_OFF);
  for (let r = 0; r < 8; r++) vram[t * 16 + r * 2 + 1] = 0x55;
  const boxes = readBoxes(screenRows(meta), reader());
  assert.deepEqual(boxes.map((b) => [b.layer, b.lines]), [['bg', ['はい いいえ']]]);
});

test('text the palette hides (a fade) is not read', () => {
  const { tiles, rowsOf } = spell(['むらのため']);
  const meta = frame(tiles, [[0, ...rowsOf('むらのため'), 0]], 128);
  assert.equal(readBoxes(screenRows(meta), reader()).length, 1);
  for (let y = 0; y < H; y++) meta[LINES_OFF + y * LINE_LEN + L.BGP] = 0x00; // every colour id drawn white
  assert.equal(readBoxes(screenRows(meta), reader()).length, 0);
});

test('taught characters win over matching, and "" marks a tile as not text', () => {
  const { tiles, rowsOf } = spell(['のはらい']);
  const r = reader();
  const meta = frame(tiles, [[0, ...rowsOf('のはらい'), 0]], 128);
  const first = readBoxes(screenRows(meta), r)[0];
  r.learned.set(first.glyphs[0].key, 'め');
  assert.deepEqual(readBoxes(screenRows(meta), r)[0].lines, ['めはらい']);
  r.learned.set(first.glyphs[0].key, '');
  assert.deepEqual(readBoxes(screenRows(meta), r)[0].lines, ['はらい']);
});

test('voice, and tidying a line', () => {
  assert.equal(voice('か', '゛'), 'が');
  assert.equal(voice('ハ', '゜'), 'パ');
  assert.equal(voice('あ', '゛'), null);
  assert.equal(tidy('Ｈ・Ｐ　１０'), 'H・P　10');
  assert.equal(tidy('ヘいわ  カンター－－'), 'へいわ  カンターーー');
  assert.equal(tidy('リんご     ベル'), 'りんご  ベル');
});
