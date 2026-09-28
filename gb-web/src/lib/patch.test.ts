// node --test: every patch here is hand-assembled from literal bytes; no patch or ROM file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from './zip.ts';
import { applyPatch, patchSource, PatchError } from './patch.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
/** A BPS/UPS file: header + body, then source, target and patch CRC32s. */
function withFooter(head: number[], source: Uint8Array, target: number[]) {
  const b = [...head, ...le32(crc32(source)), ...le32(crc32(new Uint8Array(target)))];
  return new Uint8Array([...b, ...le32(crc32(new Uint8Array(b)))]);
}
const refused = (reason: PatchError['reason']) => (e: unknown) => e instanceof PatchError && e.reason === reason;

const BASE = new Uint8Array([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]);

// IPS: a plain record at 2, an RLE record past the end (the output grows), EOF, then truncated to 12 bytes.
const IPS = new Uint8Array([
  ...ascii('PATCH'),
  0x00, 0x00, 0x02, 0x00, 0x02, 0xaa, 0xbb,
  0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x04, 0xcc,
  ...ascii('EOF'), 0x00, 0x00, 0x0c,
]);
const IPS_OUT = [0x10, 0x11, 0xaa, 0xbb, 0x14, 0x15, 0x16, 0x17, 0x00, 0x00, 0xcc, 0xcc];

// BPS: SourceRead 2, TargetRead 2 (AA BB), SourceCopy 3 from source 5, TargetCopy 3 from target 2.
const BPS_OUT = [0x10, 0x11, 0xaa, 0xbb, 0x15, 0x16, 0x17, 0xaa, 0xbb, 0x15];
const BPS = withFooter([...ascii('BPS1'), 0x88, 0x8a, 0x80, 0x84, 0x85, 0xaa, 0xbb, 0x8a, 0x8a, 0x8b, 0x84], BASE, BPS_OUT);

// UPS: skip 1, XOR 01 (then the 00 terminator), skip 2, XOR FF (then 00).
const UPS_OUT = [0x10, 0x10, 0x12, 0x13, 0x14, 0xea, 0x16, 0x17];
const UPS = withFooter([...ascii('UPS1'), 0x88, 0x88, 0x81, 0x01, 0x00, 0x82, 0xff, 0x00], BASE, UPS_OUT);

test('IPS: plain and RLE records, growth and truncation, unverified', () => {
  const r = applyPatch(BASE, IPS);
  assert.deepEqual([...r.data], IPS_OUT);
  assert.equal(r.verified, false);
  assert.deepEqual([...BASE], [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17], 'the base is untouched');
});

test('BPS: all four actions, verified', () => {
  const r = applyPatch(BASE, BPS);
  assert.deepEqual([...r.data], BPS_OUT);
  assert.equal(r.verified, true);
});

test('UPS: XOR chunks, verified', () => {
  const r = applyPatch(BASE, UPS);
  assert.deepEqual([...r.data], UPS_OUT);
  assert.equal(r.verified, true);
});

test('patchSource: the base size and CRC32 for BPS/UPS, null for IPS', () => {
  assert.deepEqual(patchSource(BPS), { size: 8, crc32: crc32(BASE) });
  assert.deepEqual(patchSource(UPS), { size: 8, crc32: crc32(BASE) });
  assert.equal(patchSource(IPS), null);
});

test('a corrupted byte, the wrong base or a truncated file is refused with its reason', () => {
  for (const p of [BPS, UPS]) {
    const bad = p.slice();
    bad[8] ^= 0x01;
    assert.throws(() => applyPatch(BASE, bad), refused('patch'));
    const other = BASE.slice();
    other[0] = 0x99;
    assert.throws(() => applyPatch(other, p), refused('source'));
    assert.throws(() => applyPatch(BASE, p.slice(0, 10)), refused('format'));
  }
  assert.throws(() => applyPatch(BASE, IPS.slice(0, 10)), refused('format'));
  assert.throws(() => applyPatch(BASE, new Uint8Array(ascii('NOPE!EOF'))), refused('format'));
});

test('an IPS output past the largest ROM is refused as too big', () => {
  const far = new Uint8Array([...ascii('PATCH'), 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, ...ascii('EOF')]);
  assert.throws(() => applyPatch(BASE, far), refused('size'));
});
