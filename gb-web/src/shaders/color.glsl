// Pass 1, at 160x144 (at 640x576 after Neural 4x or Smooth motion): DMG palette or GBC/GBA LCD colour correction, adjustments, then
// ghosting: a mix with u_hist, the previous output (LCD response) or the previous unghosted frame (frame blending, see LcdEngine).
// Keep in step with cpuColor() in filters.ts (the Canvas2D fallback).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_hist;   // the previous frame to mix in
uniform float u_mode;       // 0 raw, 1 DMG palette, 2 colour correction
uniform vec3 u_pal[4];      // lightest to darkest
uniform sampler2D u_curve;  // 32x1: each channel's LCD curve by 5-bit value (curveLut in lcd-curves.ts)
uniform float u_green;      // parts green to one part blue in the displayed green: 3 GBC, 5 GBA
uniform float u_adjOn;
uniform vec3 u_adj;         // brightness, contrast, saturation (0 = neutral)
uniform float u_ghost;
uniform float u_lerp;       // 1 after an upscaler that blends shades (Neural 4x): palette by interpolation, not threshold

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
// Luma of the core's four DMG shades, lightest first.
const vec4 SHADE_L = vec4(0.926525, 0.651514, 0.338824, 0.078933);
// SameBoy's balanced LCD modes mix green and blue at gamma 1.6 (correctRgb555 in lcd-curves.ts).
const float MIX_GAMMA = 1.6;

void main() {
  vec3 c = texture2D(u_frame, v_uv).rgb;
  if (u_mode > 1.5) {
    // The core draws 5-bit colour as c5 * 255 / 31: back to c5 (between two after Neural 4x, which the LUT interpolates).
    vec3 x = c * 31.0;
    if (u_lerp < 0.5) x = floor(x + 0.5);
    x = (x + 0.5) / 32.0;
    c = vec3(texture2D(u_curve, vec2(x.r, 0.5)).r, texture2D(u_curve, vec2(x.g, 0.5)).g, texture2D(u_curve, vec2(x.b, 0.5)).b);
    vec2 gb = pow(c.gb, vec2(MIX_GAMMA));
    c.g = pow((gb.x * u_green + gb.y) / (u_green + 1.0), 1.0 / MIX_GAMMA);
  } else if (u_mode > 0.5) {
    // The core draws the four DMG shades in fixed colours; the midpoints of their luma pick the shade.
    float l = dot(c, LUMA);
    if (u_lerp > 0.5) { // a blend of two shades becomes the same blend of their palette colours
      c = l > SHADE_L.y ? mix(u_pal[1], u_pal[0], clamp((l - SHADE_L.y) / (SHADE_L.x - SHADE_L.y), 0.0, 1.0))
        : l > SHADE_L.z ? mix(u_pal[2], u_pal[1], (l - SHADE_L.z) / (SHADE_L.y - SHADE_L.z))
        : mix(u_pal[3], u_pal[2], clamp((l - SHADE_L.w) / (SHADE_L.z - SHADE_L.w), 0.0, 1.0));
    } else {
      c = l > 0.79 ? u_pal[0] : l > 0.49 ? u_pal[1] : l > 0.21 ? u_pal[2] : u_pal[3];
    }
  }
  if (u_adjOn > 0.5) {
    c = (c + u_adj.x - 0.5) * (1.0 + u_adj.y) + 0.5;
    c = clamp(mix(vec3(dot(c, LUMA)), c, 1.0 + u_adj.z), 0.0, 1.0);
  }
  gl_FragColor = vec4(mix(c, texture2D(u_hist, v_uv).rgb, u_ghost), 1.0);
}
