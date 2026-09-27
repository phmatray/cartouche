/**
 * Smooth motion: in-between frames for 120 Hz+ screens from the emulator's exact layer motion (no network,
 * no weights). Each layer moves on its own: the BG by each line's own scroll registers (status bars that do
 * not scroll stay put), the window by WX and its line counter, every sprite by its OAM position, and the
 * layers are put back together with the hardware priority rules, at 4x so half-pixel positions are real.
 * Content neither frame showed is drawn from the VRAM snapshot. See docs/NEURAL.md for measurements.
 *
 * CPU side (pure, tested in motion.test.ts): parse a traced frame, match sprites between two frames, build
 * the per-line and per-sprite tables for a time `tau` in [0, 1], and the guards that decide when to hold a
 * real frame instead (scene cut, uneven motion). GPU side: `FrameGen`, three passes at 640x576.
 */
import { H, W, L, LINES_OFF, LINE_LEN, BG_CRAM_OFF, VRAM_OFF, type FrameTrace } from './trace.ts';

const S = 4, OW = W * S, OH = H * S;

export interface Parsed {
  meta: Uint8Array;
  final: Uint8Array;
  cgb: boolean;
  lcdc: Int32Array; scx: Int32Array; scy: Int32Array; wx: Int32Array; wline: Int32Array; bgp: Int32Array;
  rendered: Uint8Array;
  /** Per line: BG map combo, or -1 when the line was not drawn. */
  bgkey: Int32Array;
  wkey: Int32Array;
  /** Window line - screen line when the line shows the window, else NO_WIN. */
  woff: Int32Array;
  wxs: Int32Array;
  /** For each combo and map row / window line: the last screen line that showed it (255: none). */
  invRow: Uint8Array;
  invWin: Uint8Array;
  /** OAM slot -> [y, x, tile, attr] of every sprite drawn. */
  spr: Map<number, number[]>;
  /** Sprite height, 8 or 16 (the majority of drawn lines). */
  h: number;
}

const NO_WIN = 9999;
const wrap8 = (d: number) => ((((d + 128) % 256) + 256) % 256) - 128;
/** Python's round(): halves to even, so positions match the reference implementation bit for bit. */
const roundEven = (x: number) => (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));

/** Copies what later frames need from a trace (its views are only valid until the next emulated frame). */
export function parse(t: FrameTrace): Parsed {
  const meta = t.meta.slice(0, VRAM_OFF + 0x4000);
  const reg = (y: number, o: number) => meta[LINES_OFF + y * LINE_LEN + o];
  const n = () => new Int32Array(H);
  const f: Parsed = {
    meta, final: t.final.slice(0, W * H * 4), cgb: meta[5] !== 0,
    lcdc: n(), scx: n(), scy: n(), wx: n(), wline: n(), bgp: n(), rendered: new Uint8Array(H), bgkey: n(), wkey: n(), woff: n(), wxs: n(),
    invRow: new Uint8Array(4 * 256).fill(255), invWin: new Uint8Array(4 * 256).fill(255), spr: new Map(), h: 8,
  };
  let tall = 0, drawn = 0;
  for (let y = 0; y < H; y++) {
    const lc = reg(y, L.LCDC);
    f.lcdc[y] = lc; f.scx[y] = reg(y, L.SCX); f.scy[y] = reg(y, L.SCY); f.wx[y] = reg(y, L.WX); f.wline[y] = reg(y, L.WIN_LINE); f.bgp[y] = reg(y, L.BGP);
    f.rendered[y] = reg(y, L.FLAGS) & 1;
    const key = ((lc >> 3) & 1) | (((lc >> 4) & 1) << 1);
    f.bgkey[y] = f.rendered[y] ? key : -1;
    f.wkey[y] = ((lc >> 6) & 1) | (((lc >> 4) & 1) << 1);
    f.wxs[y] = f.wx[y] - 7;
    let winOn = false;
    for (let x = 0; x < W; x++) if (t.win[(y * W + x) * 4 + 3]) { winOn = true; break; }
    const hasWin = !!f.rendered[y] && f.wline[y] !== 255 && winOn;
    f.woff[y] = hasWin ? f.wline[y] - y : NO_WIN;
    if (!f.rendered[y]) continue;
    f.invRow[key * 256 + ((y + f.scy[y]) & 255)] = y; // last line wins, like the reference
    drawn++;
    if ((lc >> 2) & 1) tall++;
    if (hasWin) f.invWin[f.wkey[y] * 256 + f.wline[y]] = y;
    for (let k = 0; k < reg(y, L.NSPR); k++) {
      const o = L.SPRITES + 5 * k;
      f.spr.set(reg(y, o), [reg(y, o + 1), reg(y, o + 2), reg(y, o + 3), reg(y, o + 4)]);
    }
  }
  f.h = tall * 2 > Math.max(drawn, 1) ? 16 : 8;
  return f;
}

/** Sprite pairs a -> b: same OAM slot and tile within 32 px, else the nearest free sprite with the same tile and attributes. */
export function matchSprites(a: Parsed, b: Parsed, maxd = 32): Map<number, number> {
  const pairs = new Map<number, number>(), used = new Set<number>();
  for (const [s, v] of a.spr) {
    const w = b.spr.get(s);
    if (w && (w[2] & 0xfe) === (v[2] & 0xfe) && Math.abs(w[0] - v[0]) <= maxd && Math.abs(w[1] - v[1]) <= maxd) { pairs.set(s, s); used.add(s); }
  }
  for (const [s, v] of a.spr) {
    if (pairs.has(s)) continue;
    let best: [number, number] | null = null;
    for (const [k, w] of b.spr) {
      if (used.has(k) || w[2] !== v[2] || w[3] !== v[3]) continue;
      const d = Math.abs(w[0] - v[0]) + Math.abs(w[1] - v[1]);
      if (!best || d < best[0] || (d === best[0] && k < best[1])) best = [d, k];
    }
    if (best && best[0] <= maxd) { pairs.set(s, best[1]); used.add(best[1]); }
  }
  return pairs;
}

export interface Tables { nearA: boolean; N: Parsed; lp: Int32Array; items: Int32Array; nItems: number; cgb: boolean }

/** Everything the shaders need for the frame at `tau` between A and B. */
export function tables(A: Parsed, B: Parsed, tau: number): Tables {
  const nearA = tau <= 0.5, N = nearA ? A : B, t = tau;
  const lp = new Int32Array(H * 8);
  for (let y = 0; y < H; y++) {
    const same = A.bgkey[y] === B.bgkey[y] && A.bgkey[y] >= 0;
    const keyl = N.bgkey[y] >= 0 ? N.bgkey[y] : Math.max(A.bgkey[y], B.bgkey[y]);
    const sx = same ? roundEven((A.scx[y] + t * wrap8(B.scx[y] - A.scx[y])) * S) : N.scx[y] * S;
    const sy = same ? roundEven((A.scy[y] + t * wrap8(B.scy[y] - A.scy[y])) * S) : N.scy[y] * S;
    const moved = A.scx[y] !== B.scx[y] || A.scy[y] !== B.scy[y];
    const rb = A.rendered[y] && B.rendered[y];
    const ha = A.woff[y] !== NO_WIN, hb = B.woff[y] !== NO_WIN, hn = N.woff[y] !== NO_WIN;
    const o = ha && hb ? roundEven((A.woff[y] + t * (B.woff[y] - A.woff[y])) * S) : N.woff[y] * S;
    const wx = ha && hb ? roundEven((A.wxs[y] + t * (B.wxs[y] - A.wxs[y])) * S) : N.wxs[y] * S;
    const flags = (keyl >= 0 ? 1 : 0) | (moved ? 2 : 0) | (rb ? 4 : 0) | (hn ? 8 : 0) | (N.lcdc[y] & 1 ? 16 : 0);
    lp.set([sx, sy, Math.max(keyl, 0), flags, hn ? o : 0, hn ? wx : 0, N.wkey[y], N.bgp[y]], y * 8);
  }
  // Sprite draw list: [py4, px4, h, attr, srcNear, slotNear, oyNear, oxNear, farOk, slotFar, oyFar, oxFar, order, 0, 0, 0]
  const pairs = matchSprites(A, B), inv = new Map([...pairs].map(([k, v]) => [v, k]));
  const items: number[][] = [];
  const push = (py: number, px: number, near: number[], srcNear: number, slotNear: number, far: number[] | null, slotFar: number) => {
    const farOk = !!far && near[2] === far[2] && near[3] === far[3] && (srcNear ? B.h : A.h) === (srcNear ? A.h : B.h);
    items.push([py, px, N.h, near[3], srcNear, slotNear, near[0] - 16, near[1] - 8, farOk ? 1 : 0, farOk ? slotFar : 255,
      far ? far[0] - 16 : 0, far ? far[1] - 8 : 0, N.cgb ? slotNear : (px + 1024) * 256 + slotNear, 0, 0, 0]);
  };
  for (const [s, v] of A.spr) {
    const k = pairs.get(s);
    if (k !== undefined) {
      const w = B.spr.get(k)!;
      const py = roundEven((v[0] - 16 + t * (w[0] - v[0])) * S), px = roundEven((v[1] - 8 + t * (w[1] - v[1])) * S);
      if (nearA) push(py, px, v, 0, s, w, k); else push(py, px, w, 1, k, v, s);
    } else if (nearA) push((v[0] - 16) * S, (v[1] - 8) * S, v, 0, s, null, 255);
  }
  for (const [s, w] of B.spr) if (!inv.has(s) && !nearA) push((w[0] - 16) * S, (w[1] - 8) * S, w, 1, s, null, 255);
  const it = new Int32Array(Math.max(items.length, 1) * 16);
  items.forEach((r, i) => it.set(r, i * 16));
  return { nearA, N, lp, items: it, nItems: items.length, cgb: N.cgb };
}

/**
 * Share of B's pixels that A predicts: unchanged, or equal to A moved by the line's BG scroll change.
 * Below `CUT` the pair is a scene cut (a new screen, a fade to black): nothing to interpolate.
 */
export const CUT = 0.75;
export function predictability(A: Parsed, B: Parsed): number {
  let ok = 0;
  const a = A.final, b = B.final;
  for (let y = 0; y < H; y++) {
    const dy = wrap8(B.scy[y] - A.scy[y]), dx = wrap8(B.scx[y] - A.scx[y]);
    const sy = y + dy;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) { ok++; continue; }
      const sx = x + dx;
      if (sy < 0 || sy >= H || sx < 0 || sx >= W) continue;
      const j = (sy * W + sx) * 4;
      if (a[j] === b[i] && a[j + 1] === b[i + 1] && a[j + 2] === b[i + 2]) ok++;
    }
  }
  return ok / (W * H);
}

/**
 * Steady motion: every BG line that moved from P to A or from A to B moved by the same amount both times.
 * Games that scroll every other frame (30 Hz) or in bursts fail this, and then a real frame is held:
 * interpolating them would show positions the game never drew.
 */
export function steady(P: Parsed, A: Parsed, B: Parsed): boolean {
  let moving = 0, uneven = 0;
  for (let y = 0; y < H; y++) {
    if (P.bgkey[y] < 0 || P.bgkey[y] !== A.bgkey[y] || A.bgkey[y] !== B.bgkey[y]) continue;
    const ax = wrap8(A.scx[y] - P.scx[y]), ay = wrap8(A.scy[y] - P.scy[y]);
    const bx = wrap8(B.scx[y] - A.scx[y]), by = wrap8(B.scy[y] - A.scy[y]);
    if (!ax && !ay && !bx && !by) continue;
    moving++;
    if (ax !== bx || ay !== by) uneven++;
  }
  return uneven * 2 <= moving;
}

// ---------------------------------------------------------------- GPU

const VS = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

// Shared GLSL: BG sampling in map space for frame f (0 = A, 1 = B). Texel row = Game Boy line (4x: line * 4).
const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D; precision highp isampler2D;
uniform usampler2D uBg[2], uWin[2], uObj[2], uInfo[2], uLines[2], uInv, uVram;
uniform isampler2D uLp, uItems;
uniform int uNearA, uNItems, uCgb;
ivec4 lp0(int y) { return texelFetch(uLp, ivec2(0, y), 0); }
ivec4 lp1(int y) { return texelFetch(uLp, ivec2(1, y), 0); }
uvec4 fetchU(usampler2D s, int x, int y) { return texelFetch(s, ivec2(x, y), 0); }
uvec4 lr0(int f, int y) { return f == 0 ? fetchU(uLines[0], 0, y) : fetchU(uLines[1], 0, y); }
uvec4 lr1(int f, int y) { return f == 0 ? fetchU(uLines[0], 1, y) : fetchU(uLines[1], 1, y); }
uvec4 plane(int which, int f, int x, int y) {
  if (which == 0) return f == 0 ? fetchU(uBg[0], x, y) : fetchU(uBg[1], x, y);
  if (which == 1) return f == 0 ? fetchU(uWin[0], x, y) : fetchU(uWin[1], x, y);
  if (which == 2) return f == 0 ? fetchU(uObj[0], x, y) : fetchU(uObj[1], x, y);
  return f == 0 ? fetchU(uInfo[0], x, y) : fetchU(uInfo[1], x, y);
}
int invRow(int f, int key, int row) { return int(texelFetch(uInv, ivec2(row, f * 4 + key), 0).r); }
int invWin(int f, int key, int wl) { return int(texelFetch(uInv, ivec2(wl, 8 + f * 4 + key), 0).r); }
bool bgSample(int f, int key, int my, int mx, out uvec3 rgb, out uint cid) {
  int ly = invRow(f, key, my);
  if (ly == 255) return false;
  int x = (mx - int(lr0(f, ly).g)) & 255;
  if (x >= ${W}) return false;
  rgb = plane(0, f, x, ly).rgb;
  uvec4 inf = plane(3, f, x, ly);
  bool underWin = plane(1, f, x, ly).a > 0u;
  cid = underWin ? 255u : ((inf.b & 3u) | (((inf.b >> 2) & 1u) << 2));
  return true;
}
void mapCoord(ivec2 p, out int my, out int mx, out int key, out int flags) {
  ivec4 a = lp0(p.y >> 2);
  mx = ((p.x + a.x + 4096) >> 2) & 255;
  my = ((p.y + a.y + 4096) >> 2) & 255;
  key = a.z; flags = a.w;
}
`;

// Pass 1: agreement flags for the screen-still vote (r: screen agrees and both frames saw it, g: map agrees).
const FS_AGREE = `${COMMON}
out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int my, mx, key, flags; mapCoord(p, my, mx, key, flags);
  bool okl = (flags & 1) != 0;
  uvec3 c0, c1; uint i0, i1;
  int fn = uNearA == 1 ? 0 : 1;
  bool v0 = okl && bgSample(fn, key, my, mx, c0, i0);
  bool v1 = okl && bgSample(1 - fn, key, my, mx, c1, i1);
  int line = p.y >> 2, x = p.x >> 2;
  bool scr = (flags & 4) != 0 && all(equal(plane(0, 0, x, line).rgb, plane(0, 1, x, line).rgb));
  o = uvec4(scr && v0 && v1 ? 1u : 0u, v0 && v1 && all(equal(c0, c1)) ? 1u : 0u, 0u, 0u);
}`;

// Pass 2: horizontal 33-tap sums (clamped at the edges).
const FS_HSUM = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uIn; out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); uvec2 s = uvec2(0);
  for (int k = -16; k <= 16; k++) s += texelFetch(uIn, ivec2(clamp(p.x + k, 0, ${OW - 1}), p.y), 0).rg;
  o = uvec4(s, 0u, 0u);
}`;

// Pass 3: BG from the nearer frame (the other fills what it never showed), the screen-still vote, VRAM for
// content neither frame showed, the window, then sprites with the DMG / CGB priority rules.
const FS_FINAL = `${COMMON}
uniform usampler2D uH, uFinalN;
out vec4 o;
uvec3 dmg(uint shade) {
  if (shade == 0u) return uvec3(224u, 248u, 208u);
  if (shade == 1u) return uvec3(136u, 192u, 112u);
  if (shade == 2u) return uvec3(52u, 104u, 86u);
  return uvec3(8u, 24u, 32u);
}
uint vram(int a) { return texelFetch(uVram, ivec2(a & 127, a >> 7), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int line = p.y >> 2, x1 = p.x >> 2;
  int my, mx, key, flags; mapCoord(p, my, mx, key, flags);
  ivec4 l1 = lp1(line);
  bool okl = (flags & 1) != 0;
  int fn = uNearA == 1 ? 0 : 1, ff = 1 - fn;
  uvec3 out_ = uvec3(0); uint lid = 255u; bool filled = false;
  uvec3 c0, c1; uint i0 = 255u, i1 = 255u;
  bool v0 = okl && bgSample(fn, key, my, mx, c0, i0);
  bool v1 = okl && bgSample(ff, key, my, mx, c1, i1);
  if (v0) { out_ = c0; lid = i0; filled = true; } else if (v1) { out_ = c1; lid = i1; filled = true; }
  if ((flags & 2) != 0 && (flags & 4) != 0) {
    uvec2 s = uvec2(0);
    for (int k = -16; k <= 16; k++) s += texelFetch(uH, ivec2(p.x, clamp(p.y + k, 0, ${OH - 1})), 0).rg;
    if (s.r > s.g) {
      out_ = plane(0, fn, x1, line).rgb;
      uvec4 inf = plane(3, fn, x1, line);
      lid = plane(1, fn, x1, line).a > 0u ? 255u : ((inf.b & 3u) | (((inf.b >> 2) & 1u) << 2));
      filled = true;
    }
  }
  if (lid == 255u && v1 && i1 != 255u && i0 == 255u) lid = i1;
  if (!filled && okl) {
    int base = (key & 1) != 0 ? 0x1C00 : 0x1800;
    int mi = base + (my >> 3) * 32 + (mx >> 3);
    int tmap = int(vram(mi));
    int attr = uCgb == 1 ? int(vram(0x2000 + mi)) : 0;
    int idx = (key & 2) != 0 ? tmap : 256 + (((tmap + 128) & 255) - 128);
    int row = my & 7, col = mx & 7;
    if ((attr & 0x40) != 0) row = 7 - row;
    if ((attr & 0x20) != 0) col = 7 - col;
    int ad = ((attr >> 3) & 1) * 0x2000 + idx * 16 + row * 2;
    uint lo = vram(ad), hi = vram(ad + 1);
    uint bit = uint(7 - col);
    uint cid = ((lo >> bit) & 1u) | (((hi >> bit) & 1u) << 1);
    if (uCgb == 1) {
      int ci = 0x4000 + (attr & 7) * 8 + int(cid) * 2;
      uint v = vram(ci) | (vram(ci + 1) << 8);
      out_ = uvec3((v & 31u) * 255u / 31u, ((v >> 5) & 31u) * 255u / 31u, ((v >> 10) & 31u) * 255u / 31u);
    } else {
      out_ = dmg((uint(l1.w) >> (2u * cid)) & 3u);
    }
    lid = cid | (uint((attr >> 7) & 1) << 2);
    filled = true;
  }
  bool holes = !filled;
  if ((flags & 8) != 0) {
    int wl = p.y + l1.x, u = p.x - l1.y;
    if (wl >= 0 && u >= 0) {
      int wli = min(wl >> 2, 255), ui = min(u >> 2, 255);
      for (int k = 0; k < 2; k++) {
        int f = k == 0 ? fn : ff;
        int ly = invWin(f, l1.z, wli);
        if (ly == 255) continue;
        int x = ui + int(lr0(f, ly).a) - 7;
        if (x < 0 || x >= ${W}) continue;
        uvec4 w = plane(1, f, x, ly);
        if (w.a == 0u) continue;
        out_ = w.rgb;
        uvec4 inf = plane(3, f, x, ly);
        lid = (inf.b & 3u) | (((inf.b >> 2) & 1u) << 2);
        holes = false;
        break;
      }
    }
  }
  int bestKey = 0x7fffffff; uvec3 oc = uvec3(0); int oattr = 0;
  for (int i = 0; i < uNItems; i++) {
    ivec4 t0 = texelFetch(uItems, ivec2(0, i), 0);
    int ly = p.y - t0.x, lx = p.x - t0.y;
    if (ly < 0 || lx < 0 || ly >= t0.z * 4 || lx >= 32) continue;
    ly >>= 2; lx >>= 2;
    ivec4 t1 = texelFetch(uItems, ivec2(1, i), 0), t2 = texelFetch(uItems, ivec2(2, i), 0), t3 = texelFetch(uItems, ivec2(3, i), 0);
    if (t3.x >= bestKey) continue;
    int state = 0; uvec3 col = uvec3(0);
    for (int k = 0; k < 2 && state == 0; k++) {
      if (k == 1 && t2.x == 0) break;
      int f = k == 0 ? t1.x : 1 - t1.x;
      int slot = k == 0 ? t1.y : t2.y;
      int gy = (k == 0 ? t1.z : t2.z) + ly, gx = (k == 0 ? t1.w : t2.w) + lx;
      if (gy < 0 || gy >= ${H} || gx < 0 || gx >= ${W}) continue;
      uvec4 inf = plane(3, f, gx, gy);
      uvec4 ob = plane(2, f, gx, gy);
      if (int(inf.g) == slot && ob.a > 0u && ((inf.b >> 4) & 3u) != 0u) { state = 1; col = ob.rgb; }
      else if (inf.g == 255u && (lr1(f, gy).b & 1u) != 0u) state = 2;
    }
    if (state == 1) { bestKey = t3.x; oc = col; oattr = t0.w; }
  }
  if (bestKey != 0x7fffffff) {
    bool known = lid != 255u;
    bool underOpaque = known ? (lid & 3u) != 0u : true;
    bool behind = (oattr & 0x80) != 0;
    bool tprio = known ? ((lid >> 2) & 1u) != 0u : false;
    bool bgOn = (flags & 16) != 0;
    bool wins = uCgb == 1 ? (!bgOn || !underOpaque || (!tprio && !behind)) : (!underOpaque || !behind);
    if (wins) { out_ = oc; holes = false; }
  }
  if (holes) out_ = texelFetch(uFinalN, ivec2(x1, line), 0).rgb;
  o = vec4(vec3(out_) / 255.0, 1.0);
}`;

interface Tex { t: WebGLTexture; fmt: number; type: number; w: number; h: number }
interface Prog { p: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null }
const MAX_ITEMS = 96;

export class FrameGen {
  private gl: WebGL2RenderingContext;
  private pAgree: Prog; private pH: Prog; private pFinal: Prog;
  private planes: { bg: Tex; win: Tex; obj: Tex; info: Tex; fin: Tex; lines: Tex }[];
  private inv: Tex; private vram: Tex; private lp: Tex; private items: Tex; private agree: Tex; private hsum: Tex;
  private fbs: WebGLFramebuffer[];
  private T: Tables | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.pAgree = this.prog(FS_AGREE); this.pH = this.prog(FS_HSUM); this.pFinal = this.prog(FS_FINAL);
    const U8: [number, number, number] = [gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE];
    this.planes = [0, 1].map(() => ({ bg: this.tex(...U8, W, H), win: this.tex(...U8, W, H), obj: this.tex(...U8, W, H), info: this.tex(...U8, W, H), fin: this.tex(...U8, W, H), lines: this.tex(...U8, 2, H) }));
    this.inv = this.tex(gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 256, 16);
    this.vram = this.tex(gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 128, 129);
    this.lp = this.tex(gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 2, H);
    this.items = this.tex(gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 4, MAX_ITEMS);
    this.agree = this.tex(gl.RG8UI, gl.RG_INTEGER, gl.UNSIGNED_BYTE, OW, OH);
    this.hsum = this.tex(gl.RG8UI, gl.RG_INTEGER, gl.UNSIGNED_BYTE, OW, OH);
    this.fbs = [this.agree, this.hsum].map((t) => {
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.t, 0);
      return fb;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Uploads a frame's planes into slot `i` (0 = A, 1 = B), straight from the core's memory. */
  setFrame(i: number, t: FrameTrace, f: Parsed): void {
    const P = this.planes[i], n = W * H * 4;
    this.up(P.bg, t.bg.subarray(0, n)); this.up(P.win, t.win.subarray(0, n)); this.up(P.obj, t.obj.subarray(0, n));
    this.up(P.info, t.info.subarray(0, n)); this.up(P.fin, t.final.subarray(0, n));
    const lines = new Uint8Array(H * 8);
    for (let y = 0; y < H; y++) lines.set([f.lcdc[y], f.scx[y], f.scy[y], f.wx[y], f.wline[y], 0, f.rendered[y], 0], y * 8);
    this.up(P.lines, lines);
  }

  /** The tables for the frame at `tau` between A (slot 0) and B (slot 1). */
  setPair(A: Parsed, B: Parsed, tau: number): void {
    const T = tables(A, B, tau);
    const inv = new Uint8Array(256 * 16);
    inv.set(A.invRow, 0); inv.set(B.invRow, 1024); inv.set(A.invWin, 2048); inv.set(B.invWin, 3072);
    this.up(this.inv, inv);
    const v = new Uint8Array(128 * 129);
    v.set(T.N.meta.subarray(VRAM_OFF, VRAM_OFF + 0x4000), 0);
    v.set(T.N.meta.subarray(BG_CRAM_OFF, BG_CRAM_OFF + 64), 0x4000);
    this.up(this.vram, v);
    this.up(this.lp, T.lp);
    if (T.nItems) this.up(this.items, T.items.subarray(0, Math.min(T.nItems, MAX_ITEMS) * 16), 4, Math.min(T.nItems, MAX_ITEMS));
    this.T = T;
  }

  /** B becomes A: the slots trade places instead of uploading A again. */
  swap(): void { this.planes.reverse(); }

  /** Draws the in-between frame into `target` (640x576, RGBA8, raw colours). */
  render(target: WebGLFramebuffer): void {
    const gl = this.gl;
    gl.viewport(0, 0, OW, OH);
    this.draw(this.pAgree, this.fbs[0]);
    this.draw(this.pH, this.fbs[1], (bind) => bind('uIn', this.agree));
    this.draw(this.pFinal, target, (bind) => { bind('uH', this.hsum); bind('uFinalN', this.planes[this.T!.nearA ? 0 : 1].fin); });
  }

  private draw(pr: Prog, fbo: WebGLFramebuffer, extra?: (bind: (name: string, t: Tex) => void) => void): void {
    const gl = this.gl;
    gl.useProgram(pr.p);
    let unit = 0;
    const bind = (name: string, t: Tex) => {
      const l = pr.loc(name);
      if (!l) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.t);
      gl.uniform1i(l, unit++);
    };
    if (pr !== this.pH) {
      for (let i = 0; i < 2; i++) {
        const P = this.planes[i];
        bind(`uBg[${i}]`, P.bg); bind(`uWin[${i}]`, P.win); bind(`uObj[${i}]`, P.obj); bind(`uInfo[${i}]`, P.info); bind(`uLines[${i}]`, P.lines);
      }
      bind('uInv', this.inv); bind('uVram', this.vram); bind('uLp', this.lp); bind('uItems', this.items);
      const T = this.T!;
      gl.uniform1i(pr.loc('uNearA'), T.nearA ? 1 : 0);
      gl.uniform1i(pr.loc('uNItems'), Math.min(T.nItems, MAX_ITEMS));
      gl.uniform1i(pr.loc('uCgb'), T.cgb ? 1 : 0);
    }
    extra?.(bind);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    const gl = this.gl;
    for (const p of [this.pAgree, this.pH, this.pFinal]) gl.deleteProgram(p.p);
    for (const P of this.planes) for (const t of Object.values(P)) gl.deleteTexture(t.t);
    for (const t of [this.inv, this.vram, this.lp, this.items, this.agree, this.hsum]) gl.deleteTexture(t.t);
    for (const f of this.fbs) gl.deleteFramebuffer(f);
  }

  private up(t: Tex, data: ArrayBufferView, w = t.w, h = t.h): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, t.fmt, t.type, data);
  }

  private tex(ifmt: number, fmt: number, type: number, w: number, h: number): Tex {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    return { t, fmt, type, w, h };
  }

  private prog(fs: string): Prog {
    const gl = this.gl, p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`motion shader: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.bindAttribLocation(p, 0, 'a_position');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`motion link: ${gl.getProgramInfoLog(p)}`);
    const cache = new Map<string, WebGLUniformLocation | null>();
    return { p, loc: (name) => { if (!cache.has(name)) cache.set(name, gl.getUniformLocation(p, name)); return cache.get(name)!; } };
  }
}
