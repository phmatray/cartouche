// node --test: gamepad → menu keys, with auto-repeat for held directions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjust, held, reader, type PadKey } from './pad.ts';

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

test('left/right step a slider and cycle a dropdown (A too); other keys and elements pass through', () => {
  const events: string[] = [];
  const dispatchEvent = (e: Event) => { events.push(e.type); return true; };
  let v = 50;
  const range = { tagName: 'INPUT', type: 'range', get value() { return String(v); }, stepUp() { v = Math.min(100, v + 5); }, stepDown() { v = Math.max(0, v - 5); }, dispatchEvent };
  assert.equal(adjust(range, 'ArrowRight'), true);
  assert.equal(v, 55);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(adjust(range, 'ArrowLeft'), true);
  assert.equal(v, 50);
  assert.equal(adjust(range, 'ArrowDown'), false); // up/down leave it
  assert.equal(adjust(range, 'a'), false);
  v = 100; events.length = 0;
  assert.equal(adjust(range, 'ArrowRight'), true); // at the end: taken, no event
  assert.deepEqual(events, []);

  const sel = { tagName: 'SELECT', selectedIndex: 0, options: [{ disabled: false }, { disabled: true }, { disabled: false }], dispatchEvent };
  assert.equal(adjust(sel, 'a'), true);
  assert.equal(sel.selectedIndex, 2); // skips the disabled one
  assert.equal(adjust(sel, 'ArrowRight'), true);
  assert.equal(sel.selectedIndex, 0); // wraps
  assert.equal(adjust(sel, 'ArrowLeft'), true);
  assert.equal(sel.selectedIndex, 2);
  assert.deepEqual(events, ['input', 'change', 'input', 'change', 'input', 'change']);
  assert.equal(adjust(sel, 'ArrowUp'), false);

  assert.equal(adjust({ tagName: 'BUTTON', dispatchEvent }, 'ArrowRight'), false);
  assert.equal(adjust({ tagName: 'INPUT', type: 'text', dispatchEvent }, 'ArrowRight'), false);
  assert.equal(adjust(null, 'a'), false);
});
