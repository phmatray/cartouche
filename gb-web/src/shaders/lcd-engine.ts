import vertexSource from './vertex.glsl?raw';
import colorSource from './color.glsl?raw';
import upscaleSource from './upscale.glsl?raw';
import outputSource from './output.glsl?raw';
import { colorMode, hasAdjustments, paletteRgb, PRESETS, type Filters } from './filters';
import { loadWeights, NeuralUpscaler, OUT_H, OUT_W } from '../neural/upscaler';
import { Governor, LEVEL_NAMES, neuralStatus } from '../neural/governor';
import { CUT, FrameGen, parse, predictability, steady, type Parsed } from '../neural/motion';
import { validTrace, type FrameTrace } from '../neural/trace';

const W = 160, H = 144;

interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/** Neural 4x and Smooth motion need WebGL 2 (integer textures, texelFetch). Probed once per page. */
let webgl2: boolean | null = null;
export function supportsWebGL2(): boolean {
  if (webgl2 === null) {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return webgl2;
}

/**
 * The display pipeline, all within the frame it is given (no added latency, except Smooth motion):
 *   1. colour (160x144): DMG palette or GBC correction, adjustments, LCD persistence (feeds back on itself)
 *   2. upscale (optional): Scale2x / Scale3x
 *   3. output (canvas size): nearest or sharp bilinear, pixel grid, scanlines, CRT curvature and vignette.
 * Neural 4x and Smooth motion draw the raw frame at 640x576 first (neural/), then run the colour pass at
 * that size, so palettes, correction and ghosting apply to the upscaled picture, then the output pass.
 */
export class LcdEngine {
  private gl: WebGLRenderingContext | null = null;
  private gl2: WebGL2RenderingContext | null = null;
  private progs: { color: Program; up: Program; out: Program } | null = null;
  private quad: WebGLBuffer | null = null;
  private frame: WebGLTexture | null = null;
  private hist: Target[] = [];
  private up: Target | null = null;
  private cur = 0;
  private hasFrame = false;
  /** The next colour pass ignores the history (first frame, or a filter change while paused). */
  private fresh = true;
  private filters: Filters = PRESETS[0].filters;
  private color = false;
  private canvas: HTMLCanvasElement;

  // Neural 4x / Smooth motion: the raw 4x picture, the colour pass history at 4x.
  private neural: NeuralUpscaler | null = null;
  private neuralLoading = false;
  private governor: Governor | null = null;
  private big: Target | null = null;
  /** `big` holds the neural picture of the current frame: a redraw (filters, size) reuses it. */
  private bigValid = false;
  private hist4: Target[] = [];
  private timer: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; pending: WebGLQuery[] } | null = null;
  /** Live frames since the last synchronised timing (only without timer queries). */
  private sinceSample = 0;
  /** The trace of the frame on screen, so a paused redraw keeps the tile path (views stay valid while paused). */
  private lastTrace: FrameTrace | null = null;

  // Smooth motion: the last three traced frames (P before A before B) and whether to hold a real frame.
  private motionOn = false;
  private gen: FrameGen | null = null;
  private mP: Parsed | null = null;
  private mA: Parsed | null = null;
  private mB: Parsed | null = null;
  private hold = true;
  /** The rebuild of the current pair was checked against both real frames. */
  private checked = false;
  private destroyed = false;
  private path = 'lcd';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  init(width: number, height: number): boolean {
    this.canvas.width = width;
    this.canvas.height = height;
    const opts = { antialias: false, alpha: false, depth: false, stencil: false };
    const gl2 = this.canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null;
    const gl = (gl2 ?? this.canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
    if (!gl) return false;
    this.gl = gl;
    this.gl2 = gl2;
    const color = this.link(colorSource), up = this.link(upscaleSource), out = this.link(outputSource);
    if (!color || !up || !out) return false;
    this.progs = { color, up, out };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.frame = this.texture(W, H);
    this.hist = [this.target(W, H), this.target(W, H)];
    if (gl2) {
      const ext = gl2.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) this.timer = { ext, pending: [] };
    }
    return true;
  }

  setFilters(filters: Filters, color: boolean): void {
    if (filters === this.filters && color === this.color) return;
    const neuralBefore = this.filters.upscale === 'neural';
    this.filters = filters;
    this.color = color;
    const n = filters.upscale === 'scale2x' ? 2 : filters.upscale === 'scale3x' ? 3 : 0;
    const gl = this.gl;
    if (gl && (this.up?.w ?? 0) !== n * W) {
      if (this.up) { gl.deleteTexture(this.up.tex); gl.deleteFramebuffer(this.up.fbo); }
      this.up = n ? this.target(n * W, n * H) : null;
    }
    if (filters.upscale === 'neural' && !neuralBefore) { this.bigValid = false; this.startNeural(); }
    this.fresh = true;
    this.redraw();
  }

  /**
   * Smooth motion on or off (the player decides: a fast display, normal speed, no rewind). Off drops the
   * frames it kept, so turning it back on starts clean.
   */
  setMotion(on: boolean): void {
    on = on && !!this.gl2;
    if (on === this.motionOn) return;
    this.motionOn = on;
    this.mP = this.mA = this.mB = null;
    if (on && !this.gen) {
      try { this.gen = new FrameGen(this.gl2!); } catch (e) { console.warn('Smooth motion unavailable', e); this.motionOn = false; }
    }
  }

  /** Canvas backing size in device pixels (kept by the caller at the size it is shown). */
  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.redraw();
  }

  /**
   * `fresh`: the picture jumped (a state loaded, a rewind step), so no ghosting from the frames before it and
   * no cached upscaling. `trace`: the layer trace of this frame (the neural tile path and Smooth motion need
   * it). With Smooth motion on, `tau` is how far the display is between the previous frame and this one.
   */
  renderFrame(framebuffer: Uint8ClampedArray, fresh = false, trace: FrameTrace | null = null, tau = 0): void {
    const gl = this.gl;
    if (!gl || !this.progs) return;
    if (fresh) { this.fresh = true; this.neural?.invalidate(); }
    if (fresh) trace = null;
    this.lastTrace = validTrace(trace) ? trace : null;
    // A traced frame is the whole picture at VBlank; the live framebuffer can hold the top of the next one.
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, validTrace(trace) ? trace.final.subarray(0, W * H * 4) : framebuffer);
    this.hasFrame = true;
    this.bigValid = false;
    if (this.motionOn) this.ingest(trace);
    this.draw(trace, tau, true);
  }

  /**
   * Does the engine use the layer trace right now? Smooth motion, or Neural 4x at the tile level (or still
   * loading). The player turns tracing off otherwise: it costs emulation time.
   */
  usesTrace(): boolean {
    if (this.motionOn) return true;
    if (this.filters.upscale !== 'neural' || !this.gl2) return false;
    return !this.neural ? this.neuralLoading : this.neural.tileCapable && this.governor!.level === 2;
  }

  /** Smooth motion: draw the in-between picture at `tau` (0 = the previous frame, 1 = the last one). */
  drawMotion(tau: number): void {
    if (this.motionOn && this.mA && this.mB) this.draw(null, tau, false);
  }

  /** Draw the last frame again (filters or size changed while paused). */
  private redraw(): void {
    if (this.hasFrame) this.draw(validTrace(this.lastTrace) ? this.lastTrace : null, 0, false);
  }

  private ingest(trace: FrameTrace | null): void {
    if (!this.gen || !validTrace(trace)) { this.mP = this.mA = this.mB = null; return; }
    const f = parse(trace);
    [this.mP, this.mA, this.mB] = [this.mA, this.mB, f];
    this.gen.swap();
    this.gen.setFrame(1, trace, f);
    this.checked = false;
    // Hold a real frame on a scene cut or uneven motion (see motion.ts).
    this.hold = !this.mA || !this.mP || predictability(this.mA, f) < CUT || !steady(this.mP, this.mA, f);
  }

  private startNeural(): void {
    if (this.neural || this.neuralLoading || !this.gl2) return;
    this.neuralLoading = true;
    loadWeights().then((w) => {
      if (this.destroyed || !this.gl2) return;
      this.neural = new NeuralUpscaler(this.gl2, w);
      // Timer queries: every frame is a sample (a 1 s window). Without: a synchronised sample every 6th frame.
      this.governor = new Governor(this.neural.tileCapable ? 2 : 1, 8, this.timer ? 60 : 10);
      this.redraw();
    }).catch((e) => console.warn('Neural upscaler unavailable', e)).finally(() => { this.neuralLoading = false; });
  }

  /** `live`: a newly emulated frame (paused redraws and previews are not timed). */
  private draw(trace: FrameTrace | null, tau: number, live: boolean): void {
    const gl = this.gl!, f = this.filters;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const motion = this.motionOn && this.gen && this.mA && this.mB;
    if (!motion && f.upscale === 'neural' && this.neural && this.governor!.level === 0 && live && this.governor!.idle()) this.levelChanged();
    const neural = !motion && f.upscale === 'neural' && this.neural && this.governor!.level > 0;
    const path = motion ? 'motion' : neural ? 'neural' : 'lcd';
    if (path !== this.path) { this.path = path; this.fresh = true; } // the colour history was drawn at another size
    if (motion || neural) {
      if (!this.big) {
        this.big = this.target(OUT_W, OUT_H);
        this.hist4 = [this.target(OUT_W, OUT_H), this.target(OUT_W, OUT_H)];
      }
      if (motion) {
        const gen = this.gen!, t = Math.min(1, Math.max(0, tau));
        // Only pairs whose rebuild reproduces both real frames are interpolated; the others show real frames.
        if (!this.hold && !this.checked) { this.checked = true; this.hold = !gen.verify(this.mA!, this.mB!); }
        if (this.hold || t === 0) gen.renderReal(0, this.big.fbo);
        else if (t === 1) gen.renderReal(1, this.big.fbo);
        else { gen.setPair(this.mA!, this.mB!, t); gen.render(this.big.fbo); }
        this.bigValid = false;
      } else if (!this.bigValid) {
        this.neuralPass(trace, live);
      }
      this.outputPass(this.colorPass(this.big.tex, this.hist4, true), true);
      return;
    }

    // 1. colour + persistence, ping-ponging between the two history targets
    let src = this.colorPass(this.frame!, this.hist, false);

    // 2. pixel-art upscale
    if (this.up) {
      const { up } = this.progs!;
      this.use(up, this.up, 0);
      this.bind(0, src.tex, false);
      gl.uniform1i(up.u.u_tex, 0);
      gl.uniform2f(up.u.u_src, W, H);
      gl.uniform1f(up.u.u_n, this.up.w / W);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      src = this.up;
    }

    // 3. output
    this.outputPass(src, f.upscale === 'smooth');
  }

  /**
   * The neural upscaler into `big`, timed for the automatic quality fallback: GPU timer queries when the
   * browser has them, else every 6th live frame a wall-clock time of the passes between two 1-pixel reads
   * (each waits for the GPU), so only the passes' own cost counts, not the display rate.
   */
  private neuralPass(trace: FrameTrace | null, live: boolean): void {
    const gl2 = this.gl2!, gov = this.governor!, t = this.timer;
    if (t) {
      while (t.pending.length && gl2.getQueryParameter(t.pending[0], gl2.QUERY_RESULT_AVAILABLE)) {
        const q = t.pending.shift()!;
        const ns = gl2.getQueryParameter(q, gl2.QUERY_RESULT) as number;
        gl2.deleteQuery(q);
        if (!gl2.getParameter(t.ext.GPU_DISJOINT_EXT) && gov.sample(ns / 1e6)) this.levelChanged();
      }
    }
    const tile = gov.level === 2 ? trace : null;
    const q = t && live && t.pending.length < 4 ? gl2.createQuery() : null;
    const sync = !t && live && ++this.sinceSample >= 6;
    const px = new Uint8Array(4);
    if (sync) { this.sinceSample = 0; gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px); }
    const t0 = performance.now();
    if (q) gl2.beginQuery(t!.ext.TIME_ELAPSED_EXT, q);
    this.neural!.render(this.frame!, tile, this.big!.fbo);
    if (q) { gl2.endQuery(t!.ext.TIME_ELAPSED_EXT); t!.pending.push(q); }
    if (sync) {
      gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px);
      if (gov.sample(performance.now() - t0)) this.levelChanged();
    }
    this.bigValid = true;
  }

  private levelChanged(): void {
    const level = this.governor!.level;
    console.info(`Neural 4×: now ${LEVEL_NAMES[level]}`);
    neuralStatus.set(this, level);
  }

  /** Colour + persistence of `src` into the next of `hist` (ping-pong); returns it. */
  private colorPass(src: WebGLTexture, hist: Target[], big: boolean): Target {
    const gl = this.gl!, { color } = this.progs!, f = this.filters;
    const prev = hist[this.cur], next = hist[1 - this.cur];
    this.cur = 1 - this.cur;
    this.use(color, next, 0);
    this.bind(0, src, false);
    this.bind(1, prev.tex, false);
    gl.uniform1i(color.u.u_frame, 0);
    gl.uniform1i(color.u.u_hist, 1);
    gl.uniform1f(color.u.u_mode, colorMode(f, this.color));
    gl.uniform3fv(color.u['u_pal[0]'], paletteRgb(f).flat());
    gl.uniform1f(color.u.u_corr, f.correction === 'vivid' ? 0.5 : 1);
    gl.uniform1f(color.u.u_adjOn, hasAdjustments(f) ? 1 : 0);
    gl.uniform3f(color.u.u_adj, f.brightness, f.contrast, f.saturation);
    gl.uniform1f(color.u.u_ghost, this.fresh ? 0 : f.ghosting);
    gl.uniform1f(color.u.u_lerp, big ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.fresh = false;
    return next;
  }

  private outputPass(src: Target, smooth: boolean): void {
    const gl = this.gl!, { out } = this.progs!, f = this.filters;
    const cw = this.canvas.width, ch = this.canvas.height;
    this.use(out, null, 1);
    this.bind(0, src.tex, smooth);
    gl.uniform1i(out.u.u_tex, 0);
    gl.uniform2f(out.u.u_src, src.w, src.h);
    gl.uniform2f(out.u.u_out, cw, ch);
    gl.uniform1f(out.u.u_smooth, smooth ? 1 : 0);
    gl.uniform1f(out.u.u_grid, f.grid);
    gl.uniform1f(out.u.u_scan, f.scanlines);
    gl.uniform1f(out.u.u_crt, f.crt ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  clear(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.059, 0.220, 0.059, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  destroy(): void {
    const gl = this.gl;
    this.destroyed = true;
    neuralStatus.clear(this);
    if (!gl) return;
    this.neural?.destroy();
    this.gen?.destroy();
    for (const q of this.timer?.pending ?? []) this.gl2?.deleteQuery(q);
    if (this.progs) Object.values(this.progs).forEach((p) => gl.deleteProgram(p.p));
    for (const t of [...this.hist, ...this.hist4, this.up, this.big]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    if (this.frame) gl.deleteTexture(this.frame);
    if (this.quad) gl.deleteBuffer(this.quad);
    // Free the context now instead of at GC: browsers cap live WebGL contexts (~16).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.gl2 = null;
  }

  private use(prog: Program, target: Target | null, flip: number): void {
    const gl = this.gl!;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, target?.w ?? this.canvas.width, target?.h ?? this.canvas.height);
    gl.uniform1f(prog.u.u_flip, flip);
  }

  private bind(unit: number, tex: WebGLTexture, linear: boolean): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const mode = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
  }

  private link(fragment: string): Program | null {
    const gl = this.gl!;
    const vs = this.compile(gl.VERTEX_SHADER, vertexSource), fs = this.compile(gl.FRAGMENT_SHADER, fragment);
    if (!vs || !fs) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'a_position');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('Shader link error:', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    const u: Program['u'] = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  private compile(type: number, source: string): WebGLShader | null {
    const gl = this.gl!;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private texture(w: number, h: number): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl!;
    const tex = this.texture(w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }
}
