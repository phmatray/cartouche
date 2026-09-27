// Game Boy Printer output: the core hands over one job per PRINT command; jobs printed back to back
// with no feed after them (margin 0) are one strip of paper, like the real roll. Pure, no DOM.

export const PAPER_W = 160;
/** Thermal paper and its three greys, lightest to darkest (shade 0 to 3). */
export const INK: [number, number, number][] = [[0xf7, 0xf6, 0xef], [0xb4, 0xb2, 0xa8], [0x6b, 0x69, 0x62], [0x1c, 0x1c, 0x1a]];
/** Real printers feed about 8 ms per pixel row (the core keeps the game busy that long). */
export const MS_PER_ROW = 8;

export interface Job { marginBefore: number; marginAfter: number; shades: Uint8Array }
export interface Paper { shades: Uint8Array; rows: number; /** a feed after the last job: the strip is finished */ done: boolean }

/** `[margins, exposure, shades...]` from `printer_take_job` (no shades: a paper feed); null when malformed. */
export function parseJob(raw: Uint8Array): Job | null {
  const n = raw.length - 2;
  if (n < 0 || n % PAPER_W) return null;
  return { marginBefore: raw[0] >> 4, marginAfter: raw[0] & 0x0f, shades: raw.subarray(2) };
}

/**
 * The strip after `job`: appended to `paper` while it is still open, else a new strip.
 * A feed alone (no rows) finishes the open strip if it moves the paper; with no open strip it shows nothing (null).
 */
export function feed(paper: Paper | null, job: Job): Paper | null {
  const open = paper && !paper.done ? paper : null;
  if (!job.shades.length) return open && { ...open, done: job.marginBefore + job.marginAfter > 0 };
  const base = open ? open.shades : new Uint8Array(0);
  const shades = new Uint8Array(base.length + job.shades.length);
  shades.set(base);
  shades.set(job.shades, base.length);
  return { shades, rows: shades.length / PAPER_W, done: job.marginAfter > 0 };
}

/** RGBA pixels of a strip, `scale` device pixels per Game Boy pixel (nearest neighbour). */
export function paperRgba(shades: Uint8Array, scale = 1): Uint8ClampedArray<ArrayBuffer> {
  const rows = shades.length / PAPER_W, w = PAPER_W * scale;
  const out = new Uint8ClampedArray(w * rows * scale * 4);
  for (let y = 0; y < rows * scale; y++) {
    const src = ((y / scale) | 0) * PAPER_W;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = INK[shades[src + ((x / scale) | 0)] & 3];
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}
