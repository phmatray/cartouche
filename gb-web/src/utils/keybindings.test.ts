// node --test: which key presses are the browser's shortcuts, not the game's buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindable, chord, isKey, learn, resolve, usChar } from './keybindings.ts';

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

const kd = (key: string, code: string) => ({ key, code });

test('a rebind stores the physical key, whatever Shift or the layout makes it type', () => {
  assert.equal(bindable(kd('z', 'KeyZ')), 'KeyZ');
  assert.equal(bindable(kd('!', 'Digit1')), 'Digit1'); // Shift held
  assert.equal(bindable(kd('&', 'Digit1')), 'Digit1'); // AZERTY
  assert.equal(bindable(kd('ArrowUp', 'ArrowUp')), 'ArrowUp');
  assert.equal(bindable(kd('Shift', 'ShiftRight')), 'Shift');
  assert.equal(bindable(kd('AltGraph', 'AltRight')), 'Alt');
});

test('a dead key, or a key with no code, is not bound', () => {
  assert.equal(bindable(kd('Dead', 'BracketLeft')), null);
  assert.equal(bindable(kd('a', '')), null);
});

test('a key press matches its binding with Shift held, on either side', () => {
  assert.ok(isKey('Digit1', kd('!', 'Digit1')));
  assert.ok(isKey('Shift', kd('Shift', 'ShiftLeft')) && isKey('Shift', kd('Shift', 'ShiftRight')));
  assert.ok(!isKey('Digit1', kd('1', 'Numpad1')));
  // A character binding saved before codes still plays by character.
  assert.ok(isKey('é', kd('é', 'Digit2')) && isKey('é', kd('É', 'Digit2')));
});

// A French AZERTY keyboard's layout map (in part): code → the character typed without Shift.
const AZERTY = new Map([['KeyQ', 'a'], ['KeyA', 'q'], ['KeyW', 'z'], ['KeyZ', 'w'], ['KeyX', 'x'], ['Digit1', '&'], ['Digit2', 'é'], ['Semicolon', 'm']]);
const OLD = { Up: 'ArrowUp', A: 'z', B: 'x', Start: 'Enter', Select: 'Shift', Down: '1', Left: 'é', Right: '!' };

test('characters saved before codes resolve to the key that types them on this keyboard', () => {
  assert.deepEqual(resolve(OLD, AZERTY), { ...OLD, A: 'KeyW', B: 'KeyX', Left: 'Digit2' });
  // '1' needs Shift on AZERTY and '!' has no key of its own there: both stay characters, and still match as before.
  assert.equal(resolve({ A: 'KeyZ', B: 'Enter', Down: '!' }, AZERTY), null);
  assert.deepEqual(resolve({ A: 'z' }, new Map([['KeyZ', 'z']])), { A: 'KeyZ' });
});

test('a character saved before codes learns its key from the first press Shift left alone', () => {
  const press = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });
  assert.deepEqual(learn(OLD, press('z', 'KeyW')), { ...OLD, A: 'KeyW' }); // AZERTY: z is typed by KeyW
  assert.deepEqual(learn(OLD, press('Z', 'KeyW')), { ...OLD, A: 'KeyW' }); // Caps Lock
  assert.deepEqual(learn(OLD, press('1', 'Digit1')), { ...OLD, Down: 'Digit1' });
  assert.equal(learn(OLD, press('!', 'Digit1', true)), null); // Shift made it: not the key bound to '!'
  assert.equal(learn(OLD, press('Z', 'KeyZ', true)), null);
  assert.equal(learn(OLD, press('Enter', 'Enter')), null); // already a key
  assert.equal(learn(OLD, press('q', 'KeyA')), null); // bound to nothing
  assert.equal(learn(OLD, press('z', '')), null);
  // Until then the character matches, as before.
  assert.ok(isKey('z', press('z', 'KeyW')) && isKey('!', press('!', 'Slash', true)));
});

test('a code reads as the US character where the browser has no layout', () => {
  assert.deepEqual(['KeyZ', 'Digit1', 'Slash', 'Enter'].map(usChar), ['z', '1', '/', undefined]);
});
