// node --test: a backup's game that shares an id with a different game here gets its own id, and its saves follow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupRom, mergeMeta, mover, placeRom } from './backup-merge.ts';

test('backup ROMs are matched by SHA-1, and a taken id moves the game and its saves', () => {
  const here = new Map([['rom', 'aaa'], ['puzzle', 'ccc'], ['x', 'fff'], ['x-2', 'fff']]);
  const claimed = new Set<string>();
  assert.deepEqual(placeRom('rom', 'bbb', here, claimed), { id: 'rom-2', store: true }); // same id, another game
  assert.deepEqual(placeRom('rom-2', 'ddd', here, claimed), { id: 'rom-2-2', store: true }); // its id was just given away
  assert.deepEqual(placeRom('puzzle-2', 'ccc', here, claimed), { id: 'puzzle', store: false }); // same dump, another id
  assert.deepEqual(placeRom('puzzle', 'ccc', here, claimed), { id: 'puzzle-2', store: true }); // a second copy stays one
  assert.deepEqual(placeRom('rom', 'aaa', here, claimed), { id: 'rom', store: false }); // the same game
  assert.deepEqual(placeRom('x-2', 'fff', here, claimed), { id: 'x-2', store: false }); // two copies: each onto its own
  assert.deepEqual(placeRom('x', 'fff', here, claimed), { id: 'x', store: false });
  assert.deepEqual(placeRom('new', 'eee', here, claimed), { id: 'new', store: true });

  const m = mover(new Map([['rom', 'rom-2'], ['rom-2', 'rom-2-2'], ['puzzle-2', 'puzzle']]));
  assert.deepEqual(m.save({ id: 'rom', gameId: 'rom', name: 'Main' }), { id: 'rom-2', gameId: 'rom-2', name: 'Main' });
  assert.deepEqual(m.save({ id: 'rom-2~x1', gameId: 'rom-2' }), { id: 'rom-2-2~x1', gameId: 'rom-2-2' }); // moved once, not twice
  assert.deepEqual(m.state({ id: 'rom-2-slot-3', profile: 'rom-2~x1' }), { id: 'rom-2-2-slot-3', profile: 'rom-2-2~x1' });
  assert.deepEqual(m.state({ id: 'puzzle-2-auto' }), { id: 'puzzle-auto' });
  assert.deepEqual(m.meta({ id: 'rom', activeSave: 'rom~y' }), { id: 'rom-2', activeSave: 'rom-2~y' });
  assert.deepEqual(m.save({ id: 'other', gameId: 'other' }), { id: 'other', gameId: 'other' }); // not moved
  assert.equal(m.game('rom'), 'rom-2');
});

test('a backup ROM record with a missing or non-text title or genre is repaired, one without id or bytes dropped', () => {
  const data = new Uint8Array([1, 2]);
  assert.deepEqual(backupRom({ id: 'x', title: null, data }), { id: 'x', title: 'x', genre: 'Unknown', data });
  assert.deepEqual(backupRom({ id: 'x', title: 123, genre: {}, data }), { id: 'x', title: 'x', genre: 'Unknown', data });
  assert.deepEqual(backupRom({ id: 'x', title: 'Acid', genre: 'Test', data, extra: 1 }), { id: 'x', title: 'Acid', genre: 'Test', data });
  assert.equal(backupRom({ id: 7, title: 'a', data }), null);
  assert.equal(backupRom({ id: 'x', title: 'a', data: [1, 2] }), null);
  assert.equal(backupRom(null), null);
});

test('a restored game keeps the solo save picked here, else takes the backup’s', () => {
  const backup = { id: 'g', activeSave: 'g~lea', isFavorite: true, totalPlayTime: 50, sessions: 2, lastPlayed: 9 };
  // Played here a little, no save picked: the backup's pick comes with its saves.
  assert.deepEqual(mergeMeta({ id: 'g', totalPlayTime: 10, sessions: 1, lastPlayed: 20 }, backup),
    { id: 'g', isFavorite: true, totalPlayTime: 50, sessions: 2, lastPlayed: 20, importedAt: undefined, activeSave: 'g~lea' });
  assert.equal(mergeMeta({ id: 'g', activeSave: 'g~mine' }, backup).activeSave, 'g~mine');
  assert.deepEqual(mergeMeta(undefined, { ...backup, rom: { title: 't', genre: 'x', sha1: 's', head: new Uint8Array() } }), { ...backup, rom: undefined });
});
