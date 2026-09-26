import vertexSource from './vertex.glsl?raw';

export type PresetName = 'dmg-classic' | 'gb-pocket' | 'gb-light' | 'clean';

export class LcdEngine {
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexShader: WebGLShader | null = null;
  private texCurrent: WebGLTexture | null = null;
  private texPrevious: WebGLTexture | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private uvBuffer: WebGLBuffer | null = null;
  private startTime = 0;
  private currentPresetSource: string = '';
  /** Dot-matrix grid strength multiplier (u_grid), 1 = as designed, 0 = off. */
  grid = 1;

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  init(width: number, height: number): boolean {
    // Set canvas size BEFORE acquiring context — setting width/height
    // after getContext() resets the WebGL state (destroys shaders/textures).
    this.canvas.width = width;
    this.canvas.height = height;

    const gl =
      this.canvas.getContext('webgl2', { antialias: false, alpha: false }) ??
      this.canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return false;
    this.gl = gl as WebGLRenderingContext;

    this.vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    if (!this.vertexShader) return false;

    this.texCurrent = this.createTexture();
    this.texPrevious = this.createTexture();

    this.posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);

    this.uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1,  1, 1,  0, 0,
      0, 0,  1, 1,  1, 0,
    ]), gl.STATIC_DRAW);

    this.startTime = performance.now();
    return true;
  }

  setPreset(fragmentSource: string): boolean {
    const gl = this.gl;
    if (!gl || !this.vertexShader) return false;

    if (fragmentSource === this.currentPresetSource && this.program) return true;

    if (this.program) {
      gl.deleteProgram(this.program);
    }

    const fragShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!fragShader) return false;

    const program = gl.createProgram()!;
    gl.attachShader(program, this.vertexShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    gl.deleteShader(fragShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Shader link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }

    this.program = program;
    this.currentPresetSource = fragmentSource;
    return true;
  }

  renderFrame(framebuffer: Uint8ClampedArray): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const tmp = this.texPrevious;
    this.texPrevious = this.texCurrent;
    this.texCurrent = tmp;

    gl.bindTexture(gl.TEXTURE_2D, this.texCurrent);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 160, 144, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, framebuffer
    );

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    const aPos = gl.getAttribLocation(this.program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const aUv = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texCurrent);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_texture'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texPrevious);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_prevTexture'), 1);

    const uRes = gl.getUniformLocation(this.program, 'u_resolution');
    if (uRes) gl.uniform2f(uRes, this.canvas.width, this.canvas.height);

    const uTex = gl.getUniformLocation(this.program, 'u_texSize');
    if (uTex) gl.uniform2f(uTex, 160.0, 144.0);

    const uGrid = gl.getUniformLocation(this.program, 'u_grid');
    if (uGrid) gl.uniform1f(uGrid, this.grid);

    const uTime = gl.getUniformLocation(this.program, 'u_time');
    if (uTime) gl.uniform1f(uTime, (performance.now() - this.startTime) / 1000.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  clear(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.clearColor(0.059, 0.220, 0.059, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  destroy(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.texCurrent) gl.deleteTexture(this.texCurrent);
    if (this.texPrevious) gl.deleteTexture(this.texPrevious);
    if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
    if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
    // Free the context now instead of at GC: browsers cap live WebGL contexts (~16).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
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

  private createTexture(): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 160, 144, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    return tex;
  }
}
