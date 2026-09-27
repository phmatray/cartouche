import { t as tr } from '../i18n/core.ts';

/**
 * A .zip read from its central directory, one entry at a time through Blob.slice: a 1.5 GB archive
 * is never held in memory. Stored (0) and deflate (8) entries, ZIP64, folders, UTF-8 names.
 */
export interface ZipEntry { name: string; size: number; csize: number; method: number; crc: number; offset: number }

export class ZipError extends Error {}

const view = async (b: Blob, start: number, end: number) => new DataView(await b.slice(start, end).arrayBuffer());
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

/** Every entry of the archive, folders included (their names end with /). Throws ZipError when it isn't a readable zip. */
export async function listZip(file: Blob): Promise<ZipEntry[]> {
  // End of central directory: 22 bytes plus a comment of up to 64 KB, preceded by the 20-byte ZIP64 locator.
  const tailStart = Math.max(0, file.size - (22 + 0xffff + 20));
  const t = await view(file, tailStart, file.size);
  let e = t.byteLength - 22;
  while (e >= 0 && t.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new ZipError(tr('add.zip.not'));
  let count = t.getUint16(e + 10, true), cdSize = t.getUint32(e + 12, true), cdOff = t.getUint32(e + 16, true);
  if (e >= 20 && t.getUint32(e - 20, true) === 0x07064b50) {
    const at = u64(t, e - 20 + 8);
    const r = await view(file, at, at + 56);
    if (r.byteLength < 56 || r.getUint32(0, true) !== 0x06064b50) throw new ZipError(tr('add.zip.damaged'));
    count = u64(r, 32); cdSize = u64(r, 40); cdOff = u64(r, 48);
  }
  if (cdOff + cdSize > file.size) throw new ZipError(tr('add.zip.incomplete'));
  const cd = await view(file, cdOff, cdOff + cdSize);
  const utf8 = new TextDecoder(); // ponytail: names are read as UTF-8 even without the flag (old CP437 names come out garbled, still importable)
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new ZipError(tr('add.zip.damaged'));
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const x0 = p + 46 + nlen;
    if (x0 + xlen + clen > cd.byteLength) throw new ZipError(tr('add.zip.damaged'));
    const en: ZipEntry = {
      name: utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen)),
      method: cd.getUint16(p + 10, true), crc: cd.getUint32(p + 16, true),
      csize: cd.getUint32(p + 20, true), size: cd.getUint32(p + 24, true), offset: cd.getUint32(p + 42, true),
    };
    // ZIP64 extra field: the 64-bit values of the fields set to 0xFFFFFFFF, in this order.
    for (let x = x0; x + 4 <= x0 + xlen; x += 4 + cd.getUint16(x + 2, true)) {
      if (cd.getUint16(x, true) !== 1) continue;
      let q = x + 4;
      for (const k of ['size', 'csize', 'offset'] as const) if (en[k] === 0xffffffff) { en[k] = u64(cd, q); q += 8; }
    }
    out.push(en);
    p = x0 + xlen + clen;
  }
  return out;
}

let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  table ??= Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  let c = ~0;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** One entry's bytes, checked against its size and CRC-32. Throws ZipError when damaged or compressed some other way. */
export async function readEntry(file: Blob, e: ZipEntry): Promise<Uint8Array> {
  const h = await view(file, e.offset, e.offset + 30);
  if (h.byteLength < 30 || h.getUint32(0, true) !== 0x04034b50) throw new ZipError(tr('add.zip.damaged'));
  const start = e.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const raw = file.slice(start, start + e.csize);
  if (raw.size !== e.csize) throw new ZipError(tr('add.zip.incomplete'));
  let data: Uint8Array;
  if (e.method === 0) data = new Uint8Array(await raw.arrayBuffer());
  else if (e.method === 8) {
    // Streamed and capped at the declared size: a lying entry can't inflate without bound.
    data = new Uint8Array(e.size);
    let n = 0;
    const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        if (n + r.value.length > e.size) { reader.cancel().catch(() => {}); throw new ZipError(tr('add.zip.damaged')); }
        data.set(r.value, n);
        n += r.value.length;
      }
    } catch (err) {
      throw err instanceof ZipError ? err : new ZipError(tr('add.zip.damaged'));
    }
    if (n !== e.size) throw new ZipError(tr('add.zip.damaged'));
  } else throw new ZipError(tr('add.zip.method', { method: String(e.method) }));
  if (data.length !== e.size || crc32(data) !== e.crc) throw new ZipError(tr('add.zip.damaged'));
  return data;
}
