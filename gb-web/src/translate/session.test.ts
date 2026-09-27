// node --test: when Live translate calls a text box finished, and what it learns from a corrected original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BG_CRAM_OFF, META_LEN, OAM_OFF, VRAM_OFF } from '../neural/trace.ts';
import { confirm, corrections, sameText, settle, settleState } from './session.ts';

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

test('the same text: sprites moving do not count, a BG palette fade or new tiles do', () => {
  const a = new Uint8Array(META_LEN), b = a.slice();
  b[OAM_OFF + 5] = 42; // a sprite moved
  assert.equal(sameText(a, b), true);
  b[BG_CRAM_OFF + 3] = 0x7f; // a Game Boy Color fade: only the BG palettes change
  assert.equal(sameText(a, b), false);
  const c = a.slice();
  c[VRAM_OFF + 0x1800] = 7; // a new tile in the map
  assert.equal(sameText(a, c), false);
});
