// node --test: every bundled catalog ROM carries the SHA-1 of its file, so lockstep online play can offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameEntry } from '../types/game';
import catalog from './catalog.json' with { type: 'json' };

test('every bundled catalog ROM has the SHA-1 of its file', () => {
  const bundled = (catalog as GameEntry[]).filter((g) => g.romUrl);
  assert.ok(bundled.length > 0);
  for (const g of bundled) {
    const data = readFileSync(join(import.meta.dirname, '../../public', g.romUrl!));
    assert.equal(g.sha1, createHash('sha1').update(data).digest('hex'), `${g.id}: sha1`);
  }
});
