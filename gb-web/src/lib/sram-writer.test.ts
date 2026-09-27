// node --test: a player writes its battery save at once, only when it changed, and never over a save written elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeOlderThan, SramWriter } from './sram-writer.ts';
import type { StoredSave } from './db.ts';

function store() {
  const db = new Map<string, StoredSave>();
  const io = {
    read: async (id: string) => db.get(id),
    put: async (s: StoredSave) => { db.set(s.id, s); },
    fork: async (of: StoredSave | undefined, id: string) => ({ id: `${id}~2`, gameId: id, name: `${of?.name} 2`, sram: new Uint8Array(), timestamp: 0, created: 0 }),
  };
  return { db, io };
}
const b = (...x: number[]) => Uint8Array.from(x);

test('writes once per change, as one put issued at once', async () => {
  const { db, io } = store();
  db.set('g', { id: 'g', gameId: 'g', name: 'Main', sram: b(1, 1), timestamp: 1, created: 1 });
  const w = new SramWriter(io);
  assert.equal(w.write('g', b(1, 2), 'Main'), 'unknown'); // nothing learnt yet
  await w.check('g');
  assert.equal(w.write('g', b(1, 1), 'Main'), null); // loaded as is (a paused tab): nothing to write
  const r = w.write('g', b(1, 2), 'Main', 5);
  assert.ok(r && r !== 'unknown');
  assert.deepEqual(db.get('g'), { id: 'g', gameId: 'g', name: 'Main', sram: b(1, 2), timestamp: 5, created: 1 }); // synchronous put
  assert.equal(w.write('g', b(1, 2), 'Main'), null);
  // First save of a game: a new Main.
  const w2 = new SramWriter(io);
  await w2.check('h');
  assert.equal(w2.write('h', b(0, 0), 'Main'), null); // blank RAM: nothing to keep
  w2.write('h', b(7), 'Main', 9);
  assert.deepEqual(db.get('h'), { id: 'h', gameId: 'h', name: 'Main', sram: b(7), timestamp: 9, created: 9 });
});

test('a save written elsewhere is never overwritten: the next change goes to a new profile', async () => {
  const { db, io } = store();
  db.set('g', { id: 'g', gameId: 'g', name: 'Main', sram: b(0), timestamp: 1, created: 1 });
  const w = new SramWriter(io);
  await w.check('g');
  db.set('g', { id: 'g', gameId: 'g', name: 'Main', sram: b(9), timestamp: 2, created: 1 }); // another tab, sync, a restore
  await w.check('g');
  assert.equal(w.write('g', b(0), 'Main'), null); // paused: still nothing
  const r = w.write('g', b(5), 'Main', 3);
  assert.ok(r && r !== 'unknown');
  assert.equal(r.to.id, 'g~2');
  assert.deepEqual(db.get('g')!.sram, b(9)); // kept
  assert.deepEqual(db.get('g~2'), { id: 'g~2', gameId: 'g', name: 'Main 2', sram: b(5), timestamp: 3, created: 0 });
  // From then on it plays in the new profile.
  await w.check('g~2');
  w.write('g~2', b(6), 'Main', 4);
  assert.deepEqual(db.get('g~2')!.sram, b(6));
  assert.deepEqual(db.get('g')!.sram, b(9));
});

test('measured against the record the game loaded, even when the store moved before the first check', async () => {
  const { db, io } = store();
  const x = { id: 'g', gameId: 'g', name: 'Main', sram: b(1), timestamp: 1, created: 1 };
  db.set('g', { ...x, sram: b(9), timestamp: 2 }); // a sync pull landed right after the game loaded x
  const w = new SramWriter(io);
  w.adopt('g', x);
  await w.check('g');
  const r = w.write('g', b(0, 5), 'Main', 3); // the game rewrote its RAM on boot
  assert.ok(r && r !== 'unknown');
  assert.equal(r.to.id, 'g~2');
  assert.deepEqual(db.get('g')!.sram, b(9));
});

test('a rename made elsewhere (same time) is kept by the next write', async () => {
  const { db, io } = store();
  const x = { id: 'g', gameId: 'g', name: 'Main', sram: b(5), timestamp: 1, created: 1 };
  db.set('g', x);
  const w = new SramWriter(io);
  w.adopt('g', x);
  db.set('g', { ...x, name: 'Léa' }); // the game page renames it while the game runs here
  await w.check('g');
  const r = w.write('g', b(6), 'Main', 2);
  assert.ok(r && r !== 'unknown');
  assert.deepEqual(db.get('g'), { ...x, name: 'Léa', sram: b(6), timestamp: 2 });
});

test('what this player wrote, written over elsewhere, goes to a new profile even when the game did not change it since', async () => {
  const { db, io } = store();
  db.set('g', { id: 'g', gameId: 'g', name: 'Main', sram: b(1), timestamp: 1, created: 1 });
  const w = new SramWriter(io);
  await w.check('g');
  w.write('g', b(21), 'Main', 2); // this player's progress
  db.set('g', { id: 'g', gameId: 'g', name: 'Main', sram: b(6), timestamp: 3, created: 1 }); // another page wrote over it
  await w.check('g');
  const r = w.write('g', b(21), 'Main', 4); // the same RAM as its last write
  assert.ok(r && r !== 'unknown');
  assert.equal(r.to.id, 'g~2');
  assert.deepEqual(db.get('g~2')!.sram, b(21));
  assert.deepEqual(db.get('g')!.sram, b(6));
  assert.equal(w.write('g~2', b(21), 'Main'), null); // once
  // A save only loaded here (never written) and replaced elsewhere is not copied back while unchanged.
  const w2 = new SramWriter(io);
  w2.adopt('h', { id: 'h', gameId: 'h', name: 'Main', sram: b(1), timestamp: 1, created: 1 });
  db.set('h', { id: 'h', gameId: 'h', name: 'Main', sram: b(2), timestamp: 2, created: 1 });
  await w2.check('h');
  assert.equal(w2.write('h', b(1), 'Main'), null);
});

test('a resume point is older than a battery save written well after it, not one from the same leave', () => {
  assert.equal(resumeOlderThan(10_000, undefined), false); // no battery save
  assert.equal(resumeOlderThan(10_000, { timestamp: 9_000 }), false); // the save is older
  assert.equal(resumeOlderThan(10_000, { timestamp: 10_050 }), false); // the same leave wrote both
  assert.equal(resumeOlderThan(10_000, { timestamp: 60_000 }), true); // a link session wrote it later
});
