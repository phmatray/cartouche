// node --test: settings from a restored backup are checked field by field, never taken as they come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSetting } from './settings-clean.ts';

const KEYS = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', A: 'z', B: 'x', Start: 'Enter', Select: 'Shift' };

test('a partial keybindings keeps the current keys for the buttons it leaves out', () => {
  assert.deepEqual(cleanSetting('keybindings', { A: 'k', B: 7, Turbo: 'q' }, KEYS), { ...KEYS, A: 'k' });
  assert.deepEqual(cleanSetting('keybindings', {}, KEYS), KEYS);
  assert.equal(cleanSetting('keybindings', 'z', KEYS), undefined);
});

test('channel mutes, per-game choices and layouts drop what is wrong', () => {
  const mutes = { pulse1: false, pulse2: false, wave: false, noise: false };
  assert.deepEqual(cleanSetting('channelMutes', { wave: true, noise: 'yes', x: true }, mutes), { ...mutes, wave: true });
  assert.deepEqual(cleanSetting('gameConsole', { a: 'gbc3', b: 'gbc13', c: 1 }, {}), { a: 'gbc3' });
  assert.deepEqual(cleanSetting('gameSgb', { a: true, b: 'no' }, {}), { a: true });
  assert.deepEqual(cleanSetting('snesMusic', { a: true, b: 1 }, {}), { a: true });
  assert.equal(cleanSetting('snesMusic', 'x', {}), undefined);
  assert.deepEqual(cleanSetting('gameDisplay', { a: {}, b: 3 }, {}), { a: {} });
  assert.deepEqual(cleanSetting('touchLayouts', { 'phone-portrait': { parts: {} } }, {}), {});
  assert.equal(cleanSetting('touchSkin', 'nope', 'box'), undefined);
  assert.equal(cleanSetting('touchSkin', 'pocket', 'box'), 'pocket');
});

test('a display is normalized for both kinds; plain values pass through', () => {
  const d = cleanSetting('display', {}, null) as { dmg: { preset: string }; cgb: { preset: string } };
  assert.ok(d.dmg.preset && d.cgb.preset);
  assert.equal(cleanSetting('masterVolume', 40, 50), 40);
});
test('a start-up animation from a backup: one of the four, or the old switch read as on / off', () => {
  assert.equal(cleanSetting('startupAnimation', 'shelf', 'off'), 'shelf');
  assert.equal(cleanSetting('startupAnimation', true, 'off'), 'registration');
  assert.equal(cleanSetting('startupAnimation', false, 'insert'), 'off');
  assert.equal(cleanSetting('startupAnimation', 'logo', 'off'), undefined);
});
