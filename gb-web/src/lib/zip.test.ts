// node --test: archives are built here from the bundled homebrew/test ROMs (gb-web/public/roms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { crc32, listZip, readEntry, ZipError } from './zip.ts';

const rom = (f: string) => new Uint8Array(readFileSync(new URL(`../../public/roms/${f}`, import.meta.url)));
const TOBU = rom('tobutobugirl.gb');
const ACID = rom('cgb-acid2.gbc');

interface In { name: string; data: Uint8Array; deflate?: boolean }
/** A minimal zip writer: stored or deflate entries, optionally with every size and offset in ZIP64 fields. */
function makeZip(files: In[], zip64 = false): Blob {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  const bytes = (n: number, f: (v: DataView) => void) => { const b = new Uint8Array(n); f(new DataView(b.buffer)); return b; };
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = crc32(f.data), M = 0xffffffff;
    const x64 = zip64 ? bytes(28, (v) => { v.setUint16(0, 1, true); v.setUint16(2, 24, true); v.setBigUint64(4, BigInt(f.data.length), true); v.setBigUint64(12, BigInt(body.length), true); v.setBigUint64(20, BigInt(off), true); }) : new Uint8Array(0);
    const local = bytes(30, (v) => {
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, f.deflate ? 8 : 0, true);
      v.setUint32(14, crc, true); v.setUint32(18, body.length, true); v.setUint32(22, f.data.length, true); v.setUint16(26, name.length, true);
    });
    central.push(bytes(46, (v) => {
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 45, true); v.setUint16(6, 45, true); v.setUint16(8, 0x0800, true); v.setUint16(10, f.deflate ? 8 : 0, true);
      v.setUint32(16, crc, true); v.setUint32(20, zip64 ? M : body.length, true); v.setUint32(24, zip64 ? M : f.data.length, true);
      v.setUint16(28, name.length, true); v.setUint16(30, x64.length, true); v.setUint32(42, zip64 ? M : off, true);
    }), name, x64);
    parts.push(local, name, body);
    off += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const tail: Uint8Array[] = [];
  if (zip64) {
    tail.push(bytes(56, (v) => {
      v.setUint32(0, 0x06064b50, true); v.setBigUint64(4, 44n, true); v.setBigUint64(24, BigInt(files.length), true); v.setBigUint64(32, BigInt(files.length), true);
      v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(off), true);
    }), bytes(20, (v) => { v.setUint32(0, 0x07064b50, true); v.setBigUint64(8, BigInt(off + cdSize), true); v.setUint32(16, 1, true); }));
  }
  tail.push(bytes(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, zip64 ? 0xffff : files.length, true); v.setUint16(10, zip64 ? 0xffff : files.length, true);
    v.setUint32(12, zip64 ? 0xffffffff : cdSize, true); v.setUint32(16, zip64 ? 0xffffffff : off, true);
  }));
  return new Blob([...parts, ...central, ...tail] as BlobPart[]);
}

const same = (a: Uint8Array, b: Uint8Array) => assert.ok(a.length === b.length && a.every((x, i) => x === b[i]));
const FILES: In[] = [
  { name: 'Game Boy/', data: new Uint8Array(0) },
  { name: 'Game Boy/Tobu Tobu Girl (World).gb', data: TOBU },
  { name: 'Game Boy/Couleur/cgb-acid2 é.gbc', data: ACID, deflate: true },
  { name: '__MACOSX/Game Boy/._Tobu Tobu Girl (World).gb', data: new Uint8Array([0, 5, 22, 7]) },
  { name: 'Game Boy/.DS_Store', data: new Uint8Array(12), deflate: true },
];

for (const zip64 of [false, true]) {
  test(`reads stored and deflate entries in nested folders${zip64 ? ' (ZIP64)' : ''}`, async () => {
    const z = makeZip(FILES, zip64);
    const list = await listZip(z);
    assert.deepEqual(list.map((e) => e.name), FILES.map((f) => f.name)); // UTF-8 names, folders and system files listed as they are
    same(await readEntry(z, list[1]), TOBU);
    same(await readEntry(z, list[2]), ACID);
    assert.equal(list[2].method, 8);
    assert.ok(list[2].csize < ACID.length);
    same(await readEntry(z, list[3]), FILES[3].data);
  });
}

test('damaged archives throw a ZipError, never garbage', async () => {
  const good = new Uint8Array(await makeZip(FILES).arrayBuffer());
  await assert.rejects(listZip(new Blob([TOBU])), ZipError); // not a zip
  await assert.rejects(listZip(new Blob([good.slice(0, good.length - 30)])), ZipError); // truncated
  await assert.rejects(listZip(new Blob([good.slice(20000)])), ZipError); // head cut off: directory points past the data
  const list = await listZip(new Blob([good]));
  const flip = (i: number) => { const b = good.slice(); b[i] ^= 0xff; return new Blob([b]); };
  const dataAt = (e: typeof list[number]) => e.offset + 30 + new TextEncoder().encode(e.name).length;
  await assert.rejects(readEntry(flip(dataAt(list[1]) + 0x200), list[1]), ZipError); // stored: CRC mismatch
  await assert.rejects(readEntry(flip(dataAt(list[2]) + 40), list[2]), ZipError); // deflate stream broken
  await assert.rejects(readEntry(new Blob([good]), { ...list[2], size: 100 }), ZipError); // inflates past its declared size
  await assert.rejects(readEntry(new Blob([good]), { ...list[1], method: 14 }), /Unsupported compression/);
});
