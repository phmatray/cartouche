/**
 * Neural 4x upscaler, WebGL2. Two learned models, one output (docs/NEURAL.md):
 *
 * - Tile-aware network (tile4x.bin): runs on the BG and window MAPS, in colour-id space, never on the frame.
 *   Each map (256x256 colour ids) goes through 8 residual 3x3 conv layers; the head gives, for each of the
 *   16 subpixels of a map pixel, weights over the 4 colour ids of its 3x3 neighbourhood. The result is cached
 *   in a 1024x1024 atlas per map and only the cells whose tiles or map entries changed are recomputed, a
 *   bounded number per frame. The frame is then rebuilt from each line's scroll/window registers, with that
 *   line's palette applied last, so scrolling moves the cached result exactly and fades only recolour it.
 *   A colour id that the pixel's on-screen neighbours show in another colour (a palette rewritten between
 *   lines, a neighbour cell with another CGB palette) takes the colour the screen shows.
 * - Learned-classical table (lc4x.bin): a 16-bit colour-equality key over a 5x5 window picks, per subpixel,
 *   a neighbour and a blend amount. Used where the tile path does not apply: next to sprites or where layers
 *   meet, map cells still being computed, blocks whose centre does not reproduce the frame (VRAM or palette
 *   written mid-frame), and whole frames without a usable trace (previews, a state just loaded).
 *
 * Both keep every block's central 2x2 equal to the source pixel. Output: raw colours at 640x576; the colour
 * pass (palette, correction, ghosting) runs after it.
 */
import tileUrl from './weights/tile4x.bin?url';
import lcUrl from './weights/lc4x.bin?url';
import { SNAP, lcTexture, packTileNet, parseLc, parseTileNet, type LcTable, type TileNet } from './weights';
import {
  COMBOS, H, L, LINES_OFF, LINE_LEN, MapState, W, bgCombo, clearRect, isCgb, lineReg, linePalettes, planRegion, rendered,
  validTrace, vramOf, winCombo, wrapSpans, type FrameTrace, type Rect,
} from './trace';

export interface NeuralWeights { net: TileNet; lc: LcTable }

let loading: Promise<NeuralWeights> | null = null;
/** Fetches and parses both weight files once per page. */
export function loadWeights(): Promise<NeuralWeights> {
  loading ??= Promise.all([tileUrl, lcUrl].map((u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    return r.arrayBuffer();
  }))).then(([t, l]) => ({ net: parseTileNet(t), lc: parseLc(l) }));
  loading.catch(() => { loading = null; });
  return loading;
}

export const OUT_W = W * 4, OUT_H = H * 4;

const VS = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp usampler2D;
precision highp usampler2DArray; precision highp sampler2DArray;
`;

/** Hidden activations: G groups of 4 channels side by side, 256 px each, the map wrapping. */
const hiddenFetch = `
uniform sampler2D uH;
vec4 Hd(int g, ivec2 p) { return texelFetch(uH, ivec2(g * 256 + (p.x & 255), p.y & 255), 0); }`;

const inputShader = () => `${HEAD}
uniform usampler2DArray uIds; uniform int uLayer, uGroup;
layout(std140) uniform Wts { vec4 w[36]; vec4 b; };
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); p.x -= uGroup * 256;
  vec4 acc = b;
  for (int t = 0; t < 9; t++) {
    uint id = texelFetch(uIds, ivec3((p + ivec2(t % 3 - 1, t / 3 - 1)) & 255, uLayer), 0).r;
    acc += w[t * 4 + int(id)];
  }
  o = max(acc, 0.0);
}`;

const bodyShader = (G: number) => `${HEAD}${hiddenFetch}
uniform int uGroup;
layout(std140) uniform Wts { mat4 w[${9 * G}]; vec4 b; };
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); p.x -= uGroup * 256;
  vec4 acc = b;
  for (int t = 0; t < 9; t++) {
    ivec2 q = p + ivec2(t % 3 - 1, t / 3 - 1);
    for (int g = 0; g < ${G}; g++) acc += w[t * ${G} + g] * Hd(g, q);
  }
  o = max(acc, 0.0) + Hd(uGroup, p);
}`;

const headShader = (G: number) => `${HEAD}${hiddenFetch}
uniform usampler2DArray uIds; uniform int uLayer;
layout(std140) uniform Wts { mat4 w[${16 * G}]; vec4 b[16]; };
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy), p = q >> 2, s = q & 3;
  uint cid = texelFetch(uIds, ivec3(p & 255, uLayer), 0).r;
  vec4 onehot = vec4(equal(uvec4(cid), uvec4(0u, 1u, 2u, 3u)));
  if (all(greaterThanEqual(s, ivec2(1))) && all(lessThanEqual(s, ivec2(2)))) { o = onehot; return; } // central 2x2: the source id
  int k = s.y * 4 + s.x;
  vec4 lg = b[k];
  for (int g = 0; g < ${G}; g++) lg += w[k * ${G} + g] * Hd(g, p);
  vec4 present = vec4(0.0);
  for (int t = 0; t < 9; t++) {
    uint id = texelFetch(uIds, ivec3((p + ivec2(t % 3 - 1, t / 3 - 1)) & 255, uLayer), 0).r;
    present = max(present, vec4(equal(uvec4(id), uvec4(0u, 1u, 2u, 3u))));
  }
  lg = mix(vec4(-1e4), lg, present); // no colour that is not in the 3x3 neighbourhood
  vec4 e = exp(lg - max(max(lg.x, lg.y), max(lg.z, lg.w)));
  vec4 wt = e / dot(e, vec4(1.0));
  wt *= step(${SNAP.toFixed(2)}, wt);
  o = wt / dot(wt, vec4(1.0));
}`;

/** The frame at 4x: tile path where it applies, learned-classical elsewhere (see the file comment). */
const composeShader = (lc: LcTable) => {
  const at = (w: number) => `ivec2(${(w % 5) - 2}, ${Math.floor(w / 5) - 2})`;
  const key = lc.pairs.map(([p, q]) => `k = (k << 1) | uint(F(${at(p)}) == F(${at(q)}));`).join('\n  ');
  // A B D C G F H of the canonical quadrant, as (dx, dy)
  const src = [[-1, -1], [-1, 0], [0, -1], [-1, 1], [1, -1], [0, 1], [1, 0]].map(([dy, dx]) => `ivec2(${dx}, ${dy})`).join(', ');
  return `${HEAD}
uniform sampler2D uFrame;
uniform usampler2D uLcTab, uInfo, uLines, uPal;
uniform usampler2DArray uIds, uCell;
uniform sampler2DArray uAtlas;
uniform int uTile, uDebug;
out vec4 o;
ivec2 P, flipv;
vec3 raw(ivec2 p) { return floor(texelFetch(uFrame, clamp(p, ivec2(0), ivec2(${W - 1}, ${H - 1})), 0).rgb * 255.0 + 0.5); }
vec3 F(ivec2 d) { return raw(P + d * flipv); }

// Learned-classical: each quadrant in a canonical top-left frame, a key of colour-equality bits, a table entry
// per free subpixel: E + alpha * (S - E), S one of 7 neighbours. Bit-exact with the reference (lc.py).
vec3 lc(ivec2 b) {
  flipv = ivec2(b.x >= 2 ? -1 : 1, b.y >= 2 ? -1 : 1);
  ivec2 c = ivec2(b.x >= 2 ? 3 - b.x : b.x, b.y >= 2 ? 3 - b.y : b.y);
  vec3 E = F(ivec2(0));
  if (c == ivec2(1)) return E;
  uint k = 0u;
  ${key}
  uint ent = texelFetch(uLcTab, ivec2(int(k & 255u), int(k >> 8)), 0)[c.y == 0 ? c.x : 2];
  uint s = ent >> 5;
  if (s == 0u) return E;
  ivec2 so[7] = ivec2[7](${src});
  return clamp(floor(E + float(ent & 31u) / 31.0 * (F(so[int(s) - 1]) - E) + 0.5), 0.0, 255.0);
}

uvec4 reg(int k) { return texelFetch(uLines, ivec2(k, P.y), 0); } // bytes 4k..4k+3 of this line's record
vec3 pal(int e) { return vec3(texelFetch(uPal, ivec2(e, P.y), 0).rgb); }

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  P = q >> 2;
  int route = 0; // 0 no trace, 1 tile, 2 sprite or layer edge, 3 centre mismatch, 4 cell pending, 5 other
  if (uTile == 1) {
    route = 5;
    uvec4 r0 = reg(0), r1 = reg(1), r2 = reg(2); // LCDC SCX SCY WX | WY WLINE WINX BGP | OBP0 OBP1 FLAGS NSPR
    uint layer = texelFetch(uInfo, P, 0).r;
    bool pure = layer < 2u;
    for (int t = 0; t < 9 && pure; t++) pure = texelFetch(uInfo, clamp(P + ivec2(t % 3 - 1, t / 3 - 1), ivec2(0), ivec2(${W - 1}, ${H - 1})), 0).r == layer;
    uint lcdc = r0.x;
    if (!pure) route = 2;
    else if ((r2.z & 1u) != 0u && ((r2.z & 2u) != 0u || (lcdc & 1u) != 0u) && (layer == 0u || r1.y != 255u)) {
      int combo; ivec2 m4;
      if (layer == 0u) {
        combo = int(((lcdc >> 3) & 1u) | (((lcdc >> 4) & 1u) << 1));
        m4 = ivec2((4 * int(r0.y) + q.x) & 1023, 4 * ((int(r0.z) + P.y) & 255) + (q.y & 3));
      } else {
        combo = int(((lcdc >> 6) & 1u) | (((lcdc >> 4) & 1u) << 1));
        m4 = ivec2(clamp(q.x - 4 * (int(r0.w) - 7), 0, 1023), 4 * int(r1.y) + (q.y & 3));
      }
      uvec2 cell = texelFetch(uCell, ivec3(m4 >> 5, combo), 0).rg;
      if (cell.g != 0u) route = 4;
      else {
        int pe = int(cell.r & 7u) * 4;
        uint cid = texelFetch(uIds, ivec3(m4 >> 2, combo), 0).r;
        if (pal(pe + int(cid)) != raw(P)) route = 3;
        else {
          // Each colour id is coloured the way the screen shows it around the pixel: this line's palette when an
          // on-screen neighbour with that id shows it, else the first on-screen neighbour with that id (a palette
          // rewritten between lines, or a neighbour cell with another CGB palette).
          vec3 base[4] = vec3[4](pal(pe), pal(pe + 1), pal(pe + 2), pal(pe + 3));
          vec3 first[4] = base;
          bool has[4] = bool[4](false, false, false, false);
          bool match[4] = has;
          for (int t = 0; t < 9; t++) {
            ivec2 d = ivec2(t % 3 - 1, t / 3 - 1), s = P + d;
            if (s.x < 0 || s.y < 0 || s.x > ${W - 1} || s.y > ${H - 1}) continue;
            int j = int(texelFetch(uIds, ivec3(((m4 >> 2) + d) & 255, combo), 0).r);
            vec3 r = raw(s);
            if (r == base[j]) match[j] = true;
            if (!has[j]) first[j] = r;
            has[j] = true;
          }
          for (int j = 0; j < 4; j++) if (has[j] && !match[j]) base[j] = first[j];
          vec4 w = texelFetch(uAtlas, ivec3(m4, combo), 0);
          vec3 c = w.x * base[0] + w.y * base[1] + w.z * base[2] + w.w * base[3];
          o = uDebug == 1 ? vec4(1.0 / 255.0, 0.0, 0.0, 1.0) : vec4(c / 255.0, 1.0);
          return;
        }
      }
    }
  }
  o = uDebug == 1 ? vec4(float(route) / 255.0, 0.0, 0.0, 1.0) : vec4(lc(q & 3) / 255.0, 1.0);
}`;
};

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

/** Can this context run the tile path (float render targets)? The pixel-space path only needs WebGL2. */
export const tileCapable = (gl: WebGL2RenderingContext) => !!gl.getExtension('EXT_color_buffer_float');

export class NeuralUpscaler {
  /** Most map cells the network recomputes per frame (the rest stay on the fallback until their turn). */
  maxCells = 192;
  private gl: WebGL2RenderingContext;
  private G: number;
  private compose: Prog;
  private net: { input: Prog; body: Prog; head: Prog } | null = null;
  private ubo: WebGLBuffer | null = null;
  private blocks: { offset: number; size: number }[][] = [];
  /** Some are created later (the network's) or on demand (stand-ins): absent keys are really undefined. */
  private tex: Record<string, WebGLTexture> = {};
  private hidden: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private atlasFbo: WebGLFramebuffer[] = [];
  private maps = Array.from({ length: COMBOS }, () => new MapState());
  private pal = new Uint8Array(H * 32 * 4);
  private turn = 0;
  private weights: NeuralWeights;
  /** The tile network is set up on the first frame with a usable trace (previews never pay for it). */
  private netState: 'untried' | 'ok' | 'failed' = 'untried';

  constructor(gl: WebGL2RenderingContext, weights: NeuralWeights) {
    this.weights = weights;
    this.gl = gl;
    this.G = weights.net.C / 4;
    this.compose = this.link(composeShader(weights.lc));
    const lct = lcTexture(weights.lc);
    this.tex.lc = this.tex2d(gl.RGBA8UI, 256, lct.h, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, lct.data);
    this.tex.info = this.tex2d(gl.RGBA8UI, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, null);
    this.tex.lines = this.tex2d(gl.RGBA8UI, LINE_LEN / 4, H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, null);
    this.tex.pal = this.tex2d(gl.RGBA8UI, 32, H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, null);
  }

  /** The tile path can run here (float render targets, and the network compiled if it was tried). */
  get tileCapable(): boolean { return this.netState !== 'failed' && tileCapable(this.gl); }

  private ensureNet(): boolean {
    if (this.netState === 'untried') this.netState = this.tileCapable && this.initNet(this.weights.net) ? 'ok' : 'failed';
    return this.netState === 'ok';
  }

  private initNet(net: TileNet): boolean {
    const gl = this.gl, G = this.G;
    try {
      this.net = { input: this.link(inputShader()), body: this.link(bodyShader(G)), head: this.link(headShader(G)) };
    } catch (e) {
      console.warn('Neural upscaler: tile network unavailable', e);
      return false;
    }
    const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number;
    const packed = packTileNet(net, align);
    this.blocks = packed.blocks;
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, packed.data, gl.STATIC_DRAW);
    for (const pr of Object.values(this.net)) gl.uniformBlockBinding(pr.p, gl.getUniformBlockIndex(pr.p, 'Wts'), 0);
    this.tex.ids = this.tex3d(gl.R8UI, 256, 256);
    this.tex.cell = this.tex3d(gl.RG8UI, 32, 32);
    this.tex.atlas = this.tex3d(gl.RGBA8, 1024, 1024);
    let complete = true;
    const fbo = (attach: (target: number) => void) => {
      const f = this.fbo(attach);
      complete &&= gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      return f;
    };
    for (let i = 0; i < 2; i++) {
      const tex = this.tex2d(gl.RGBA32F, G * 256, 256, gl.RGBA, gl.FLOAT, null);
      this.hidden.push({ tex, fbo: fbo((f) => gl.framebufferTexture2D(f, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)) });
    }
    for (let c = 0; c < COMBOS; c++) this.atlasFbo.push(fbo((f) => gl.framebufferTextureLayer(f, gl.COLOR_ATTACHMENT0, this.tex.atlas, 0, c)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let c = 0; c < COMBOS; c++) this.uploadCell(c);
    return complete;
  }

  /** Every cached map output is thrown away (a state was loaded, the game changed). */
  invalidate(): void {
    this.maps.forEach((m, c) => { m.invalidate(); if (this.netState === 'ok') this.uploadCell(c); });
  }

  /**
   * Draws the 4x picture of `frame` (an RGBA8 texture holding the raw frame) into `target` (OUT_W x OUT_H).
   * `trace`: the same frame's layer trace, or null for the pixel-space path alone.
   */
  render(frame: WebGLTexture, trace: FrameTrace | null, target: WebGLFramebuffer, debug = false): void {
    const gl = this.gl;
    const tile = validTrace(trace) && this.ensureNet();
    if (tile) this.update(trace!);
    const { p, u } = this.compose;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, OUT_W, OUT_H);
    let unit = 0;
    const bind = (name: string, t: WebGLTexture | undefined, kind: number = gl.TEXTURE_2D) => {
      if (!t) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(kind, t);
      gl.uniform1i(u[name], unit++);
    };
    bind('uFrame', frame);
    bind('uLcTab', this.tex.lc);
    bind('uInfo', this.tex.info);
    bind('uLines', this.tex.lines);
    bind('uPal', this.tex.pal);
    // Without the network, 1x1 stand-ins: every sampler needs a texture of its own type on its own unit.
    this.tex.none ??= this.tex3d(gl.R8UI, 1, 1, 1);
    this.tex.noneF ??= this.tex3d(gl.RGBA8, 1, 1, 1);
    bind('uIds', this.tex.ids ?? this.tex.none, gl.TEXTURE_2D_ARRAY);
    bind('uCell', this.tex.cell ?? this.tex.none, gl.TEXTURE_2D_ARRAY);
    bind('uAtlas', this.tex.atlas ?? this.tex.noneF, gl.TEXTURE_2D_ARRAY);
    gl.uniform1i(u.uTile, tile ? 1 : 0);
    gl.uniform1i(u.uDebug, debug ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Map caches in step with this frame's VRAM, line data uploaded, a bounded share of stale cells recomputed. */
  private update(t: FrameTrace): void {
    const gl = this.gl, meta = t.meta, cgb = isCgb(meta), vram = vramOf(meta);
    const used = new Set<number>();
    for (let y = 0; y < H; y++) {
      if (!rendered(meta, y)) continue;
      const lcdc = lineReg(meta, y, L.LCDC);
      used.add(bgCombo(lcdc));
      if (lineReg(meta, y, L.WIN_LINE) !== 0xff) used.add(winCombo(lcdc));
    }
    for (const c of used) {
      const m = this.maps[c];
      const ch = m.sync(vram, cgb, c);
      if (ch.ids) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.ids);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, c, 256, 256, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, m.ids);
      }
      if (ch.ids || ch.attr) this.uploadCell(c);
    }
    linePalettes(t, this.maps, this.pal);
    this.upload(this.tex.pal, 32, H, this.pal);
    this.upload(this.tex.info, W, H, t.info.subarray(0, W * H * 4));
    this.upload(this.tex.lines, LINE_LEN / 4, H, meta.subarray(LINES_OFF, LINES_OFF + H * LINE_LEN));
    // Network work, one map at a time in turn, within the per-frame budget.
    let budget = this.maxCells;
    const order = [...used].sort((a, b) => ((a - this.turn) & 3) - ((b - this.turn) & 3));
    for (const c of order) {
      while (budget > 0) {
        const plan = planRegion(this.maps[c].pending, budget);
        if (!plan) break;
        this.runNet(c, plan.calc, plan.out);
        clearRect(this.maps[c].pending, plan.out);
        this.uploadCell(c);
        budget -= (plan.out.x1 - plan.out.x0) * (plan.out.y1 - plan.out.y0);
      }
    }
    this.turn = (this.turn + 1) & 3;
  }

  private runNet(combo: number, calc: Rect, out: Rect): void {
    const gl = this.gl, net = this.net!, G = this.G;
    gl.enable(gl.SCISSOR_TEST);
    const px = (r: Rect, s: number) => [r.x0 * s, r.y0 * s, (r.x1 - r.x0) * s, (r.y1 - r.y0) * s];
    // The hidden layers over `calc`, which may wrap around the map edge: up to four scissor boxes.
    const boxes = wrapSpans(calc.y0, calc.y1).flatMap(([y0, y1]) => wrapSpans(calc.x0, calc.x1).map(([x0, x1]) => [x0 * 8, y0 * 8, (x1 - x0) * 8, (y1 - y0) * 8]));
    let src = 0;
    this.blocks.forEach((groups, l) => {
      const last = l === this.blocks.length - 1;
      const prog = l === 0 ? net.input : last ? net.head : net.body;
      gl.useProgram(prog.p);
      if (l > 0) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.hidden[src].tex);
        gl.uniform1i(prog.u.uH, 0);
      }
      if (l === 0 || last) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.ids);
        gl.uniform1i(prog.u.uIds, 1);
        gl.uniform1i(prog.u.uLayer, combo);
      }
      if (last) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlasFbo[combo]);
        gl.viewport(0, 0, 1024, 1024);
        const [x, y, w, h] = px(out, 32);
        gl.scissor(x, y, w, h);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.ubo, groups[0].offset, groups[0].size);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return;
      }
      const dst = l === 0 ? 0 : 1 - src;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hidden[dst].fbo);
      for (let g = 0; g < G; g++) {
        gl.viewport(g * 256, 0, 256, 256);
        gl.uniform1i(prog.u.uGroup, g);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.ubo, groups[g].offset, groups[g].size);
        for (const [x, y, w, h] of boxes) {
          gl.scissor(g * 256 + x, y, w, h);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      src = dst;
    });
    gl.disable(gl.SCISSOR_TEST);
  }

  private uploadCell(c: number): void {
    const gl = this.gl, m = this.maps[c], d = new Uint8Array(2048);
    for (let i = 0; i < 1024; i++) { d[2 * i] = m.attr[i]; d[2 * i + 1] = m.pending[i]; }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex.cell);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, c, 32, 32, 1, gl.RG_INTEGER, gl.UNSIGNED_BYTE, d);
  }

  private upload(t: WebGLTexture, w: number, h: number, data: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
  }

  destroy(): void {
    const gl = this.gl;
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    for (const h of this.hidden) { gl.deleteTexture(h.tex); gl.deleteFramebuffer(h.fbo); }
    for (const f of this.atlasFbo) gl.deleteFramebuffer(f);
    for (const pr of [this.compose, ...Object.values(this.net ?? {})]) gl.deleteProgram(pr.p);
    if (this.ubo) gl.deleteBuffer(this.ubo);
  }

  private tex2d(ifmt: number, w: number, h: number, fmt: number, type: number, data: ArrayBufferView | null): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    this.nearest(gl.TEXTURE_2D);
    if (data) { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, data); }
    return t;
  }

  private tex3d(ifmt: number, w: number, h: number, layers = COMBOS): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, ifmt, w, h, layers);
    this.nearest(gl.TEXTURE_2D_ARRAY);
    return t;
  }

  private nearest(target: number): void {
    const gl = this.gl;
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(target, k, gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(target, k, gl.CLAMP_TO_EDGE);
  }

  private fbo(attach: (target: number) => void): WebGLFramebuffer {
    const gl = this.gl, f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    attach(gl.FRAMEBUFFER);
    return f;
  }

  private link(fs: string): Prog {
    const gl = this.gl, p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.bindAttribLocation(p, 0, 'a_position');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    const u: Prog['u'] = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }
}
