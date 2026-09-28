// node --test: which key presses are the browser's shortcuts, not the game's buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindable, chord } from './keybindings.ts';

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

const kd = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });

test('a rebind stores the key as the player matches it', () => {
  assert.equal(bindable(kd('Z', 'KeyZ')), 'z');
  assert.equal(bindable(kd('ArrowUp', 'ArrowUp')), 'ArrowUp');
  assert.equal(bindable(kd('Shift', 'ShiftLeft', true)), 'Shift');
  assert.equal(bindable(kd('&', 'Digit1')), '&'); // AZERTY: the key alone types &
});

test('a key captured with Shift held binds its own character, not the shifted one', () => {
  assert.equal(bindable(kd('!', 'Digit1', true)), '1');
  assert.equal(bindable(kd('A', 'KeyA', true)), 'a');
  assert.equal(bindable(kd('1', 'Digit1', true), new Map([['Digit1', '&']])), '&');
  assert.equal(bindable(kd('?', 'Slash', true), new Map([['Slash', '/']])), '/');
  // Unknown without the layout: nothing bound (an AZERTY digit, a symbol).
  assert.equal(bindable(kd('1', 'Digit1', true)), null);
  assert.equal(bindable(kd('?', 'Slash', true)), null);
});

test('a dead key is not bound', () => {
  assert.equal(bindable(kd('Dead', 'BracketLeft')), null);
  assert.equal(bindable(kd('Dead', 'Quote', true)), null);
  assert.equal(bindable(kd('Unidentified', '')), null);
});
