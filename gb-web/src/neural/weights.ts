/**
 * The two shipped weight files (numbers only, see docs/NEURAL.md) and their GPU layouts.
 *
 * tile4x.bin, "CTAW": u8 version, C (channels), L (conv layers), 0, then fp16 weights and biases of
 *   conv3x3 5->C, (L-1) x conv3x3 C->C (residual), conv1x1 C->64 (16 subpixels x 4 colour-id logits).
 * lc4x.bin, "GBLC": u8 version, NB (key bits), NP (pixel pairs), 0, NP x (p, q) indices into a 5x5
 *   window, then 2^NB entries of 3 bytes (one per free subpixel: source << 5 | alpha).
 */

export interface TileNet {
  C: number;
  L: number;
  /** Per layer: weights (Cout, Cin, k, k) flattened, biases. */
  layers: { w: Float32Array; b: Float32Array; cin: number; cout: number; k: number }[];
}

export interface LcTable { pairs: [number, number][]; table: Uint8Array; nb: number }

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

const magic = (b: Uint8Array, m: string) => String.fromCharCode(b[0], b[1], b[2], b[3]) === m;

export function parseTileNet(buf: ArrayBuffer): TileNet {
  const b = new Uint8Array(buf);
  if (!magic(b, 'CTAW') || b[4] !== 1) throw new Error('tile4x: bad header');
  const C = b[5], L = b[6];
  const dv = new DataView(buf);
  let o = 8;
  const read = (n: number) => { const a = new Float32Array(n); for (let i = 0; i < n; i++, o += 2) a[i] = halfToFloat(dv.getUint16(o, true)); return a; };
  const shapes: [number, number, number][] = [[C, 5, 3], ...Array.from({ length: L - 1 }, (): [number, number, number] => [C, C, 3]), [64, C, 1]];
  const layers = shapes.map(([cout, cin, k]) => ({ w: read(cout * cin * k * k), b: read(cout), cin, cout, k }));
  if (o !== b.length) throw new Error('tile4x: bad length');
  return { C, L, layers };
}

export function parseLc(buf: ArrayBuffer): LcTable {
  const b = new Uint8Array(buf);
  if (!magic(b, 'GBLC') || b[4] !== 1) throw new Error('lc4x: bad header');
  const nb = b[5], np = b[6];
  const pairs = Array.from({ length: np }, (_, i): [number, number] => [b[8 + 2 * i], b[9 + 2 * i]]);
  const o = 8 + 2 * np, n = (1 << nb) * 3;
  if (b.length !== o + n) throw new Error('lc4x: bad length');
  return { pairs, table: b.slice(o, o + n), nb };
}

/** The LC table as a 256-wide RGBA8UI texture image (entry k at x = k & 255, y = k >> 8). */
export function lcTexture(t: LcTable): { data: Uint8Array; h: number } {
  const n = 1 << t.nb, h = Math.max(1, n >> 8);
  const data = new Uint8Array(256 * h * 4);
  for (let k = 0; k < n; k++) data.set(t.table.subarray(3 * k, 3 * k + 3), 4 * k);
  return { data, h };
}

/**
 * std140 uniform blocks of the tile network, one per (layer, output group of 4 channels), all in one buffer at
 * `align`-ed offsets (UNIFORM_BUFFER_OFFSET_ALIGNMENT):
 *   input layer  { vec4 w[36]; vec4 b; }       w[tap * 4 + id] = W[4o + i][id][tap], one-hot input needs no MACs
 *   body layers  { mat4 w[9 * G]; vec4 b; }    w[tap * G + g] column j, row i = W[4o + i][4g + j][tap]
 *   head         { mat4 w[16 * G]; vec4 b[16]; } w[s * G + g] column j, row i = W[4s + i][4g + j]
 * (G = C / 4, tap = ky * 3 + kx; the input's fifth channel, "OBJ layer", is 0 for maps and dropped.)
 */
export function packTileNet(net: TileNet, align: number): { data: Float32Array; blocks: { offset: number; size: number }[][] } {
  const G = net.C / 4, round = (n: number) => Math.ceil(n / align) * align;
  const sizes = [37 * 16, (9 * G * 4 + 1) * 16, (16 * G * 4 + 16) * 16];
  const blocks: { offset: number; size: number }[][] = [];
  let at = 0;
  const layout = net.layers.map((_, l) => (l === 0 ? 0 : l === net.layers.length - 1 ? 2 : 1));
  for (let l = 0; l < net.layers.length; l++) {
    const groups = layout[l] === 2 ? 1 : G;
    blocks.push(Array.from({ length: groups }, () => { const r = { offset: at, size: sizes[layout[l]] }; at += round(sizes[layout[l]]); return r; }));
  }
  const data = new Float32Array(at / 4);
  net.layers.forEach((ly, l) => {
    const { w, b, cin, k } = ly, kk = k * k;
    const W = (co: number, ci: number, t: number) => w[(co * cin + ci) * kk + t];
    blocks[l].forEach(({ offset }, o) => {
      const f = offset / 4;
      if (layout[l] === 0) {
        for (let t = 0; t < 9; t++) for (let id = 0; id < 4; id++) for (let i = 0; i < 4; i++) data[f + (t * 4 + id) * 4 + i] = W(4 * o + i, id, t);
        for (let i = 0; i < 4; i++) data[f + 36 * 4 + i] = b[4 * o + i];
      } else if (layout[l] === 1) {
        for (let t = 0; t < 9; t++) for (let g = 0; g < G; g++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++)
          data[f + (t * G + g) * 16 + j * 4 + i] = W(4 * o + i, 4 * g + j, t);
        for (let i = 0; i < 4; i++) data[f + 9 * G * 16 + i] = b[4 * o + i];
      } else {
        for (let s = 0; s < 16; s++) for (let g = 0; g < G; g++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++)
          data[f + (s * G + g) * 16 + j * 4 + i] = W(4 * s + i, 4 * g + j, 0);
        for (let s = 0; s < 64; s++) data[f + 16 * G * 16 + s] = b[s];
      }
    });
  });
  return { data, blocks };
}
