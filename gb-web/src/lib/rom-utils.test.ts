// node --test: a copier-headed dump is the bundled homebrew ROM behind 512 bytes of padding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isGameBoyRom, withoutCopierHeader } from './rom-utils.ts';

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
