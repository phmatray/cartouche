// The model of the three start-up animations, verbatim from the approved concept page
// (cartouche-boot.html, its <script> from FPS to regs()). gen.mjs builds the boot ROM tables
// from it and exports the reference frames the core is checked against (tests/boot_anim.rs).
const FPS = 59.7275, FADE = 144, END = 160, STEADY = 140;
const LCD = [[196,207,161],[139,149,109],[77,83,60],[31,31,31]];
const c15 = h => { const n = parseInt(h.slice(1), 16); return [(n>>16&255)*31/255+.5|0, (n>>8&255)*31/255+.5|0, (n&255)*31/255+.5|0]; };
const K = { paper:c15('#F4F4F0'), paper3:c15('#d2d2cb'), ink:c15('#141414'), c:c15('#009FE3'), m:c15('#E5007E'), y:c15('#FFD400'),
  body:c15('#46463f'), detail:c15('#a3a39e'), dim:c15('#6f6f68') };
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const to8 = v => (v << 3) | (v >> 2);

/* ---- VRAM model: unique 8x8 tiles (2bpp colour indices), 32x32 maps ---- */
function Vram() {
  const tiles = [new Uint8Array(64)], keys = new Map([[tiles[0].join(''), 0]]);
  return { tiles, add(px) { const k = px.join(''); let i = keys.get(k); if (i == null) { i = tiles.length; tiles.push(px); keys.set(k, i); } return i; } };
}
const Bmp = (w, h) => ({ w, h, d: new Uint8Array(w * h) });
const put = (b, x, y, v) => { if (x >= 0 && y >= 0 && x < b.w && y < b.h) b.d[y * b.w + x] = v; };
const rect = (b, x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(b, x, y, v); };
const slice = (b, tx, ty) => { const px = new Uint8Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y*8+x] = b.d[(ty*8+y)*b.w + tx*8+x]; return px; };
const tileOf = (v, b) => v.add(slice(b, 0, 0));
function blit(v, map, b, col, row, cells) {
  for (let ty = 0; ty < b.h / 8; ty++) for (let tx = 0; tx < b.w / 8; tx++) {
    const t = v.add(slice(b, tx, ty)), i = (row + ty) * 32 + col + tx;
    if (cells) cells.push([i, t, tx]); else map[i] = t;
  }
}
const solid = (v, w, c, holes = []) => { const b = Bmp(8, 8); rect(b, 0, 0, w, 8, c); holes.forEach(y => rect(b, 0, y, 8, 1, 0)); return tileOf(v, b); };

/* ---- the wordmark: heavy condensed 7x13 caps, 1px apart, offset 4px in an 80px strip so it centres on 160 ---- */
const r = (s, n) => Array(n).fill(s);
const G = {
  C:['.#####.','#######','##...##',...r('##.....',7),'##...##','#######','.#####.'],
  A:['.#####.','#######',...r('##...##',4),'#######','#######',...r('##...##',5)],
  R:['######.','#######',...r('##...##',3),'#######','######.','##.##..','##..##.','##..##.',...r('##...##',3)],
  T:['#######','#######',...r('..###..',11)],
  O:['.#####.','#######',...r('##...##',9),'#######','.#####.'],
  U:[...r('##...##',11),'#######','.#####.'],
  H:[...r('##...##',5),'#######','#######',...r('##...##',6)],
  E:['#######','#######',...r('##.....',3),'######.','######.',...r('##.....',4),'#######','#######'],
};
function wordmark(c) { const b = Bmp(80, 16); [...'CARTOUCHE'].forEach((ch, i) => G[ch].forEach((row, y) => [...row].forEach((p, x) => p === '#' && put(b, 4 + i*8 + x, 1 + y, c)))); return b; }
const MARK = ['..###..','.#.#.#.','#..#..#','#######','#..#..#','.#.#.#.','..###..'];
const mark = (c, o) => { const b = Bmp(8, 8); MARK.forEach((row, y) => [...row].forEach((p, x) => p === '#' && put(b, x + o, y + o, c))); return b; };

/* ---- DMG palette byte helpers ---- */
const pal = (s0, s1, s2, s3) => s0 | s1 << 2 | s2 << 4 | s3 << 6;
const fadeB = (b, k, t) => { let o = 0; for (let i = 0; i < 4; i++) { let s = b >> (i*2) & 3; s = t > s ? Math.min(t, s + k) : Math.max(t, s - k); o |= s << (i*2); } return o; };
const hx = n => n.toString(16).toUpperCase().padStart(2, '0');
const ease = t => 1 - (1 - t) ** 3;

/* =================== A · Registration =================== */
function conceptA() {
  const v = Vram(), bg = new Uint8Array(1024), T = { L: [], R: [], mk: [] };
  blit(v, bg, wordmark(3), 5, 11);
  bg[2*32 + 3] = tileOf(v, mark(3, 0)); bg[15*32 + 16] = tileOf(v, mark(3, 1));
  for (const c of [1, 2, 3]) { T.L[c] = solid(v, 8, c); T.R[c] = solid(v, 4, c); T.mk[c] = tileOf(v, mark(c, 0)); }
  const BX = [59, 74, 89], plates = [{ c:1, f0:6, o:[-2,-3] }, { c:2, f0:14, o:[2,1] }, { c:3, f0:22, o:[-1,3] }];
  const snap = (o, f) => { const k = f - 52; return k < 2 ? o : k < 4 ? Math.round(o * .45) : k < 6 ? -Math.sign(o) : 0; };
  return {
    key:'A', name:'Registration', v, base:{ bg },
    idea:'Cyan, magenta and yellow plates drop in off register like a badly aligned print run, snap true with a one-pixel bounce, then the black plate prints CARTOUCHE and the registration marks go solid.',
    how:'Each plate is a column of 8&times;8 sprites (bars plus two registration marks) moved in OAM every VBlank. The black plate is the BG layer: wordmark and marks ink in by stepping BGP (CGB: BG palette 0, colour 3). Marks turn black through OBP1 / OBJ palette 1.',
    regs:'OAM, BGP, OBP0, OBP1 · CGB: BCPS/BCPD, OCPS/OCPD', cpals:3,
    frame(f, S) {
      plates.forEach((p, i) => {
        if (f < p.f0) return;
        const k = f - p.f0, fall = k < 16 ? Math.round(-130 * (1 - (k/16) ** 2)) : k === 17 ? -1 : 0;
        const ox = snap(p.o[0], f), oy = snap(p.o[1], f) + fall;
        for (let row = 0; row < 5; row++) {
          S.objs.push({ x: BX[i] + ox, y: 40 + row*8 + oy, t: T.L[p.c], p: 0, cp: 0 }, { x: BX[i] + 8 + ox, y: 40 + row*8 + oy, t: T.R[p.c], p: 0, cp: 0 });
        }
        S.objs.push({ x: 24 + ox, y: 16 + oy, t: T.mk[p.c], p: 1, cp: 1 }, { x: 129 + ox, y: 121 + oy, t: T.mk[p.c], p: 1, cp: 1 });
      });
      const s = f < 66 ? 0 : Math.min(3, ((f - 66) >> 2) + 1), black = f >= 66;
      S.bgp = pal(0, 0, 0, s); S.obp = [pal(0, 2, 3, 1), black ? pal(0, 3, 3, 3) : pal(0, 2, 3, 1)];
      S.cbg = [[K.paper, K.paper, K.paper, lerp(K.paper, K.ink, s / 3)]];
      S.cobj = [[K.paper, K.c, K.m, K.y], black ? [K.paper, K.ink, K.ink, K.ink] : [K.paper, K.c, K.m, K.y]];
    },
    fadeTo: 0, fadeRGB: K.paper,
    notes: [
      { f:22, ch:2, x:1881, duty:1, vol:10, per:2, what:'cyan plate lands' },
      { f:30, ch:2, x:1923, duty:1, vol:10, per:2, what:'magenta plate lands' },
      { f:38, ch:2, x:1949, duty:1, vol:10, per:2, what:'yellow plate lands' },
      { f:66, ch:1, x:1964, duty:2, vol:15, per:4, what:'black plate, in register' },
    ],
  };
}

/* =================== B · Insert =================== */
function conceptB() {
  const v = Vram(), bg = new Uint8Array(1024), win = new Uint8Array(1024), T = { bar: [] }, wm = [];
  const cart = Bmp(48, 56);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 48; x++) {
    let c = 1;
    if (y < 8 && x >= 40 + y) c = 0;                                   // notched corner
    else if ((y === 55 && (x < 2 || x > 45)) || (y === 54 && (x === 0 || x === 47))) c = 0;
    else if ((y === 0 && x < 40) || (x === 0 && y < 54) || (y < 8 && x === 39 + y)) c = 2; // bevel
    else if ((y === 3 || y === 5 || y === 7 || y === 9) && x >= 4 && x <= 34) c = 2;       // grip ridges
    if (x >= 5 && x <= 42 && y >= 13 && y <= 48) c = (x === 5 || x === 42 || y === 13 || y === 48) ? 0 : 3; // label recess
    put(cart, x, y, c);
  }
  blit(v, bg, cart, 7, 5);
  const lip = Bmp(80, 8); rect(lip, 0, 0, 80, 2, 2); rect(lip, 0, 2, 80, 2, 1); put(lip, 0, 0, 0); put(lip, 79, 0, 0);
  blit(v, win, lip, 5, 0);
  blit(v, win, wordmark(3), 5, 2, wm);
  for (const c of [1, 2, 3]) T.bar[c] = solid(v, 6, c);
  const full = new Uint8Array(win); wm.forEach(([i, t]) => full[i] = t);
  return {
    key:'B', name:'Insert', v, base:{ bg, win }, fullMaps:[bg, full],
    idea:'A cartridge slides down into the slot and clicks home. Its label lights up with the three bars, then the name runs across under the slot.',
    how:'The cartridge is BG, slid in with SCY (a 2px overshoot is the click). The window at WY=92 is the slot: it hides the cartridge bottom and carries the wordmark, wiped in by writing two window-map entries per frame. Label lit by BGP; bars are 9 sprites.',
    regs:'SCY, WY/WX, LCDC window bit, BGP, OBP0, OAM, window map writes · CGB: BCPS/BCPD, OCPS/OCPD', cpals:2,
    frame(f, S) {
      S.winOn = true; S.wx = 7; S.wy = 92;
      S.scy = f < 8 ? 96 : f < 32 ? Math.round(96 * (1 - ((f - 8) / 24) ** 2)) : f === 33 ? 254 : f === 34 ? 255 : 0;
      wm.forEach(([i, t, col]) => { if (f >= 56 + col*2) S.win[i] = t; });
      [1, 2, 3].forEach((c, i) => { if (f >= 42 + i*3) for (let row = 0; row < 3; row++) S.objs.push({ x: 69 + i*8, y: 59 + row*8, t: T.bar[c], p: 0, cp: 0 }); });
      const on = f >= 6, lit = f >= 38;
      S.bgp = on ? (lit ? pal(3, 2, 1, 0) : pal(3, 2, 1, 1)) : 0xFF; S.obp = [pal(0, 2, 3, 1), 0];
      S.cbg = [on ? [K.ink, K.body, K.detail, lit ? K.paper : K.dim] : [K.ink, K.ink, K.ink, K.ink]];
      S.cobj = [[K.ink, K.c, K.m, K.y]];
    },
    fadeTo: 3, fadeRGB: K.ink,
    notes: [
      { f:32, ch:1, x:1600, duty:2, vol:15, per:1, len:56, sweep:{ p:1, down:1, s:2 }, what:'click (sweep down)' },
      { f:40, ch:2, x:1899, duty:2, vol:12, per:3, what:'label lights' },
      { f:74, ch:1, x:1949, duty:2, vol:13, per:5, what:'name set' },
    ],
  };
}

/* =================== C · Shelf pick =================== */
function conceptC() {
  const v = Vram(), bg = new Uint8Array(1024), T = { pl: [], pr: [], bl: [], br: [] };
  const shelf = Bmp(80, 8); rect(shelf, 0, 0, 80, 3, 3); rect(shelf, 1, 3, 78, 1, 1);
  blit(v, bg, shelf, 5, 11);
  blit(v, bg, wordmark(2), 5, 13);
  for (const c of [1, 2, 3]) { T.pl[c] = solid(v, 8, c); T.pr[c] = solid(v, 4, c); T.bl[c] = solid(v, 8, c, [3, 5]); T.br[c] = solid(v, 4, c, [3, 5]); }
  const sp = [{ c:1, f0:8, f1:26, tx:59 }, { c:2, f0:22, f1:38, tx:74 }, { c:3, f0:34, f1:48, tx:89 }];
  return {
    key:'C', name:'Shelf pick', v, base:{ bg },
    idea:'Three spines slide onto a shelf, each one knocking the row as it lands. The magenta one is pulled up, the way you pick a game from your library, and the name inks in under the shelf.',
    how:'Spines are 36 sprites (12&times;48 each, 6 per line) slid in through OAM X; a knock nudges the row 1px for two frames; the picked spine rises through OAM Y. Shelf and wordmark are BG, the wordmark inked in by stepping BGP colour 2.',
    regs:'OAM, BGP, OBP0 · CGB: BCPS/BCPD, OCPS/OCPD', cpals:2,
    frame(f, S) {
      sp.forEach((s, i) => {
        if (f < s.f0) return;
        const t = Math.min(1, (f - s.f0) / (s.f1 - s.f0));
        let x = Math.round(164 + (s.tx - 164) * t * (1.6 - .6 * t)), y = 40;
        if ((i < 1 && f >= 38 && f < 40) || (i < 2 && f >= 48 && f < 50)) x -= 1;
        if (i === 1 && f >= 60) y -= Math.round(10 * ease(Math.min(1, (f - 60) / 12)));
        for (let row = 0; row < 6; row++) S.objs.push({ x, y: y + row*8, t: row ? T.pl[s.c] : T.bl[s.c], p: 0, cp: 0 }, { x: x + 8, y: y + row*8, t: row ? T.pr[s.c] : T.br[s.c], p: 0, cp: 0 });
      });
      const s = f < 76 ? 0 : Math.min(3, Math.floor((f - 76) / 3) + 1);
      S.bgp = pal(0, 1, s, 3); S.obp = [pal(0, 2, 3, 1), 0];
      S.cbg = [[K.paper, K.paper3, lerp(K.paper, K.ink, s / 3), K.ink]];
      S.cobj = [[K.paper, K.c, K.m, K.y]];
    },
    fadeTo: 0, fadeRGB: K.paper,
    notes: [
      { f:26, ch:2, x:1798, duty:0, vol:12, per:1, len:56, what:'cyan spine knocks' },
      { f:38, ch:2, x:1798, duty:0, vol:12, per:1, len:56, what:'magenta spine knocks' },
      { f:48, ch:2, x:1798, duty:0, vol:12, per:1, len:56, what:'yellow spine knocks' },
      { f:60, ch:1, x:1750, duty:2, vol:10, per:2, sweep:{ p:1, down:0, s:6 }, what:'pulled out (sweep up)' },
      { f:74, ch:2, x:1949, duty:1, vol:12, per:5, what:'picked' },
    ],
  };
}

/* ---- per-frame PPU state and a line-by-line renderer ---- */
function stateAt(def, f) {
  const S = { tiles: def.v.tiles, bg: def.base.bg, win: def.base.win ? new Uint8Array(def.base.win) : null, bgAttr: null, winAttr: null,
    scx: 0, scy: 0, winOn: false, wx: 7, wy: 0, objs: [], bgp: 0, obp: [0, 0], cbg: [], cobj: [] };
  def.frame(f, S);
  if (f >= FADE) {
    const k = Math.min(3, ((f - FADE) >> 2) + 1), t = def.fadeTo, tr = def.fadeRGB;
    S.bgp = fadeB(S.bgp, k, t); S.obp = S.obp.map(b => fadeB(b, k, t));
    S.cbg = S.cbg.map(p => p.map(c => lerp(c, tr, k / 3))); S.cobj = S.cobj.map(p => p.map(c => lerp(c, tr, k / 3)));
  }
  return S;
}
function render(S, cgb, img) {
  const d = img.data, T = S.tiles;
  const cb = S.cbg.map(p => p.map(c => c.map(to8))), co = S.cobj.map(p => p.map(c => c.map(to8)));
  for (let y = 0; y < 144; y++) {
    let line = [];
    for (const o of S.objs) if (y >= o.y && y < o.y + 8) { line.push(o); if (line.length === 10) break; }   // 10 per line
    line = line.filter(o => o.x > -8 && o.x < 160);
    if (!cgb) line.sort((a, b) => a.x - b.x);                                                              // DMG: lower X wins
    const w = S.winOn && y >= S.wy;
    for (let x = 0; x < 160; x++) {
      let ci;
      if (w && x >= S.wx - 7) { const X = x - (S.wx - 7), Y = y - S.wy; ci = T[S.win[(Y >> 3) * 32 + (X >> 3)]][(Y & 7) * 8 + (X & 7)]; }
      else { const X = (x + S.scx) & 255, Y = (y + S.scy) & 255; ci = T[S.bg[(Y >> 3) * 32 + (X >> 3)]][(Y & 7) * 8 + (X & 7)]; }
      let rgb = cgb ? cb[0][ci] : LCD[(S.bgp >> (ci * 2)) & 3];
      for (const o of line) {
        const px = x - o.x; if (px < 0 || px > 7) continue;
        const c = T[o.t][(y - o.y) * 8 + px];
        if (c) { rgb = cgb ? co[o.cp][c] : LCD[(S.obp[o.p] >> (c * 2)) & 3]; break; }
      }
      const i = (y * 160 + x) * 4; d[i] = rgb[0]; d[i+1] = rgb[1]; d[i+2] = rgb[2]; d[i+3] = 255;
    }
  }
}

/* ---- budget, measured from the definitions ---- */
function budget(def) {
  let oam = 0, perLine = 0;
  for (let f = 0; f < END; f++) {
    const S = stateAt(def, f); oam = Math.max(oam, S.objs.length);
    for (let y = 0; y < 144; y++) perLine = Math.max(perLine, S.objs.filter(o => y >= o.y && y < o.y + 8 && o.x > -8 && o.x < 160).length);
  }
  const maps = def.fullMaps || [def.base.bg, def.base.win].filter(Boolean);
  const entries = maps.reduce((n, m) => n + m.filter(Boolean).length, 0), n = def.v.tiles.length;
  return { n, bytes: n * 16, entries, oam, perLine, pals: def.cpals };
}

/* ---- APU model: square channels with duty, volume envelope, length, sweep (CH1) ---- */
const NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const hz = x => 131072 / (2048 - x);
const name = x => { const m = Math.round(69 + 12 * Math.log2(hz(x) / 440)); return NOTE[m % 12] + (Math.floor(m / 12) - 1); };
function regs(n) {
  const p = n.ch === 1 ? 'NR1' : 'NR2', out = [];
  if (n.ch === 1) out.push(`NR10=${hx(n.sweep ? (n.sweep.p << 4) | (n.sweep.down ? 8 : 0) | n.sweep.s : 0)}`);
  out.push(`${p}1=${hx((n.duty << 6) | (n.len || 0))}`, `${p}2=${hx((n.vol << 4) | n.per)}`, `${p}3=${hx(n.x & 255)}`, `${p}4=${hx(0x80 | (n.len != null ? 0x40 : 0) | (n.x >> 8))}`);
  return out.join(' ');
}

export { FPS, FADE, END, STEADY, LCD, K, to8, conceptA, conceptB, conceptC, stateAt, render, budget, regs, hz, name, pal, fadeB };
