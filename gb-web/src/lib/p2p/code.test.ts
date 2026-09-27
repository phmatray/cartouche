import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_LENGTH, inviteUrl, makeCode, parseCode, spaced } from './code.ts';

test('codes are six unambiguous characters', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.doesNotMatch(c, /[0O1IL5S2Z]/);
    assert.equal(parseCode(c), c);
  }
  // Bytes 243-255 are skipped, so every character is equally likely.
  let calls = 0;
  assert.equal(makeCode(() => (calls++ ? new Uint8Array([0, 1, 2, 3, 4, 5]) : new Uint8Array(6).fill(250))), '346789');
});

test('reads codes the way people type or paste them', () => {
  assert.equal(parseCode(' k7m-q3p '), 'K7MQ3P');
  assert.equal(parseCode('K7M·Q3P'), 'K7MQ3P');
  assert.equal(parseCode(inviteUrl('K7MQ3P', 'https://example.org/cartouche/')), 'K7MQ3P');
  assert.equal(parseCode('K7MQ3'), null);
  assert.equal(parseCode('K7MQ3O'), null);
  assert.equal(spaced('K7MQ3P'), 'K7M·Q3P');
  assert.equal(inviteUrl('K7MQ3P', 'https://example.org/cartouche/'), 'https://example.org/cartouche/link-cable/online?room=K7MQ3P');
});
