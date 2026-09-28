import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageThrough } from './ui.ts';

test('pageThrough shows whole pages up to and including the item', () => {
  assert.equal(pageThrough(0, 96), 96);
  assert.equal(pageThrough(95, 96), 96);
  assert.equal(pageThrough(96, 96), 192); // the first box of page two needs page two
  assert.equal(pageThrough(4999, 96), 5088);
});
