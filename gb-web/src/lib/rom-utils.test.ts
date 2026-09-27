// node --test: a copier-headed dump is the bundled homebrew ROM behind 512 bytes of padding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headerNames, isGameBoyRom, withoutCopierHeader } from './rom-utils.ts';

const TOBU = new Uint8Array(readFileSync(new URL('../../public/roms/tobutobugirl.gb', import.meta.url)));

test('a 512-byte copier header is dropped, a clean dump is kept as is', () => {
  const dump = new Uint8Array(TOBU.length + 0x200);
  dump.set(TOBU, 0x200);
  assert.equal(isGameBoyRom(dump), false);
  const rom = withoutCopierHeader(dump);
  assert.equal(isGameBoyRom(rom), true);
  assert.equal(rom.buffer.byteLength, TOBU.length, 'a copy, not a view over the header');
  assert.deepEqual(rom, TOBU);
  assert.equal(withoutCopierHeader(TOBU), TOBU);
});

test('a header title names a catalog game by its whole title or a 6+ character start of it', () => {
  assert.equal(headerNames('Opossum Country', 'OPOSSUMCOUNTR'), true);
  assert.equal(headerNames('Tobu Tobu Girl', 'TOBU TOBU GIRL'), true);
  assert.equal(headerNames('Tobu', 'TOBU'), true);
  assert.equal(headerNames('Some Game', 'ULTRA3'), false);
  assert.equal(headerNames('Tobu Tobu Girl', 'TOBU'), false, 'too short to be a prefix');
  assert.equal(headerNames('Some Game', ''), false);
});
