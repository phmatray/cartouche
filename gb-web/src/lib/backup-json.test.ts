// node --test: a backup written one ROM at a time reads back like one written whole (the format before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, jsonBlob, splitJson } from './backup-json.ts';

test('streamed backup round-trips and matches the whole-file JSON', async () => {
  const rom = (id: string, n: number) => ({ id, title: id, genre: 'Puzzle', data: Uint8Array.from({ length: n }, (_, i) => i * 7) });
  const roms = [rom('a', 0x9000), rom('b', 3)];
  const head = { app: 'cartouche', version: 1, settings: { volume: 0.5 }, saves: [{ id: 's', sram: new Uint8Array([1, 2]) }], screenshots: [{ gameId: 'a', png: new Blob([new Uint8Array([9, 8])], { type: 'image/png' }) }] };
  const blob = await jsonBlob(head, 'roms', (async function* () { yield* roms; })());
  const text = await blob.text();
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(await encode({ ...head, roms })))); // old backups: same JSON
  const back = decode(JSON.parse(text)) as { roms: typeof roms; saves: { sram: Uint8Array }[]; screenshots: { png: Blob }[] };
  assert.deepEqual(back.roms, roms);
  assert.deepEqual(back.saves[0].sram, new Uint8Array([1, 2]));
  assert.deepEqual(new Uint8Array(await back.screenshots[0].png.arrayBuffer()), new Uint8Array([9, 8]));
  assert.deepEqual(JSON.parse(await (await jsonBlob({}, 'roms', (async function* () {})())).text()), { roms: [] });
});

test('splitJson reads the ROM list item by item, in any key order, across chunk boundaries', async () => {
  const rom = (id: string, title: string) => ({ id, title, genre: 'x', data: Uint8Array.from({ length: 300 }, (_, i) => i) });
  const roms = [rom('rom', 'つき "{[ roms ]}" \\'), rom('rom-2', 'b')];
  const head = { app: 'cartouche', note: '"roms":[', meta: [{ id: 'rom', roms: [1, 2] }], saves: [{ id: 'rom', sram: new Uint8Array([7]) }] };
  const streamed = await jsonBlob(head, 'roms', (async function* () { yield* roms; })());
  const whole = new Blob([JSON.stringify(await encode({ app: 'cartouche', roms, ...head }))]); // an older backup: roms first
  for (const file of [streamed, whole]) {
    for (const chunk of [1, 7, 1 << 20]) {
      const { head: h, items } = await splitJson(file, 'roms', chunk);
      assert.deepEqual(decode(h), { ...head, roms: [] });
      const back = await Promise.all(items.map(async ([s, e]) => decode(JSON.parse(await file.slice(s, e).text()))));
      assert.deepEqual(back, roms);
    }
  }
  await assert.rejects(splitJson(new Blob(['PK\x03\x04']), 'roms'), SyntaxError);
});

// Restore can't read a big backup whole (a string stops near 512 MB): the ROMs are read back one at a time.
test('a streamed backup reads back one item at a time, split anywhere', async () => {
  const rom = (id: string, n: number) => ({ id, title: `${id} "q" \\ {[`, genre: 'Puzzle', data: Uint8Array.from({ length: n }, (_, i) => i * 7) });
  const roms = [rom('a', 0x10000), rom('b', 3), rom('c', 0x9001)];
  const head = { app: 'cartouche', saves: [{ id: 's', sram: new Uint8Array([1, 2]), note: ',"roms":[' }] };
  const blob = await jsonBlob(head, 'roms', (async function* () { yield* roms; })());
  const read = async (file: Blob, chunk?: number) => {
    const { head: h, items } = await splitJson(file, 'roms', chunk);
    return { head: decode(h), roms: await Promise.all(items.map(async ([s, e]) => decode(JSON.parse(await file.slice(s, e).text())))) };
  };
  for (const chunk of [1, 4096, undefined]) assert.deepEqual(await read(blob, chunk), { head: { ...head, roms: [] }, roms }); // any chunk boundary
  // Written whole, before streaming (the ROMs before the saves): read the same way.
  const whole = new Blob([JSON.stringify(await encode({ app: 'cartouche', settings: {}, roms, saves: [] }))]);
  assert.deepEqual(await read(whole, 5), { head: { app: 'cartouche', settings: {}, roms: [], saves: [] }, roms });
  // Cut short (an interrupted download): not a backup.
  const text = await blob.text();
  for (const cut of [text.indexOf('"roms":[') + 20, text.length - 2]) await assert.rejects(splitJson(new Blob([text.slice(0, cut)]), 'roms', 7), SyntaxError);
});
