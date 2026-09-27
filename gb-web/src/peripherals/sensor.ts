// The pocket camera's sensor view: 128 × 112 luminance bytes from a video frame or a photo.

export const SENSOR_W = 128;
export const SENSOR_H = 112;

let work: CanvasRenderingContext2D | null = null;

/** Centre-crop `src` (w × h) to the sensor's 8:7, optionally mirrored, as luminance (0 = black). */
export function grab(src: CanvasImageSource, w: number, h: number, mirror: boolean): Uint8Array | null {
  if (!w || !h) return null;
  if (!work) {
    const c = document.createElement('canvas');
    c.width = SENSOR_W; c.height = SENSOR_H;
    work = c.getContext('2d', { willReadFrequently: true });
    if (!work) return null;
  }
  const scale = Math.max(SENSOR_W / w, SENSOR_H / h);
  const cw = SENSOR_W / scale, ch = SENSOR_H / scale;
  work.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? SENSOR_W : 0, 0);
  work.drawImage(src, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, SENSOR_W, SENSOR_H);
  const rgba = work.getImageData(0, 0, SENSOR_W, SENSOR_H).data;
  const out = new Uint8Array(SENSOR_W * SENSOR_H);
  for (let i = 0; i < out.length; i++) out[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return out;
}

/** Draw a sensor frame (grey) into a 128 × 112 canvas. */
export function show(canvas: HTMLCanvasElement | null, lum: Uint8Array) {
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(SENSOR_W, SENSOR_H);
  const d = img.data;
  for (let i = 0, o = 0; i < lum.length; i++, o += 4) { d[o] = d[o + 1] = d[o + 2] = lum[i]; d[o + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}
