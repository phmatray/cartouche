// Pass 1, at 160x144: DMG palette or GBC colour correction, adjustments, then LCD persistence.
// Keep in step with cpuColor() in filters.ts (the Canvas2D fallback).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_hist;   // this pass's previous output
uniform float u_mode;       // 0 raw, 1 DMG palette, 2 colour correction
uniform vec3 u_pal[4];      // lightest to darkest
uniform float u_corr;       // correction strength: 1 accurate, 0.5 vivid
uniform float u_adjOn;
uniform vec3 u_adj;         // brightness, contrast, saturation (0 = neutral)
uniform float u_ghost;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
// GBC LCD response: gamma 2.2, channel mixing, 0.94 luminance (the widely used gbc-color model).
const mat3 GBC = mat3(0.78824, 0.025, 0.12039,  0.12157, 0.72941, 0.12157,  0.0, 0.275, 0.66667);

void main() {
  vec3 c = texture2D(u_frame, v_uv).rgb;
  if (u_mode > 1.5) {
    vec3 lcd = pow(clamp(GBC * pow(c, vec3(2.2)) * 0.94, 0.0, 1.0), vec3(1.0 / 2.2));
    c = mix(c, lcd, u_corr);
  } else if (u_mode > 0.5) {
    // The core draws the four DMG shades in fixed colours; the midpoints of their luma pick the shade.
    float l = dot(c, LUMA);
    c = l > 0.79 ? u_pal[0] : l > 0.49 ? u_pal[1] : l > 0.21 ? u_pal[2] : u_pal[3];
  }
  if (u_adjOn > 0.5) {
    c = (c + u_adj.x - 0.5) * (1.0 + u_adj.y) + 0.5;
    c = clamp(mix(vec3(dot(c, LUMA)), c, 1.0 + u_adj.z), 0.0, 1.0);
  }
  gl_FragColor = vec4(mix(c, texture2D(u_hist, v_uv).rgb, u_ghost), 1.0);
}
