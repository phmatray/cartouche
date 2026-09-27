// node --test: touch layouts anchor to the nearest edge, clamp what they're given and survive an export/import round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centreOf, cleanLayout, exportControls, importControls, MIN_SCALE, overlaps, placeAt, type Layout } from './touch-layout.ts';

test('a place anchors to the nearest third and gives back its centre', () => {
  const p = placeAt('ab', 300, 500, 390, 600);
  assert.equal(p.ax, 1);
  assert.equal(p.ay, 1);
  assert.deepEqual(centreOf(p, 390, 600), { x: 300, y: 500 });
  // the same place on a taller, wider phone stays as far from the bottom right corner
  assert.deepEqual(centreOf(p, 430, 700), { x: 340, y: 600 });
  assert.equal(placeAt('ss', 195, 300, 390, 600).ax, 0.5);
});

test('scale and opacity are clamped (no button under 44 px)', () => {
  const p = placeAt('dpad', 10, 10, 100, 100, 0.1, 0);
  assert.equal(p.s, MIN_SCALE.dpad);
  assert.ok(p.o > 0);
});

test('overlap', () => {
  assert.ok(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 20, bottom: 20 }));
  assert.ok(!overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 }));
});

test('clean layout rejects junk and keeps the required parts', () => {
  assert.equal(cleanLayout(null), null);
  assert.equal(cleanLayout({ parts: { dpad: {} } }), null);
  const ok = (x: number) => ({ ax: 0, x, ay: 1, y: -80, s: 1, o: 1 });
  const l = cleanLayout({ overlay: 'yes', parts: { dpad: { ...ok(0), x: 1e9, s: 9 }, ab: ok(200), ss: ok(100), ff: { ...ok(300), y: null }, evil: {} } })!;
  assert.equal(l.overlay, false);
  assert.equal(l.parts.dpad!.x, 4000);
  assert.equal(l.parts.dpad!.s, 1.6);
  assert.ok(!('evil' in l.parts));
  assert.ok(!('ff' in l.parts), 'a part with a bad field is dropped');
  // a required part with a bad field, or the required parts stacked on one spot: not a layout
  assert.equal(cleanLayout({ parts: { dpad: { ...ok(0), x: '1e9' }, ab: ok(200), ss: ok(100) } }), null);
  assert.equal(cleanLayout({ parts: { dpad: ok(0), ab: ok(0), ss: ok(100) } }), null);
});

test('export and import round trip; foreign files are refused', () => {
  const layout: Layout = { overlay: true, parts: { dpad: placeAt('dpad', 90, 400, 390, 600), ab: placeAt('ab', 300, 400, 390, 600), ss: placeAt('ss', 195, 550, 390, 600), ff: placeAt('ff', 195, 450, 390, 600) } };
  const back = importControls(exportControls({ skin: 'color', shell: 'lagoon', layouts: { 'phone-landscape': layout, nope: layout } }))!;
  assert.equal(back.skin, 'color');
  assert.equal(back.shell, 'lagoon');
  assert.deepEqual(back.layouts, { 'phone-landscape': layout });
  assert.equal(importControls('{"app":"other"}'), null);
  assert.equal(importControls('not json'), null);
});
