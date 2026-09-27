// Builds the boot ROM tables of each start-up animation from its model (reference/concepts.mjs, the approved
// concept page's own code) and exports the reference frames and chime the core is checked against.
//
//   node gen.mjs <inc-dir>      writes concept_{a,b,c}.inc for the assembler (build.sh does this)
//   node gen.mjs --refs         rewrites gb-core/tests/boot_ref/ (reference.txt + key frames as PNG)
//
// Nothing here is hand-tuned: every table is read back from the model's per-frame state (stateAt), so the ROM
// draws what the page draws. The format of each table is documented in cartouche_boot.asm.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END, LCD, conceptA, conceptB, conceptC, stateAt, render, regs } from './reference/concepts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const concepts = [conceptA(), conceptB(), conceptC()];
const KEY_FRAMES = [0, 30, 60, 100, 140, 150];
const fail = m => { throw new Error(m); };
const hex = n => '$' + (n & 255).toString(16).toUpperCase().padStart(2, '0');
const db = (bytes, per = 16) => { const out = []; for (let i = 0; i < bytes.length; i += per) out.push('    db ' + bytes.slice(i, i + per).map(hex).join(', ')); return out.join('\n'); };
const c15 = ([r, g, b]) => r | g << 5 | b << 10;

/* Tiles 1.. (tile 0 is blank): one colour in 1bpp (colour byte, 8 rows), else raw 2bpp (0, 16 bytes). $FF ends. */
function tiles(def) {
  const out = [];
  for (const px of def.v.tiles.slice(1)) {
    const cols = [...new Set(px)].filter(Boolean);
    const row = (y, f) => { let b = 0; for (let x = 0; x < 8; x++) b |= f(px[y * 8 + x]) << (7 - x); return b; };
    if (cols.length === 1) { out.push(cols[0]); for (let y = 0; y < 8; y++) out.push(row(y, v => v ? 1 : 0)); }
    else { out.push(0); for (let y = 0; y < 8; y++) out.push(row(y, v => v & 1), row(y, v => v >> 1 & 1)); }
  }
  return [...out, 0xFF];
}

/* A 32x32 map as rectangles: address (big-endian), width, height, tiles row by row. 0 ends. */
function rects(map, base) {
  const out = [], done = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    if (!map[i] || done[i]) continue;
    const r = i >> 5, c = i & 31;
    let w = 1; while (c + w < 32 && (map[i + w] || [1, 2, 3].some(k => c + w + k < 32 && map[i + w + k]))) w++;
    while (!map[i + w - 1]) w--;
    let h = 1; while (r + h < 32 && map.slice((r + h) * 32 + c, (r + h) * 32 + c + w).some(Boolean)) h++;
    const addr = base + i;
    out.push(addr >> 8, addr & 255, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { out.push(map[i + y * 32 + x]); done[i + y * 32 + x] = 1; }
  }
  for (let i = 0; i < 1024; i++) if (map[i] && !done[i]) fail('map entry left out');
  return [...out, 0];
}

/* Sprite groups: the page pushes each group's OBJs together, and a group, once shown, stays. Per group: start
   frame, runs of (frames, x, y) ended by 0 (the last run holds), OBJ count, layout (dy, dx, tile, attributes,
   relative to the first OBJ). $FF ends. */
function groups(def) {
  const frames = Array.from({ length: END }, (_, f) => stateAt(def, f).objs);
  const cuts = [...new Set(frames.map(o => o.length))].sort((a, b) => a - b);
  const out = [];
  for (let g = 1; g < cuts.length; g++) {
    const [a, b] = [cuts[g - 1], cuts[g]], start = frames.findIndex(o => o.length >= b);
    if (frames.slice(start).some(o => o.length < b)) fail('a group disappears');
    const at = f => frames[f].slice(a, b), o0 = at(start), layout = [];
    for (const o of o0) layout.push(o.y - o0[0].y, o.x - o0[0].x, o.t, (o.p ? 0x10 : 0) | o.cp);
    const runs = [];
    for (let f = start; f < END; f++) {
      const os = at(f), x = os[0].x, y = os[0].y;
      os.forEach((o, k) => { if (o.y - y !== layout[k * 4] || o.x - x !== layout[k * 4 + 1] || o.t !== layout[k * 4 + 2] || ((o.p ? 0x10 : 0) | o.cp) !== layout[k * 4 + 3]) fail('layout changes'); });
      os.forEach(o => { if (o.y < -128 || o.y > 127 || o.x < 0 || o.x > 247) fail('OBJ out of range'); });
      const last = runs[runs.length - 1];
      if (last && last[1] === x && last[2] === y && last[0] < 255) last[0]++; else runs.push([1, x, y]);
    }
    out.push(start, ...runs.flat(), 0, b - a, ...layout);
  }
  return [...out, 0xFF];
}

/* Register and map writes, per frame: frame, items, 0. Item: $10-$4F register + value; $68/$6A palette burst
   (index $80, count, colours); $98-$9F VRAM address (big-endian) + value. Frame $FF ends. */
function events(def, cgb) {
  const out = [];
  let prev = null;
  const win0 = def.base.win;
  for (let f = 0; f < END; f++) {
    const S = stateAt(def, f), items = [];
    const reg = (r, v, was) => { if (!prev || v !== was) items.push(r, v & 255); };
    reg(0x42, S.scy, prev?.scy);
    if (S.winOn) { reg(0x4A, S.wy, prev?.wy); reg(0x4B, S.wx, prev?.wx); }
    if (!cgb) { reg(0x47, S.bgp, prev?.bgp); reg(0x48, S.obp[0], prev?.obp[0]); reg(0x49, S.obp[1], prev?.obp[1]); }
    else {
      const burst = (r, pals, was) => {
        const bytes = pals.flat().flatMap(c => [c15(c) & 255, c15(c) >> 8]);
        if (!was || bytes.join() !== was.flat().flatMap(c => [c15(c) & 255, c15(c) >> 8]).join()) items.push(r, bytes.length, ...bytes);
      };
      burst(0x68, S.cbg, prev?.cbg);
      burst(0x6A, S.cobj, prev?.cobj);
    }
    if (S.win) S.win.forEach((t, i) => { if (t !== (prev ? prev.win[i] : win0[i])) items.push(0x9C + (i >> 8), i & 255, t); });
    for (const n of def.notes.filter(n => n.f === f)) for (const w of regs(n).split(' ')) items.push(noteReg(w), parseInt(w.split('=')[1], 16));
    if (items.length) out.push(f, ...items, 0);
    prev = S;
  }
  return [...out, 0xFF];
}
const NR = { NR10: 0x10, NR11: 0x11, NR12: 0x12, NR13: 0x13, NR14: 0x14, NR21: 0x16, NR22: 0x17, NR23: 0x18, NR24: 0x19 };
const noteReg = w => NR[w.split('=')[0]] ?? fail('unknown register ' + w);

function inc(def) {
  const S = stateAt(def, 0);
  const lcdc = 0x80 | 0x10 | 0x02 | 0x01 | (S.winOn ? 0x60 : 0);
  return [
    `; Generated by gen.mjs from reference/concepts.mjs (concept ${def.key}, "${def.name}"). Do not edit.`,
    `ConceptLCDC: db ${hex(lcdc)}`,
    'ConceptTiles:', db(tiles(def)),
    'ConceptMaps:', db(rects(def.base.bg, 0x9800).slice(0, -1)), ...(def.base.win ? [db(rects(def.base.win, 0x9C00).slice(0, -1))] : []), '    db 0',
    'ConceptGroups:', db(groups(def)),
    'ConceptEvents:', 'IF DEF(CGB)', db(events(def, true)), 'ELSE', db(events(def, false)), 'ENDC', '',
  ].join('\n');
}

/* ---- reference frames ---- */
function fnv(bytes) { let h = 0xcbf29ce484222325n; for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h.toString(16).padStart(16, '0'); }
/* A frame as the test compares it: DMG shade per pixel, CGB 15-bit colour per pixel (little-endian). */
function frameKey(img, cgb) {
  const d = img.data, out = [];
  for (let i = 0; i < 160 * 144; i++) {
    const [r, g, b] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    if (cgb) { const v = (r >> 3) | (g >> 3) << 5 | (b >> 3) << 10; out.push(v & 255, v >> 8); }
    else out.push(LCD.findIndex(c => c[0] === r && c[1] === g && c[2] === b));
  }
  return out;
}
function png(img) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(t, 4); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const raw = Buffer.alloc(144 * (1 + 160 * 3));
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) for (let k = 0; k < 3; k++) raw[y * 481 + 1 + x * 3 + k] = img.data[(y * 160 + x) * 4 + k];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(160); ihdr.writeUInt32BE(144, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function refs(dir) {
  mkdirSync(dir, { recursive: true });
  const lines = ['# Generated by gb-core/boot-src/gen.mjs --refs from the concept model. Do not edit.',
    '# frame <concept> <dmg|cgb> <n> <FNV-1a 64 of the DMG shades / CGB 15-bit colours>',
    '# note <concept> <frame> <register writes, in order>'];
  for (const def of concepts) {
    for (const cgb of [false, true]) for (let f = 0; f < END; f++) {
      const img = { data: new Uint8ClampedArray(160 * 144 * 4) };
      render(stateAt(def, f), cgb, img);
      lines.push(`frame ${def.key} ${cgb ? 'cgb' : 'dmg'} ${f} ${fnv(frameKey(img, cgb))}`);
      if (KEY_FRAMES.includes(f)) writeFileSync(join(dir, `${def.key}_${cgb ? 'cgb' : 'dmg'}_${String(f).padStart(3, '0')}.png`), png(img));
    }
    for (const n of def.notes) lines.push(`note ${def.key} ${n.f} ${regs(n)}`);
  }
  writeFileSync(join(dir, 'reference.txt'), lines.join('\n') + '\n');
}

if (process.argv[2] === '--refs') refs(join(here, '../tests/boot_ref'));
else {
  const dir = process.argv[2] ?? fail('usage: node gen.mjs <inc-dir> | --refs');
  mkdirSync(dir, { recursive: true });
  for (const def of concepts) writeFileSync(join(dir, `concept_${def.key.toLowerCase()}.inc`), inc(def));
}
