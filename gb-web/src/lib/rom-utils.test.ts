// node --test: a copier-headed dump is the bundled homebrew ROM behind 512 bytes of padding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headerNames, isGameBoyRom, mapperSupported, parseRomHeader, savSizeError, withoutCopierHeader } from './rom-utils.ts';
import type { RomMetadata } from './rom-utils.ts';

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

test('HuC1, HuC3, MBC7, MMM01, MBC6 and TAMA5 cartridges can be played', () => {
  const on = (cartridgeType: string) => mapperSupported({ cartridgeType } as RomMetadata);
  assert.equal(on('HuC1+RAM+BATTERY'), true);
  assert.equal(on('HuC3'), true);
  assert.equal(on('MBC7+SENSOR+RUMBLE+RAM+BATTERY'), true);
  assert.equal(on('MMM01'), true);
  assert.equal(on('MBC6'), true);
  assert.equal(on('BANDAI TAMA5'), true);
  assert.equal(on('MBC1+RAM+BATTERY'), true);
  assert.equal(on('ROM+RAM'), false);
});

/** A 256 KiB ROM with `type` in bank 0's header and `menu` in the last 32 KiB's, both checksummed. */
function rom(type: number, menu: number, ram = 0x03) {
  const d = new Uint8Array(0x40000);
  for (const [at, ct] of [[0, type], [0x38000, menu]]) {
    d[at + 0x147] = ct;
    d[at + 0x149] = ram;
    let sum = 0;
    for (let a = 0x134; a <= 0x14c; a++) sum = (sum - d[at + a] - 1) & 0xff;
    d[at + 0x14d] = sum;
  }
  return d;
}

test('an MMM01 cartridge is named by the menu header in its last 32 KiB', () => {
  const h = parseRomHeader(rom(0x01, 0x0d));
  assert.equal(h?.cartridgeType, 'MMM01+RAM+BATTERY');
  assert.equal(mapperSupported(h!), true);
  assert.equal(parseRomHeader(rom(0x01, 0x00))?.cartridgeType, 'MBC1', 'no menu header: bank 0 names the mapper');
  assert.equal(savSizeError(rom(0x01, 0x0d), 32768), null, "the menu header's RAM size");
});

test('MBC6 and TAMA5 .sav files carry the flash and the clock after the RAM', () => {
  assert.equal(savSizeError(rom(0x20, 0x00), 32768 + 0x100000), null);
  assert.equal(savSizeError(rom(0xfd, 0x00, 0x00), 32 + 60), null);
});
