// node --test: what a newly stored ROM keeps of the game known under its id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedMeta } from './db.ts';

const rom = (sha1: string) => ({ title: 't', genre: 'g', sha1, head: new Uint8Array() });

test('a ROM stored under a removed game’s id keeps its stats only when it is the same ROM', () => {
  const played = { id: 'rom', isFavorite: true, totalPlayTime: 7200, sessions: 12, activeSave: 'rom~a' };
  // Another game (file names that aren't Latin all become 'rom'): starts afresh.
  assert.deepEqual(addedMeta({ ...played, removed: 'aaa' }, { id: 'rom', importedAt: 5, rom: rom('bbb') }), { id: 'rom', importedAt: 5, rom: rom('bbb') });
  // The same ROM added again, or a game known without a ROM (bundled, hosted, synced): keeps them.
  assert.deepEqual(addedMeta({ ...played, removed: 'aaa' }, { id: 'rom', importedAt: 5, rom: rom('aaa') }), { ...played, importedAt: 5, rom: rom('aaa') });
  assert.deepEqual(addedMeta(played, { id: 'rom', importedAt: 5, rom: rom('bbb') }), { ...played, importedAt: 5, rom: rom('bbb') });
  assert.deepEqual(addedMeta(undefined, { id: 'x', rom: rom('c') }), { id: 'x', rom: rom('c') });
});
