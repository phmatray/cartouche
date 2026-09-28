import { crc32 } from './zip.ts';

/**
 * IPS, BPS and UPS patches (translations, fixes, ROM hacks) applied to a ROM the player already has.
 * Pure bytes in, bytes out: no DOM, no storage. BPS and UPS carry the CRC32s of their source, target
 * and of the patch itself, all checked; IPS has none, so its result is unverified.
 */
export type PatchKind = 'ips' | 'bps' | 'ups';

/** Why a patch was refused: unreadable (`format`), a different base (`source`), a wrong result (`target`), a damaged file (`patch`), too big (`size`). */
export class PatchError extends Error {
  reason: 'format' | 'source' | 'target' | 'patch' | 'size';
  constructor(reason: PatchError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

/** The largest ROM Cartouche stores (useGameLibrary's MAX_ROM_SIZE: 8 MB). */
const MAX = 0x8000 << 8;

export function patchKind(name: string): PatchKind | null {
  const m = /\.(ips|bps|ups)$/i.exec(name);
  return m ? (m[1].toLowerCase() as PatchKind) : null;
}

const magic = (p: Uint8Array, m: string) => p.length >= m.length && [...m].every((c, i) => p[i] === c.charCodeAt(0));
const u32 = (p: Uint8Array, o: number) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;

/** A cursor over the patch that throws `format` on any read past `end`. */
function reader(p: Uint8Array, at: number, end: number) {
  const r = {
    at, end,
    byte() { if (r.at >= end) throw new PatchError('format'); return p[r.at++]; },
    /** The variable-length number BPS and UPS share. */
    vlq() {
      let n = 0, shift = 1;
      for (;;) {
        const x = r.byte();
        n += (x & 0x7f) * shift;
        if (x & 0x80) return n;
        shift *= 128;
        n += shift;
        if (n > Number.MAX_SAFE_INTEGER / 256) throw new PatchError('format');
      }
    },
  };
  return r;
}

/** The base a BPS or UPS patch was made from (its size and CRC32); null for IPS or an unreadable file. */
export function patchSource(patch: Uint8Array): { size: number; crc32: number } | null {
  if (!(magic(patch, 'BPS1') || magic(patch, 'UPS1')) || patch.length < 16) return null;
  try {
    return { size: reader(patch, 4, patch.length - 12).vlq(), crc32: u32(patch, patch.length - 12) };
  } catch {
    return null;
  }
}

export function applyPatch(base: Uint8Array, patch: Uint8Array): { data: Uint8Array; verified: boolean } {
  if (magic(patch, 'PATCH')) return { data: ips(base, patch), verified: false };
  const bps = magic(patch, 'BPS1');
  if (!bps && !magic(patch, 'UPS1')) throw new PatchError('format');
  if (patch.length < 16) throw new PatchError('format');
  const end = patch.length - 12;
  if (crc32(patch.subarray(0, patch.length - 4)) !== u32(patch, patch.length - 4)) throw new PatchError('patch');
  const r = reader(patch, 4, end);
  const srcSize = r.vlq(), outSize = r.vlq();
  if (base.length !== srcSize || crc32(base) !== u32(patch, end)) throw new PatchError('source');
  if (outSize > MAX) throw new PatchError('size');
  const out = bps ? bpsBody(base, r, outSize, patch) : upsBody(base, r, outSize);
  if (crc32(out) !== u32(patch, end + 4)) throw new PatchError('target');
  return { data: out, verified: true };
}

function ips(base: Uint8Array, p: Uint8Array): Uint8Array {
  const r = reader(p, 5, p.length);
  let out = base.slice();
  const room = (n: number) => {
    if (n > MAX) throw new PatchError('size');
    if (n > out.length) { const g = new Uint8Array(n); g.set(out); out = g; }
  };
  for (;;) {
    const at = (r.byte() << 16) | (r.byte() << 8) | r.byte();
    if (at === 0x454f46) break; // "EOF"
    const size = (r.byte() << 8) | r.byte();
    if (size) {
      room(at + size);
      for (let i = 0; i < size; i++) out[at + i] = r.byte();
    } else {
      const count = (r.byte() << 8) | r.byte(), v = r.byte();
      room(at + count);
      out.fill(v, at, at + count);
    }
  }
  // An optional truncation length after EOF.
  if (p.length - r.at >= 3) {
    const len = (p[r.at] << 16) | (p[r.at + 1] << 8) | p[r.at + 2];
    room(len);
    out = out.slice(0, len);
  }
  return out;
}

function bpsBody(src: Uint8Array, r: ReturnType<typeof reader>, size: number, p: Uint8Array): Uint8Array {
  const meta = r.vlq();
  r.at += meta; // metadata: skipped
  const out = new Uint8Array(size);
  let o = 0, srcRel = 0, outRel = 0;
  const signed = (d: number) => (d & 1 ? -1 : 1) * Math.floor(d / 2);
  while (r.at < p.length - 12) {
    const a = r.vlq(), len = Math.floor(a / 4) + 1;
    if (o + len > size) throw new PatchError('format');
    switch (a & 3) {
      case 0: // SourceRead
        if (o + len > src.length) throw new PatchError('format');
        out.set(src.subarray(o, o + len), o);
        o += len;
        break;
      case 1: // TargetRead
        for (let i = 0; i < len; i++) out[o++] = r.byte();
        break;
      case 2: // SourceCopy
        srcRel += signed(r.vlq());
        if (srcRel < 0 || srcRel + len > src.length) throw new PatchError('format');
        out.set(src.subarray(srcRel, srcRel + len), o);
        o += len; srcRel += len;
        break;
      default: // TargetCopy: byte by byte, the copy may overlap what it writes
        outRel += signed(r.vlq());
        if (outRel < 0 || outRel >= o) throw new PatchError('format');
        for (let i = 0; i < len; i++) out[o++] = out[outRel++];
    }
  }
  if (o !== size) throw new PatchError('format');
  return out;
}

function upsBody(src: Uint8Array, r: ReturnType<typeof reader>, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(src.subarray(0, size));
  let o = 0;
  while (r.at < r.end) {
    o += r.vlq();
    for (;;) {
      const x = r.byte();
      if (o < size) out[o] = (src[o] ?? 0) ^ x;
      else if (x) throw new PatchError('format');
      o++;
      if (!x) break;
    }
  }
  return out;
}
