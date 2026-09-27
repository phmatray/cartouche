// node --test: when Live translate calls a text box finished, and what it learns from a corrected original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, corrections, settle, settleState } from './session.ts';

test('a box settles once its text stops changing, and once only', () => {
  const s = settleState();
  // Typewriter printing: the text grows every sample.
  assert.equal(settle(s, 'この', 0), false);
  assert.equal(settle(s, 'このまま', 160), false);
  assert.equal(settle(s, 'このままでは', 320), false);
  assert.equal(settle(s, 'このままでは', 500), false); // held 180 ms
  assert.equal(settle(s, 'このままでは', 700), true); // held 380 ms: done printing
  assert.equal(settle(s, 'このままでは', 900), false); // already handled
  // The box closes, then the same line comes back later: it settles again.
  assert.equal(settle(s, '', 1000), false);
  assert.equal(settle(s, 'このままでは', 1100), false);
  assert.equal(settle(s, 'このままでは', 1500), true);
});

test('empty screens never settle', () => {
  const s = settleState();
  assert.equal(settle(s, '', 0), false);
  assert.equal(settle(s, '', 1000), false);
});

const g = (s: string) => [...s].map((char, i) => ({ key: `k${char}${i}`, char })).filter((x) => x.char !== ' ');

test('corrections line the read glyphs up with the corrected text', () => {
  // め misread for の, twice; spaces don't count.
  assert.deepEqual(corrections(g('むらめ ためにも'), 'むらの ためにも'), [['kめ2', 'の']]);
  // A kana voiced by a mark on another tile is not a misreading of that tile.
  assert.deepEqual(corrections(g('かきくけこ'), 'がきくけこ'), []);
  // Different lengths or too many differences: a rewrite, nothing to learn.
  assert.deepEqual(corrections(g('むらめ'), 'むらのため'), []);
  assert.deepEqual(corrections(g('あいうえ'), 'かきくけ'), []);
});

test('a correction is learned on its second agreeing sighting', () => {
  const pending = new Map<string, { char: string; n: number }>();
  assert.deepEqual(confirm(pending, [['k1', 'の']]), []);
  assert.deepEqual(confirm(pending, [['k1', 'ぬ']]), []); // disagrees: starts over
  assert.deepEqual(confirm(pending, [['k1', 'ぬ']]), [['k1', 'ぬ']]);
  assert.deepEqual(confirm(pending, [['k1', 'ぬ']]), []); // reported once
});
