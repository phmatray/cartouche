// node --test: opening the player without ?resume goes on from the resume point, never over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootFrom } from './boot-from.ts';

const q = (s: string) => new URLSearchParams(s);

test('an asked-for slot or resume point wins', () => {
  assert.equal(bootFrom(q('?slot=2'), true, true), 2);
  assert.equal(bootFrom(q('?slot=0'), false, false), 0);
  assert.equal(bootFrom(q('?resume=1'), true, true), 'auto');
});

test('no ?resume: the resume point when one exists (Save slots, Edit layout, a reload)', () => {
  assert.equal(bootFrom(q(''), true, true), 'auto');
  assert.equal(bootFrom(q('?tab=saves'), true, true), 'auto');
  assert.equal(bootFrom(q('?edit=controls'), true, true), 'auto');
  assert.equal(bootFrom(q(''), true, false), null);
  assert.equal(bootFrom(q(''), false, true), null); // resume points switched off
});

test('the online link page keeps its own choice', () => {
  assert.equal(bootFrom(q('?online=abc&save=g'), true, true), null);
  assert.equal(bootFrom(q('?online=abc&save=g&resume=1'), true, true), 'auto');
});
