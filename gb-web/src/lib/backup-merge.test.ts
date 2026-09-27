// node --test: a backup's game that shares an id with a different game here gets its own id, and its saves follow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mover, placeRom } from './backup-merge.ts';

test('backup ROMs are matched by SHA-1, and a taken id moves the game and its saves', () => {
  const here = new Map([['rom', 'aaa'], ['tetris', 'ccc'], ['x', 'fff'], ['x-2', 'fff']]);
  const claimed = new Set<string>();
  assert.deepEqual(placeRom('rom', 'bbb', here, claimed), { id: 'rom-2', store: true }); // same id, another game
  assert.deepEqual(placeRom('rom-2', 'ddd', here, claimed), { id: 'rom-2-2', store: true }); // its id was just given away
  assert.deepEqual(placeRom('tetris-2', 'ccc', here, claimed), { id: 'tetris', store: false }); // same dump, another id
  assert.deepEqual(placeRom('tetris', 'ccc', here, claimed), { id: 'tetris-2', store: true }); // a second copy stays one
  assert.deepEqual(placeRom('rom', 'aaa', here, claimed), { id: 'rom', store: false }); // the same game
  assert.deepEqual(placeRom('x-2', 'fff', here, claimed), { id: 'x-2', store: false }); // two copies: each onto its own
  assert.deepEqual(placeRom('x', 'fff', here, claimed), { id: 'x', store: false });
  assert.deepEqual(placeRom('new', 'eee', here, claimed), { id: 'new', store: true });

  const m = mover(new Map([['rom', 'rom-2'], ['rom-2', 'rom-2-2'], ['tetris-2', 'tetris']]));
  assert.deepEqual(m.save({ id: 'rom', gameId: 'rom', name: 'Main' }), { id: 'rom-2', gameId: 'rom-2', name: 'Main' });
  assert.deepEqual(m.save({ id: 'rom-2~x1', gameId: 'rom-2' }), { id: 'rom-2-2~x1', gameId: 'rom-2-2' }); // moved once, not twice
  assert.deepEqual(m.state({ id: 'rom-2-slot-3', profile: 'rom-2~x1' }), { id: 'rom-2-2-slot-3', profile: 'rom-2-2~x1' });
  assert.deepEqual(m.state({ id: 'tetris-2-auto' }), { id: 'tetris-auto' });
  assert.deepEqual(m.meta({ id: 'rom', activeSave: 'rom~y' }), { id: 'rom-2', activeSave: 'rom-2~y' });
  assert.deepEqual(m.save({ id: 'zelda', gameId: 'zelda' }), { id: 'zelda', gameId: 'zelda' }); // not moved
  assert.equal(m.game('rom'), 'rom-2');
});
