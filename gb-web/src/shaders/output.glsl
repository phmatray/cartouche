// Final pass, to the canvas: nearest or sharp-bilinear sampling, pixel grid, scanlines, CRT curvature.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_src;    // size of u_tex
uniform vec2 u_out;    // canvas size in pixels
uniform float u_smooth, u_grid, u_scan, u_crt;

const vec2 LCD = vec2(160.0, 144.0);

void main() {
  vec2 uv = v_uv;
  float shade = 1.0;
  if (u_crt > 0.5) {
    vec2 cc = uv * 2.0 - 1.0;
    cc *= 1.0 + cc.yx * cc.yx * vec2(0.045, 0.06);
    uv = cc * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    shade = pow(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.18);
  }
  vec2 t = uv * u_src;
  if (u_smooth > 0.5) { // sharp bilinear: nearest inside each texel, a one-pixel blend at its edges
    vec2 k = max(floor(u_out / u_src), 1.0);
    vec2 d = fract(t) - 0.5;
    vec2 r = 0.5 - 0.5 / k;
    t = floor(t) + (d - clamp(d, -r, r)) * k + 0.5;
  }
  vec3 col = texture2D(u_tex, t / u_src).rgb;

  // Screen textures fade out below ~3 device pixels per Game Boy pixel, where they would only moire.
  float ppc = u_out.x / LCD.x;
  float fade = clamp((ppc - 2.0) / 2.0, 0.0, 1.0);
  vec2 cell = fract(uv * LCD);
  if (u_grid > 0.0) {
    float w = max(0.08, 1.0 / ppc);
    float g = smoothstep(0.0, w, cell.x) * smoothstep(1.0, 1.0 - w, cell.x) * smoothstep(0.0, w, cell.y) * smoothstep(1.0, 1.0 - w, cell.y);
    col *= mix(1.0 - u_grid * fade, 1.0, g);
  }
  if (u_scan > 0.0) {
    float s = sin(3.14159265 * cell.y);
    col *= 1.0 + u_scan * fade * (0.25 - 0.8 * (1.0 - s * s));
  }
  gl_FragColor = vec4(clamp(col * shade, 0.0, 1.0), 1.0);
}
