precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform sampler2D u_prevTexture;
uniform vec2 u_resolution;
uniform vec2 u_texSize;
uniform float u_grid; // 1.0 draws the dot-matrix grid, 0.0 hides it

// DMG original green palette
const vec3 COLOR_DARKEST  = vec3(0.059, 0.220, 0.059);  // #0f380f
const vec3 COLOR_DARK     = vec3(0.188, 0.384, 0.188);  // #306230
const vec3 COLOR_LIGHT    = vec3(0.545, 0.675, 0.059);  // #8bac0f
const vec3 COLOR_LIGHTEST = vec3(0.608, 0.737, 0.059);  // #9bbc0f

const float GHOST_FACTOR = 0.40;
const float GRID_STRENGTH = 0.70;

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

  float gridX = smoothstep(0.0, 0.1, cellPos.x) * smoothstep(1.0, 0.9, cellPos.x);
  float gridY = smoothstep(0.0, 0.1, cellPos.y) * smoothstep(1.0, 0.9, cellPos.y);
  float grid = gridX * gridY;
  color *= mix(1.0 - GRID_STRENGTH * u_grid, 1.0, grid);

  vec2 uv = v_texCoord * 2.0 - 1.0;
  float vignette = 1.0 - dot(uv * 0.3, uv * 0.3);
  color *= vignette;

  gl_FragColor = vec4(color, 1.0);
}
