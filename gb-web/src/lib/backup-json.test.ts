// node --test: a backup written one ROM at a time reads back like one written whole (the format before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, jsonBlob, splitJson } from './backup-json.ts';

test('streamed backup round-trips and matches the whole-file JSON', async () => {
  const rom = (id: string, n: number) => ({ id, title: id, genre: 'Puzzle', data: Uint8Array.from({ length: n }, (_, i) => i * 7) });
  const roms = [rom('a', 0x9000), rom('b', 3)];
  const head = { app: 'cartouche', version: 1, settings: { volume: 0.5 }, saves: [{ id: 's', sram: new Uint8Array([1, 2]) }], screenshots: [{ gameId: 'a', png: new Blob([new Uint8Array([9, 8])], { type: 'image/png' }) }] };
  const blob = await jsonBlob(head, { roms: (async function* () { yield* roms; })() });
  const text = await blob.text();
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(await encode({ ...head, roms })))); // old backups: same JSON
  const back = decode(JSON.parse(text)) as { roms: typeof roms; saves: { sram: Uint8Array }[]; screenshots: { png: Blob }[] };
  assert.deepEqual(back.roms, roms);
  assert.deepEqual(back.saves[0].sram, new Uint8Array([1, 2]));
  assert.deepEqual(new Uint8Array(await back.screenshots[0].png.arrayBuffer()), new Uint8Array([9, 8]));
  assert.deepEqual(JSON.parse(await (await jsonBlob({}, { roms: (async function* () {})() })).text()), { roms: [] });
});

test('splitJson reads the ROM list item by item, in any key order, across chunk boundaries', async () => {
  const rom = (id: string, title: string) => ({ id, title, genre: 'x', data: Uint8Array.from({ length: 300 }, (_, i) => i) });
  const roms = [rom('rom', 'つき "{[ roms ]}" \\'), rom('rom-2', 'b')];
  const head = { app: 'cartouche', note: '"roms":[', meta: [{ id: 'rom', roms: [1, 2] }], saves: [{ id: 'rom', sram: new Uint8Array([7]) }] };
  const streamed = await jsonBlob(head, { roms: (async function* () { yield* roms; })() });
  const whole = new Blob([JSON.stringify(await encode({ app: 'cartouche', roms, ...head }))]); // an older backup: roms first
  for (const file of [streamed, whole]) {
    for (const chunk of [1, 7, 1 << 20]) {
      const { head: h, items: { roms: items } } = await splitJson(file, ['roms'], chunk);
      assert.deepEqual(decode(h), { ...head, roms: [] });
      const back = await Promise.all(items.map(async ([s, e]) => decode(JSON.parse(await file.slice(s, e).text()))));
      assert.deepEqual(back, roms);
    }
  }
  await assert.rejects(splitJson(new Blob(['PK\x03\x04']), ['roms']), SyntaxError);
});

// Many short strings in one big chunk (no \ anywhere): each one's \ search must stop at its closing ", not run to the chunk end.
test('splitJson scans many short strings in linear time', async () => {
  const item = JSON.stringify({ id: 'x', title: 'short', genre: 'Puzzle', data: { $b64: 'QUJD' } });
  const file = new Blob([`{"app":"cartouche","roms":[${Array(10000).fill(item).join(',')}]}`]); // 0.8 MB, 90,000 strings
  const t0 = performance.now();
  const { items: { roms: items } } = await splitJson(file, ['roms']);
  assert.equal(items.length, 10000);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`); // quadratic: ~10 s
});

// Restore can't read a big backup whole (a string stops near 512 MB): the ROMs are read back one at a time.
test('a streamed backup reads back one item at a time, split anywhere', async () => {
  const rom = (id: string, n: number) => ({ id, title: `${id} "q" \\ {[`, genre: 'Puzzle', data: Uint8Array.from({ length: n }, (_, i) => i * 7) });
  const roms = [rom('a', 0x10000), rom('b', 3), rom('c', 0x9001)];
  const head = { app: 'cartouche', saves: [{ id: 's', sram: new Uint8Array([1, 2]), note: ',"roms":[' }] };
  const blob = await jsonBlob(head, { roms: (async function* () { yield* roms; })() });
  const read = async (file: Blob, chunk?: number) => {
    const { head: h, items: { roms: items } } = await splitJson(file, ['roms'], chunk);
    return { head: decode(h), roms: await Promise.all(items.map(async ([s, e]) => decode(JSON.parse(await file.slice(s, e).text())))) };
  };
  for (const chunk of [1, 4096, undefined]) assert.deepEqual(await read(blob, chunk), { head: { ...head, roms: [] }, roms }); // any chunk boundary
  // Written whole, before streaming (the ROMs before the saves): read the same way.
  const whole = new Blob([JSON.stringify(await encode({ app: 'cartouche', settings: {}, roms, saves: [] }))]);
  assert.deepEqual(await read(whole, 5), { head: { app: 'cartouche', settings: {}, roms: [], saves: [] }, roms });
  // Cut short (an interrupted download): not a backup.
  const text = await blob.text();
  for (const cut of [text.indexOf('"roms":[') + 20, text.length - 2]) await assert.rejects(splitJson(new Blob([text.slice(0, cut)]), ['roms'], 7), SyntaxError);
});

// A few thousand save states are past the longest string a browser allows (~512 MB): each list is written and read an
// item at a time, never as one string. Here strings are capped at 2,000 characters; the whole file is ~40,000.
test('streamed lists never become one string, and read back item by item', async () => {
  const state = (i: number) => ({ id: `g${i}-state`, data: new Uint8Array(900).fill(i), thumbnail: new Uint8Array([i]), timestamp: i });
  const states = Array.from({ length: 30 }, (_, i) => state(i));
  const shots = [{ gameId: 'g', png: new Blob([new Uint8Array([9])], { type: 'image/png' }), timestamp: 1 }];
  const head = { app: 'cartouche', version: 1, saves: [{ id: 's', sram: new Uint8Array([1]) }] };
  const stringify = JSON.stringify;
  JSON.stringify = ((...a: Parameters<typeof stringify>) => {
    const out = stringify(...a);
    if (out && out.length > 2000) throw new RangeError('Invalid string length');
    return out;
  }) as typeof stringify;
  let blob: Blob;
  try { blob = await jsonBlob(head, { states, screenshots: shots, roms: (async function* () {})() }); } finally { JSON.stringify = stringify; }
  assert.ok(blob.size > 30000);
  const whole = new Blob([JSON.stringify(await encode({ ...head, states, screenshots: shots, roms: [] }))]); // the format before
  for (const file of [blob, whole]) {
    const { head: h, items } = await splitJson(file, ['roms', 'states', 'screenshots'], 1000);
    assert.deepEqual(decode(h), { ...head, states: [], screenshots: [], roms: [] });
    const read = (at: [number, number][]) => Promise.all(at.map(async ([s, e]) => decode(JSON.parse(await file.slice(s, e).text()))));
    assert.deepEqual(await read(items.states), states);
    assert.equal(((await read(items.screenshots))[0] as { png: Blob }).png.size, 1);
    assert.deepEqual(items.roms, []);
  }
});
