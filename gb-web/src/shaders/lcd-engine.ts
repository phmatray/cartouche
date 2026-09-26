import vertexSource from './vertex.glsl?raw';
import colorSource from './color.glsl?raw';
import upscaleSource from './upscale.glsl?raw';
import outputSource from './output.glsl?raw';
import { colorMode, hasAdjustments, paletteRgb, PRESETS, type Filters } from './filters';

const W = 160, H = 144;

interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/**
 * The display pipeline, all within the frame it is given (no added latency):
 *   1. colour (160x144): DMG palette or GBC correction, adjustments, LCD persistence (feeds back on itself)
 *   2. upscale (optional): Scale2x / Scale3x
 *   3. output (canvas size): nearest or sharp bilinear, pixel grid, scanlines, CRT curvature and vignette.
 */
export class LcdEngine {
  private gl: WebGLRenderingContext | null = null;
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  init(width: number, height: number): boolean {
    this.canvas.width = width;
    this.canvas.height = height;
    const opts = { antialias: false, alpha: false, depth: false, stencil: false };
    const gl = (this.canvas.getContext('webgl2', opts) ?? this.canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
    if (!gl) return false;
    this.gl = gl;
    const color = this.link(colorSource), up = this.link(upscaleSource), out = this.link(outputSource);
    if (!color || !up || !out) return false;
    this.progs = { color, up, out };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.frame = this.texture(W, H);
    this.hist = [this.target(W, H), this.target(W, H)];
    return true;
  }

  setFilters(filters: Filters, color: boolean): void {
    if (filters === this.filters && color === this.color) return;
    this.filters = filters;
    this.color = color;
    const n = filters.upscale === 'scale2x' ? 2 : filters.upscale === 'scale3x' ? 3 : 0;
    const gl = this.gl;
    if (gl && (this.up?.w ?? 0) !== n * W) {
      if (this.up) { gl.deleteTexture(this.up.tex); gl.deleteFramebuffer(this.up.fbo); }
      this.up = n ? this.target(n * W, n * H) : null;
    }
    this.fresh = true;
    this.redraw();
  }

  /** Canvas backing size in device pixels (kept by the caller at the size it is shown). */
  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.redraw();
  }

  renderFrame(framebuffer: Uint8ClampedArray): void {
    const gl = this.gl;
    if (!gl || !this.progs) return;
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, framebuffer);
    this.hasFrame = true;
    this.draw();
  }

  /** Draw the last frame again (filters or size changed while paused). */
  private redraw(): void {
    if (this.hasFrame) this.draw();
  }

  private draw(): void {
    const gl = this.gl!, { color, up, out } = this.progs!, f = this.filters;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 1. colour + persistence, ping-ponging between the two history targets
    const prev = this.hist[this.cur], next = this.hist[1 - this.cur];
    this.cur = 1 - this.cur;
    this.use(color, next, 0);
    this.bind(0, this.frame!, false);
    this.bind(1, prev.tex, false);
    gl.uniform1i(color.u.u_frame, 0);
    gl.uniform1i(color.u.u_hist, 1);
    gl.uniform1f(color.u.u_mode, colorMode(f, this.color));
    gl.uniform3fv(color.u['u_pal[0]'], paletteRgb(f).flat());
    gl.uniform1f(color.u.u_corr, f.correction === 'vivid' ? 0.5 : 1);
    gl.uniform1f(color.u.u_adjOn, hasAdjustments(f) ? 1 : 0);
    gl.uniform3f(color.u.u_adj, f.brightness, f.contrast, f.saturation);
    gl.uniform1f(color.u.u_ghost, this.fresh ? 0 : f.ghosting);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.fresh = false;
    let src: Target = next;

    // 2. pixel-art upscale
    if (this.up) {
      this.use(up, this.up, 0);
      this.bind(0, src.tex, false);
      gl.uniform1i(up.u.u_tex, 0);
      gl.uniform2f(up.u.u_src, W, H);
      gl.uniform1f(up.u.u_n, this.up.w / W);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      src = this.up;
    }

    // 3. output
    const cw = this.canvas.width, ch = this.canvas.height;
    this.use(out, null, 1);
    this.bind(0, src.tex, f.upscale === 'smooth');
    gl.uniform1i(out.u.u_tex, 0);
    gl.uniform2f(out.u.u_src, src.w, src.h);
    gl.uniform2f(out.u.u_out, cw, ch);
    gl.uniform1f(out.u.u_smooth, f.upscale === 'smooth' ? 1 : 0);
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
    if (!gl) return;
    if (this.progs) Object.values(this.progs).forEach((p) => gl.deleteProgram(p.p));
    for (const t of [...this.hist, this.up]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    if (this.frame) gl.deleteTexture(this.frame);
    if (this.quad) gl.deleteBuffer(this.quad);
    // Free the context now instead of at GC: browsers cap live WebGL contexts (~16).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
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
