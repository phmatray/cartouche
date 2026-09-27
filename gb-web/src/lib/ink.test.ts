import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inkFor, whiteContrast } from './ink.ts';

test('white text passes WCAG AA on the ink of every hue', () => {
  for (let h = 0; h < 360; h++) {
    const [, l] = inkFor(h).match(/(\d+)%\)$/)!;
    assert.ok(whiteContrast(h, 62, +l) >= 4.5, `hue ${h}`);
  }
});

test('the dark hues keep their usual depth, the bright ones go darker', () => {
  assert.equal(inkFor(220), 'hsl(220 62% 32%)'); // blue
  assert.ok(whiteContrast(62, 62, 32) < 4.5); // the olive of a yellow-green box failed before
  assert.notEqual(inkFor(62), 'hsl(62 62% 32%)');
});
