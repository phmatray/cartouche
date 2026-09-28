import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreed, copyName, gameOfKey, gamesOf, gcGone, plan, type Entry, type Manifest } from './manifest.ts';

const m = (name: string, entries: Entry[], roms = false): Manifest => ({ dev: name.toLowerCase(), name, roms, games: {}, entries });
const e = (k: string, h: string, t: number, extra: Partial<Entry> = {}): Entry => ({ k, h, t, n: 100, ...extra });

test('only what differs is pulled', () => {
  const a = m('Mac', [e('sram:g1', 'aa', 1), e('sram:g2', 'bb', 1)]);
  const b = m('iPhone', [e('sram:g1', 'aa', 5), e('sram:g2', 'cc', 9), e('state:g3#auto', 'dd', 2)]);
  const p = plan(a, b, { 'sram:g2': 'bb' });
  assert.deepEqual(p.pull.map((x) => [x.k, x.dest]), [['sram:g2', 'sram:g2'], ['state:g3#auto', 'state:g3#auto']]);
  assert.equal(p.conflicts.length, 0);
  // The other way round, nothing: the Mac has nothing the iPhone lacks.
  assert.deepEqual(plan(b, a, { 'sram:g2': 'bb' }).pull, []);
});

test('a save changed on one side only is taken from that side, whatever the clocks say', () => {
  const a = m('Mac', [e('sram:g', 'new', 1)]); // changed here, but this clock is behind
  const b = m('iPhone', [e('sram:g', 'base', 50)]);
  assert.deepEqual(plan(a, b, { 'sram:g': 'base' }).pull, []);
  assert.deepEqual(plan(b, a, { 'sram:g': 'base' }).pull.map((x) => x.k), ['sram:g']);
});

test('a save changed on both sides is kept twice, the same way on both devices', () => {
  const a = m('Mac', [e('sram:g', 'aaaaaaaaaa', 100)]);
  const b = m('iPhone', [e('sram:g', 'bbbbbbbbbb', 200)]); // newer
  const onMac = plan(a, b, { 'sram:g': 'old' });
  const onPhone = plan(b, a, { 'sram:g': 'old' });
  // Mac: its own (older) save is copied aside, the iPhone's takes the name.
  assert.deepEqual(onMac.moves, [{ from: 'sram:g', to: 'sram:g~saaaaaaaa' }]);
  assert.deepEqual(onMac.pull.map((x) => [x.k, x.dest]), [['sram:g', 'sram:g']]);
  // iPhone: keeps its own, and takes the Mac's as the same copy.
  assert.deepEqual(onPhone.moves, []);
  assert.deepEqual(onPhone.pull.map((x) => [x.k, x.dest]), [['sram:g', 'sram:g~saaaaaaaa']]);
  assert.deepEqual(onMac.conflicts[0], { k: 'sram:g', copy: 'sram:g~saaaaaaaa', kept: 'remote', olderFrom: 'Mac', olderAt: 100 });
  assert.equal(onPhone.conflicts[0].olderFrom, 'Mac');
  // First sync ever (no base) with two different saves: a conflict too, never a silent overwrite.
  assert.equal(plan(a, b, {}).conflicts.length, 1);
});

test('a state conflict takes the first slot free on both devices, or leaves both alone', () => {
  const a = m('Mac', [e('state:g#auto', 'a1', 100), e('state:g#slot-0', 'x', 1)]);
  const b = m('iPhone', [e('state:g#auto', 'b1', 200), e('state:g#slot-1', 'y', 1)]);
  const onMac = plan(a, b, {});
  const onPhone = plan(b, a, {});
  assert.equal(onMac.conflicts[0].copy, 'state:g#slot-2');
  assert.equal(onPhone.conflicts[0].copy, 'state:g#slot-2');
  const full = (name: string, h: string, t: number) => m(name, [e('state:g#slot-0', h, t), ...[1, 2, 3, 4].map((i) => e(`state:g#slot-${i}`, 's', 1))]);
  const p = plan(full('Mac', 'a', 1), full('iPhone', 'b', 2), {});
  assert.equal(p.conflicts[0].copy, null);
  assert.deepEqual(p.pull, []);
  assert.deepEqual(p.moves, []);
});

test('the older resume point goes with the older save of the same device, the same way on both devices', () => {
  const a = m('Mac', [e('sram:g', 'aaaaaaaaaa', 100), e('state:g#auto', 'sa', 100, { p: 'g' })]);
  const b = m('iPhone', [e('sram:g', 'bbbbbbbbbb', 200), e('state:g#auto', 'sb', 200, { p: 'g' })]);
  const onMac = plan(a, b, {}), onPhone = plan(b, a, {});
  for (const p of [onMac, onPhone]) assert.equal(p.conflicts.find((c) => c.k === 'state:g#auto')!.profile, 'g~saaaaaaaa');
  // The older state is from the other device than the older save: it stays with its save.
  const c = m('Mac', [e('sram:g', 'aaaaaaaaaa', 300), e('state:g#auto', 'sa', 100, { p: 'g' })]);
  assert.equal(plan(c, b, {}).conflicts.find((x) => x.k === 'state:g#auto')!.profile, undefined);
  // Another save's state, or no save conflict: unchanged.
  const d = m('Mac', [e('sram:g', 'aaaaaaaaaa', 100), e('state:g#auto', 'sa', 100, { p: 'g~p2' })]);
  assert.equal(plan(d, b, {}).conflicts.find((x) => x.k === 'state:g#auto')!.profile, undefined);
});

test('small records: the last writer wins, deletions included; play time merges', () => {
  const a = m('Mac', [
    e('set:defaultSpeed', 'h1', 10, { v: 1 }), e('fav:g', 'f1', 50, { v: true }),
    e('set:gameDisplay/g', 'd1', 5, { v: { preset: 'x' } }), e('play:g', 'p1', 1, { v: { time: 100, sessions: 2, last: 1000 } }),
  ]);
  const b = m('iPhone', [
    e('set:defaultSpeed', 'h2', 20, { v: 2 }), e('fav:g', 'f2', 40, { v: false }),
    e('set:gameDisplay/g', '', 9), e('play:g', 'p2', 1, { v: { time: 50, sessions: 3, last: 900 } }),
  ]);
  const w = Object.fromEntries(plan(a, b, {}).write.map((x) => [x.k, x.v]));
  assert.equal(w['set:defaultSpeed'], 2); // theirs is newer
  assert.equal('fav:g' in w, false); // ours is newer
  assert.equal(w['set:gameDisplay/g'], null); // reset to the default over there, later
  assert.deepEqual(w['play:g'], { time: 100, sessions: 3, last: 1000 });
});

test('ROMs move only when both devices share them', () => {
  const a = m('Mac', [], true);
  const b = m('iPhone', [e('rom:abc', 'abc', 1, { n: 1 << 20 })], true);
  assert.equal(plan(a, b, {}).pull[0].n, 1 << 20);
  assert.deepEqual(plan({ ...a, roms: false }, b, {}).pull, []);
  assert.deepEqual(plan(a, { ...b, roms: false }, {}).pull, []);
});

test('the agreed hashes after a sync', () => {
  const a = m('Mac', [e('sram:same', 's', 1), e('sram:mine', 'm1', 1), e('sram:c', 'ca', 1)]);
  const b = m('iPhone', [e('sram:same', 's', 1), e('sram:theirs', 't1', 1), e('sram:c', 'cb', 2)]);
  const p = plan(a, b, {});
  const theirs = plan(b, a, {}).pull;
  assert.deepEqual(agreed(a, b, p, theirs), { 'sram:same': 's', 'sram:theirs': 't1', 'sram:mine': 'm1', 'sram:c': 'cb' });
});

test('copy names and game keys', () => {
  assert.equal(copyName('Main', 'iPhone', Date.UTC(2026, 8, 27)), 'Main (iPhone, 27 Sep)');
  assert.ok(copyName('A very long save name that goes on and on', 'Mac', 0).length <= 40);
  assert.equal(gameOfKey('sram:abc~x1'), 'abc');
  assert.equal(gameOfKey('state:@tobu#slot-3'), '@tobu');
  assert.equal(gameOfKey('set:gameDisplay/abc'), 'abc');
  assert.equal(gameOfKey('set:defaultSpeed'), '');
});

test('a save kept without its ROM gets the same key as on the device that has the ROM, so it never rolls back', () => {
  const mac = gamesOf([{ id: 'quest', rom: { sha1: 'f00d' } }]);
  // The phone has no ROM for it: the save came from the Mac and is stored under the Mac's id.
  assert.equal(gamesOf([{ id: 'quest' }]).key('quest'), '@quest'); // without the alias: two keys for one save
  const phone = gamesOf([{ id: 'quest' }], { f00d: 'quest' });
  assert.equal(phone.key('quest'), mac.key('quest'));
  assert.equal(phone.id('f00d'), 'quest');
  // An alias never takes over a game this device has its own ROM for.
  assert.equal(gamesOf([{ id: 'mine', rom: { sha1: 'f00d' } }], { f00d: 'quest' }).id('f00d'), 'mine');
  // One key on both sides: after the Mac plays (h1 → h2), the phone takes h2 and the Mac takes nothing back.
  const k = `sram:${mac.key('quest')}`;
  const onMac = m('Mac', [e(k, 'h2', 30)]), onPhone = m('iPhone', [e(k, 'h1', 20)]);
  assert.deepEqual(plan(onPhone, onMac, { [k]: 'h1' }).pull.map((x) => x.k), [k]);
  assert.deepEqual(plan(onMac, onPhone, { [k]: 'h1' }).pull, []);
});

test('a ROM stored twice: each copy keeps a key of its own, whatever order the games are listed in', () => {
  const a = { id: 'x', rom: { sha1: 'f00d' } }, b = { id: 'x-2', rom: { sha1: 'f00d' } };
  for (const g of [gamesOf([a, b]), gamesOf([b, a])]) {
    assert.equal(g.key('x'), 'f00d');
    assert.equal(g.key('x-2'), '@x-2');
    assert.equal(g.id('f00d'), 'x');
    assert.equal(g.id('@x-2'), 'x-2');
  }
});

test('a deletion syncs: the tombstone newer than the item drops it on the other side, and it never comes back', () => {
  // The Mac deleted slot 2 and the save at t=500; the iPhone still has them, unchanged since.
  const base = { 'sram:g': 'h', 'state:g#slot-2': 's' };
  const mac = { ...m('Mac', []), gone: { 'sram:g': 500, 'state:g#slot-2': 500 } };
  const phone = m('iPhone', [e('sram:g', 'h', 100), e('state:g#slot-2', 's', 200)]);
  const onMac = plan(mac, phone, base), onPhone = plan(phone, mac, base);
  assert.deepEqual(onMac.pull, []); // not pulled back
  assert.deepEqual(onPhone.drop.sort(), ['sram:g', 'state:g#slot-2']); // dropped over there too
  assert.deepEqual(onPhone.gone, { 'sram:g': 500, 'state:g#slot-2': 500 }); // and remembered, for a third device
  assert.deepEqual(onMac.drop, []);
});

test('an item changed after the deletion wins over the tombstone', () => {
  const mac = { ...m('Mac', []), gone: { 'state:g#auto': 500 } };
  const phone = m('iPhone', [e('state:g#auto', 'new', 900)]); // played on the iPhone after the Mac deleted it
  assert.deepEqual(plan(mac, phone, {}).pull.map((x) => x.k), ['state:g#auto']);
  assert.deepEqual(plan(phone, mac, {}).drop, []);
  assert.deepEqual(plan(phone, mac, {}).gone, {});
});

test('a ROM tombstone drops the ROM only when both devices share ROMs', () => {
  const mac = { ...m('Mac', [], true), gone: { 'rom:abc': 500 } };
  const phone = m('iPhone', [e('rom:abc', 'abc', 100, { n: 1 << 20 })], true);
  assert.deepEqual(plan(mac, phone, {}).pull, []);
  assert.deepEqual(plan(phone, mac, {}).drop, ['rom:abc']);
  assert.deepEqual(plan({ ...phone, roms: false }, mac, {}).drop, []);
});

test('a peer on the old format (no tombstones) still syncs', () => {
  const a = m('Mac', [e('sram:g', 'h', 1)]), b = m('iPhone', []);
  assert.deepEqual(plan(b, a, {}).pull.map((x) => x.k), ['sram:g']);
  assert.deepEqual(plan(a, b, {}).drop, []);
});

test('old tombstones are forgotten once every paired device synced after them, or after a year', () => {
  const day = 86_400_000, now = 1000 * day;
  const gone = { recent: now - day, old: now - 100 * day, ancient: now - 400 * day };
  assert.deepEqual(Object.keys(gcGone(gone, now, [now - 50 * day])), ['recent']);
  assert.deepEqual(Object.keys(gcGone(gone, now, [now - 50 * day, now - 200 * day])), ['recent', 'old']);
});
