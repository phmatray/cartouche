import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameEntry } from '../types/game';
import { withCatalog, withLocal, withLocals } from './library-merge.ts';

const game = (id: string, o: Partial<GameEntry> = {}): GameEntry => ({ id, title: id, description: '', genre: 'Unknown', category: 'Homebrew', coverArt: '', screenshots: [], isLocal: false, ...o });
const CATALOG = [
  game('tobu', { title: 'Tobu Tobu Girl', sha1: 'aa' }),
  game('opossum', { title: 'Opossum Country' }),
  game('pixel-garden', { title: 'Pixel Garden' }),
  game('moon-racer', { title: 'Moon Racer', sha1: 'bb' }),
];
const local = (id: string, o: Partial<GameEntry> = {}) => game(id, { category: 'My Collection', isLocal: true, ...o });
const ADD = [
  local('tobu'), // same id
  local('x1', { sha1: 'bb', title: 'moon_racer.gb' }), // same SHA-1
  local('x2', { title: 'PIXEL GARDEN' }), // same title
  local('x3', { title: 'oppo.gb', romHeaderTitle: 'OPOSSUMCOUNTR' }), // header prefix
  local('x4', { title: 'Frog Quest' }), // unknown
  local('x4', { title: 'Frog Quest 2' }), // the same id again: replaces it
  local('x5', { title: 'Tobu Tobu Girl' }), // its catalog entry is already taken
];

test('withLocals gives the same shelf as reducing withLocal one ROM at a time', () => {
  for (let n = 0; n <= ADD.length; n++) {
    const add = ADD.slice(0, n);
    assert.deepEqual(withLocals(CATALOG, add), add.reduce(withLocal, CATALOG), `first ${n}`);
  }
  // Onto a shelf that already has user ROMs (an import flush, or the catalog arriving late).
  const shelf = ADD.slice(0, 3).reduce(withLocal, CATALOG);
  assert.deepEqual(withLocals(shelf, ADD.slice(3)), ADD.slice(3).reduce(withLocal, shelf));
  const more = [game('extra', { title: 'Frog Quest' })];
  assert.deepEqual(withCatalog(shelf, more), shelf.filter((g) => g.isLocal).reduce(withLocal, [...shelf.filter((g) => !g.isLocal), ...more]));
});

test('withLocals merges 10,000 ROMs in linear time', () => {
  const catalog = Array.from({ length: 300 }, (_, i) => game(`cat-${i}`, { title: `Homebrew ${i}` }));
  const add = Array.from({ length: 10000 }, (_, i) => local(`rom-${i}`, { title: `Game ${i}` }));
  const t0 = performance.now();
  assert.equal(withLocals(catalog, add).length, 10300);
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `${ms} ms`); // one ROM at a time copies the whole shelf per ROM: over a second
});
