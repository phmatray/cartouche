// node --test: opening the player without ?resume goes on from the resume point, never over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootFrom, skipSilentResume } from './boot-from.ts';

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

test('a resume point left silent on the Super Game Boy (SNES music) gives way to a fresh start on the Game Boy', () => {
  assert.equal(skipSilentResume('auto', 'sgb', 'dmg', true), true);
  assert.equal(skipSilentResume('auto', 'sgb', 'gbc3', true), true);
  assert.equal(skipSilentResume('auto', 'sgb', 'dmg', false), false); // the player's own choice: resume where it was made
  assert.equal(skipSilentResume('auto', 'sgb', 'sgb', true), false); // Super Game Boy switched back on
  assert.equal(skipSilentResume('auto', 'dmg', 'dmg', true), false);
  assert.equal(skipSilentResume(2, 'sgb', 'dmg', true), false); // a slot asked for loads as asked
});
