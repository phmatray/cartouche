// node --test: the GBS header the library shows; the same bytes as gb-core/tests/gbs.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGbsFile, parseGbsHeader } from './gbs.ts';

function synthetic(): Uint8Array {
  const g = new Uint8Array(0x70 + 0x30);
  const v = new DataView(g.buffer);
  g.set(new TextEncoder().encode('GBS'), 0);
  g[3] = 1; g[4] = 3; g[5] = 1;
  v.setUint16(6, 0x0400, true); v.setUint16(8, 0x0400, true); v.setUint16(10, 0x0420, true); v.setUint16(12, 0xdfff, true);
  g.set(new TextEncoder().encode('Test'), 0x10);
  g.set(new TextEncoder().encode('Cartouche'), 0x30);
  g[0x70] = 0xc9;
  return g;
}

test('parseGbsHeader reads what the library shows', () => {
  assert.deepEqual(parseGbsHeader(synthetic()), { songs: 3, first: 1, title: 'Test', author: 'Cartouche', copyright: '' });
});

test('parseGbsHeader: null for anything else', () => {
  const rom = new Uint8Array(0x8000);
  rom.set(new TextEncoder().encode('TOBU'), 0x134);
  assert.equal(parseGbsHeader(rom), null);
  assert.equal(parseGbsHeader(new Uint8Array(10)), null);
  const v2 = synthetic(); v2[3] = 2;
  assert.equal(parseGbsHeader(v2), null);
  const none = synthetic(); none[4] = 0;
  assert.equal(parseGbsHeader(none), null);
  const low = synthetic(); low[7] = 0x02;
  assert.equal(parseGbsHeader(low), null);
});

test('isGbsFile goes by the extension', () => {
  assert.equal(isGbsFile('a.GBS'), true);
  assert.equal(isGbsFile('a.gb'), false);
});
