#!/usr/bin/env node
// Builds the reference glyph set of Live translate (gb-web/src/translate/glyphs.bin) from the
// Misaki font BDF files by Num Kadoma (https://littlelimit.net/misaki.htm, free to use, copy and
// redistribute, see THIRD_PARTY_NOTICES.md):
//
//   node scripts/build-glyphs.mjs misaki_gothic.bdf misaki_gothic_2nd.bdf [more.bdf...]
//
// Extra files (k6x8_gothic.bdf from the same author, same license: https://littlelimit.net/k6x8.htm) add
// their kana and punctuation as more reference drawings: game fonts vary, more drawings match more of them.
//
// Kept: full-width symbols, digits, Latin, hiragana, katakana and the JIS X 0208 level-1 kanji
// (level 2 is rare on the Game Boy and only adds look-alikes); from the second file, the kana and
// punctuation whose shape differs (a second reference drawing for the characters games use most).
// Format: "CGLY", u16 LE count, count x 8 bytes (rows, bit 7 = left pixel), then the characters as UTF-8.
import fs from 'node:fs';
import path from 'node:path';

const [gothic, second, ...extra] = process.argv.slice(2);
if (!gothic || !second) { console.error('usage: build-glyphs.mjs misaki_gothic.bdf misaki_gothic_2nd.bdf'); process.exit(2); }

function parseBdf(file) {
  const glyphs = new Map();
  let code = -1, width = 0, bbx = null, rows = null;
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    const [k, ...v] = line.trim().split(/\s+/);
    if (k === 'ENCODING') code = +v[0];
    else if (k === 'DWIDTH') width = +v[0];
    else if (k === 'BBX') bbx = v.map(Number);
    else if (k === 'BITMAP') rows = [];
    else if (k === 'ENDCHAR') {
      if (width <= 8 && width >= 5 && bbx) {
        const [, h, xo, yo] = bbx, cell = new Uint8Array(8);
        rows.forEach((hex, i) => { const r = 7 - yo - h + i; if (r >= 0 && r < 8) cell[r] = (parseInt(hex, 16) >> xo) & 0xff; });
        glyphs.set(code, cell);
      }
      code = -1; rows = null; bbx = null;
    } else if (rows && k) rows.push(k);
  }
  return glyphs;
}

// JIS X 0208 level-1 kanji: rows 16-47, through EUC-JP.
const eucjp = new TextDecoder('euc-jp');
const level1 = new Set();
for (let r = 0xb0; r <= 0xcf; r++) for (let c = 0xa1; c <= 0xfe; c++) level1.add(eucjp.decode(new Uint8Array([r, c])).codePointAt(0));

const isKana = (u) => (u >= 0x3041 && u <= 0x3096) || (u >= 0x30a1 && u <= 0x30fc);
const keep = (u) =>
  isKana(u) || level1.has(u) ||
  (u >= 0x3000 && u <= 0x303f && u !== 0x3000) || // CJK punctuation (no ideographic space: blanks are handled apart)
  (u >= 0xff01 && u <= 0xff5e) || // full-width ASCII
  [0x2026, 0x2025, 0x201c, 0x201d, 0x2018, 0x2019, 0x2606, 0x2605, 0x266a, 0x2665].includes(u);
// Left out on purpose: shapes (■□◆▲▼▶...) and marks (〓, 〒, ゛, ゜): games draw cursors, frames and bullets
// with them, which must not read as text; a lone ゛ or ゜ tile is recognised by its shape instead (ocr.ts).
const drop = new Set([0x3013, 0x3012, 0x3020, 0x3036, 0x303f, 0x309b, 0x309c, 0x3006, 0x3004, 0x3003]);

const a = new Map([...parseBdf(gothic)].filter(([u, g]) => u < 0x80 ? false : g)), b = parseBdf(second);
const out = [];
const same = (x, y) => x.every((v, i) => v === y[i]);
const ink = (g) => g.reduce((s, v) => s + [...v.toString(2)].filter((c) => c === '1').length, 0);
for (const [u, g] of [...a].sort((x, y) => x[0] - y[0])) if (keep(u) && !drop.has(u) && ink(g) >= 2) out.push([u, g]);
for (const file of [second, ...extra]) {
  for (const [u, g] of [...parseBdf(file)].sort((x, y) => x[0] - y[0])) {
    if (!(isKana(u) || (u >= 0x3001 && u <= 0x303f) || u === 0xff01 || u === 0xff1f) || drop.has(u) || ink(g) < 2) continue;
    if (!out.some(([v, h]) => v === u && same(h, g))) out.push([u, g]);
  }
}

const chars = Buffer.from(out.map(([u]) => String.fromCodePoint(u)).join(''), 'utf8');
const buf = Buffer.alloc(6 + out.length * 8);
buf.write('CGLY', 0, 'latin1');
buf.writeUInt16LE(out.length, 4);
out.forEach(([, g], i) => buf.set(g, 6 + i * 8));
const dest = path.resolve(import.meta.dirname, '../gb-web/src/translate/glyphs.bin');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, Buffer.concat([buf, chars]));
console.log(`${out.length} glyphs, ${buf.length + chars.length} bytes -> ${path.relative(process.cwd(), dest)}`);
