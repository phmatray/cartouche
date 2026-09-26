// Pass 2 (optional): Scale2x / Scale3x (EPX family) to N times the source size.
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_src;
uniform float u_n;

vec3 T(vec2 p) { return texture2D(u_tex, (p + 0.5) / u_src).rgb; }
bool eq(vec3 a, vec3 b) { return dot(abs(a - b), vec3(1.0)) < 0.02; }

void main() {
  vec2 op = floor(v_uv * u_src * u_n);
  vec2 p = floor((op + 0.5) / u_n);
  vec2 s = op - p * u_n; // sub-pixel, (0,0) top left
  vec3 A = T(p + vec2(-1., -1.)), B = T(p + vec2(0., -1.)), C = T(p + vec2(1., -1.));
  vec3 D = T(p + vec2(-1., 0.)),  E = T(p),                  F = T(p + vec2(1., 0.));
  vec3 G = T(p + vec2(-1., 1.)),  H = T(p + vec2(0., 1.)),  I = T(p + vec2(1., 1.));
  bool db = eq(D, B), bf = eq(B, F), dh = eq(D, H), hf = eq(H, F);
  // Corner rules: top left, top right, bottom left, bottom right.
  bool c0 = db && !bf && !dh, c1 = bf && !db && !hf, c2 = dh && !db && !hf, c3 = hf && !dh && !bf;
  vec3 o;
  if (u_n < 2.5) {
    if (s.y < 0.5) o = s.x < 0.5 ? (c0 ? D : E) : (c1 ? F : E);
    else           o = s.x < 0.5 ? (c2 ? D : E) : (c3 ? F : E);
  } else if (s.y < 0.5) {
    o = s.x < 0.5 ? (c0 ? D : E) : s.x < 1.5 ? ((c0 && !eq(E, C)) || (c1 && !eq(E, A)) ? B : E) : (c1 ? F : E);
  } else if (s.y < 1.5) {
    o = s.x < 0.5 ? ((c0 && !eq(E, G)) || (c2 && !eq(E, A)) ? D : E) : s.x < 1.5 ? E : ((c1 && !eq(E, I)) || (c3 && !eq(E, C)) ? F : E);
  } else {
    o = s.x < 0.5 ? (c2 ? D : E) : s.x < 1.5 ? ((c2 && !eq(E, I)) || (c3 && !eq(E, G)) ? H : E) : (c3 ? F : E);
  }
  gl_FragColor = vec4(o, 1.0);
}
