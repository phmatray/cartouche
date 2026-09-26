attribute vec2 a_position;
uniform float u_flip; // 1 when drawing to the canvas: frame row 0 at the top
varying vec2 v_uv;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = vec2(a_position.x * 0.5 + 0.5, u_flip > 0.5 ? 0.5 - a_position.y * 0.5 : a_position.y * 0.5 + 0.5);
}
