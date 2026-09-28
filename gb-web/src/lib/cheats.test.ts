// node --test: the shape of a cheat code as typed, and the codes the core gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCodes, cleanCheats, normalizeCode } from './cheats.ts';

test('codes are normalized whatever their case, spaces and dashes', () => {
  assert.deepEqual(normalizeCode('3e2 b4f e6e'), { code: '3E2-B4F-E6E', kind: 'genie' });
  assert.deepEqual(normalizeCode('3E2B4F'), { code: '3E2-B4F', kind: 'genie' });
  assert.deepEqual(normalizeCode('01ff34c1'), { code: '01FF34C1', kind: 'shark' });
  assert.deepEqual(normalizeCode('12345'), { error: 'length' });
  assert.deepEqual(normalizeCode('3E2-B4G'), { error: 'format' });
});

test('only the codes switched on go to the core, one per line', () => {
  const list = [
    { code: '3E2-B4F', name: 'a', on: true },
    { code: '01FF34C1', name: '', on: false },
    { code: '01FF35C1', name: '', on: true },
  ];
  assert.equal(activeCodes(list), '3E2-B4F\n01FF35C1');
  assert.equal(activeCodes([]), '');
});

test('a stored list keeps only well-formed codes', () => {
  assert.deepEqual(cleanCheats([{ code: '3E2-B4F', name: 'x', on: true }, { code: 7 }, 'z', { code: 'ok', name: 1, on: 'yes' }]), [
    { code: '3E2-B4F', name: 'x', on: true },
  ]);
  assert.equal(cleanCheats('nope'), undefined);
});
