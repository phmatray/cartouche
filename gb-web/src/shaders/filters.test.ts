// node --test: SameBoy's LCD colour curves, and stored display settings made safe to render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctRgb555 } from './lcd-curves.ts';
import { cpuColor, normalizeDisplay, presetOf } from './filters.ts';

// Literals printed by SameBoy v1.0.3 itself, never recomputed from the ported tables: Core/display.c
// lines 314-475 (temperature_tint .. GB_convert_rgb15) compiled standalone with a stub GB_gameboy_t
// (color_correction_mode = GB_COLOR_CORRECTION_MODERN_BALANCED, model GB_MODEL_CGB_E or GB_MODEL_AGB_A,
// light_temperature 0), `cc -w harness.c -lm`, then GB_convert_rgb15(&gb, r | g << 5 | b << 10, false).
const SAMEBOY: ['gbc' | 'gba', number, number, number, [number, number, number]][] = [
  ['gbc', 31, 31, 31, [255, 255, 255]],
  ['gbc', 0, 0, 0, [0, 0, 0]],
  ['gbc', 31, 0, 0, [255, 0, 0]],
  ['gbc', 0, 31, 0, [0, 213, 0]],
  ['gbc', 0, 0, 31, [0, 107, 255]],
  ['gbc', 16, 16, 16, [161, 161, 161]],
  ['gbc', 8, 8, 8, [66, 66, 66]],
  ['gbc', 10, 20, 5, [88, 171, 36]],
  ['gbc', 3, 17, 29, [20, 194, 252]],
  ['gba', 31, 31, 31, [255, 255, 255]],
  ['gba', 0, 0, 0, [0, 0, 0]],
  ['gba', 31, 0, 0, [255, 0, 0]],
  ['gba', 0, 31, 0, [0, 228, 0]],
  ['gba', 0, 0, 31, [0, 83, 255]],
  ['gba', 16, 16, 16, [112, 112, 112]],
  ['gba', 8, 8, 8, [47, 47, 47]],
  ['gba', 10, 20, 5, [62, 132, 26]],
  ['gba', 3, 17, 29, [14, 143, 235]],
];

test('correctRgb555 matches SameBoy v1.0.3 on a CGB and an AGB', () => {
  for (const [mode, r, g, b, want] of SAMEBOY) assert.deepEqual(correctRgb555(r, g, b, mode), want, `${mode} ${r},${g},${b}`);
});

test('the old correction values read as GBC LCD', () => {
  for (const correction of ['vivid', 'accurate']) {
    assert.equal(normalizeDisplay({ preset: 'gbc-accurate', filters: { correction } }, 'cgb').filters.correction, 'gbc');
  }
  assert.equal(normalizeDisplay({ preset: 'gbc-accurate', filters: { correction: 'gba' } }, 'cgb').filters.correction, 'gba');
  assert.equal(normalizeDisplay({ preset: 'gbc-accurate', filters: { correction: 'sepia' } }, 'cgb').filters.correction, 'gbc');
});

test('an unknown ghostMode falls back to the preset', () => {
  const want = presetOf('gbc-accurate')!.filters.ghostMode;
  assert.equal(normalizeDisplay({ preset: 'gbc-accurate', filters: { ghostMode: 'trail' } }, 'cgb').filters.ghostMode, want);
  assert.equal(normalizeDisplay({ preset: 'gbc-accurate', filters: { ghostMode: 'blend' } }, 'cgb').filters.ghostMode, 'blend');
});

test('cpuColor corrects the 5-bit value the core drew', () => {
  const f = normalizeDisplay({ preset: 'clean' }, 'cgb').filters;
  const px = (c5: number[]) => new Uint8ClampedArray([...c5.map((c) => Math.floor(c * 255 / 31)), 255]);
  for (const [mode, r, g, b] of SAMEBOY) {
    const out = cpuColor(px([r, g, b]), { ...f, correction: mode }, true);
    assert.deepEqual([...out.slice(0, 3)], correctRgb555(r, g, b, mode));
  }
  assert.deepEqual([...cpuColor(px([10, 20, 5]), { ...f, correction: 'off' }, true)], [...px([10, 20, 5])]);
});
