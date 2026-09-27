// node --test: gamepad → menu keys, with auto-repeat for held directions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { held, reader, type PadKey } from './pad.ts';

const pad = (pressed: number[], axes = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes });

test('D-pad, stick, A, B and the menu (Home, or Select + Start together)', () => {
  assert.deepEqual([...held(pad([13, 0]))].sort(), ['ArrowDown', 'a']);
  assert.deepEqual([...held(pad([], [-0.9, 0.2]))], ['ArrowLeft']);
  assert.deepEqual([...held(pad([8]))], []);
  assert.deepEqual([...held(pad([8, 9]))], ['menu']);
  assert.deepEqual([...held(pad([16, 1]))].sort(), ['b', 'menu']);
});

test('a press acts once; a held direction repeats after a delay', () => {
  const read = reader();
  const down = new Set<PadKey>(['ArrowDown', 'a']);
  assert.deepEqual(read(down, 0), ['ArrowDown', 'a']);
  assert.deepEqual(read(down, 100), []);
  assert.deepEqual(read(down, 400), ['ArrowDown']);
  assert.deepEqual(read(down, 450), []);
  assert.deepEqual(read(down, 520), ['ArrowDown']);
  assert.deepEqual(read(new Set(), 600), []);
  assert.deepEqual(read(down, 610), ['ArrowDown', 'a']);
});
