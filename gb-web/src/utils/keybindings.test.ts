// node --test: which key presses are the browser's shortcuts, not the game's buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chord } from './keybindings.ts';

const key = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('a modifier pressed on its own is a key a button can be bound to', () => {
  assert.equal(chord(key('Control', { ctrlKey: true })), false);
  assert.equal(chord(key('Meta', { metaKey: true })), false);
  assert.equal(chord(key('Alt', { altKey: true })), false);
  assert.equal(chord(key('z')), false);
});

test('a key pressed with Ctrl, ⌘ or Alt held is a shortcut', () => {
  assert.equal(chord(key('r', { ctrlKey: true })), true);
  assert.equal(chord(key('f', { metaKey: true })), true);
  assert.equal(chord(key('ArrowLeft', { altKey: true })), true);
  assert.equal(chord(key('Meta', { ctrlKey: true, metaKey: true })), true);
});
