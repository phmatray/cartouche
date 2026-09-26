precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform sampler2D u_prevTexture;
uniform vec2 u_resolution;
uniform vec2 u_texSize;
uniform float u_grid; // 1.0 draws the dot-matrix grid, 0.0 hides it

// Light: warm backlit green-white
const vec3 COLOR_DARKEST  = vec3(0.0, 0.15, 0.05);
const vec3 COLOR_DARK     = vec3(0.20, 0.45, 0.20);
const vec3 COLOR_LIGHT    = vec3(0.55, 0.78, 0.45);
const vec3 COLOR_LIGHTEST = vec3(0.80, 0.92, 0.70);

const float GHOST_FACTOR = 0.15;
const float GRID_STRENGTH = 0.50;

vec3 applyPalette(float luma) {
  if (luma < 0.25) return COLOR_DARKEST;
  else if (luma < 0.50) return COLOR_DARK;
  else if (luma < 0.75) return COLOR_LIGHT;
  else return COLOR_LIGHTEST;
}

void main() {
  vec4 current = texture2D(u_texture, v_texCoord);
  vec4 previous = texture2D(u_prevTexture, v_texCoord);
  vec4 blended = mix(current, previous, GHOST_FACTOR);

  float luma = dot(blended.rgb, vec3(0.299, 0.587, 0.114));
  vec3 color = applyPalette(luma);

  vec2 pixelCoord = v_texCoord * u_texSize;
  vec2 cellPos = fract(pixelCoord);
  float gridX = smoothstep(0.0, 0.08, cellPos.x) * smoothstep(1.0, 0.92, cellPos.x);
  float gridY = smoothstep(0.0, 0.08, cellPos.y) * smoothstep(1.0, 0.92, cellPos.y);
  float grid = gridX * gridY;
  color *= mix(1.0 - GRID_STRENGTH * u_grid, 1.0, grid);

  vec2 uv = v_texCoord * 2.0 - 1.0;
  float dist = length(uv * 0.6);
  float glow = 1.0 + 0.12 * (1.0 - dist * dist);
  color *= glow;

  color += vec3(0.02, 0.03, 0.01);

  gl_FragColor = vec4(color, 1.0);
}
