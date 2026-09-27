// node --test: a backup written one ROM at a time reads back like one written whole (the format before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrayItems, decode, encode, jsonBlob, readStreamed } from './backup-json.ts';

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

// Restore can't read a big backup whole (a string stops near 512 MB): the ROMs are read back one at a time.
test('a streamed backup reads back one item at a time, split anywhere', async () => {
  const rom = (id: string, n: number) => ({ id, title: `${id} "q" \\ {[`, genre: 'Puzzle', data: Uint8Array.from({ length: n }, (_, i) => i * 7) });
  const roms = [rom('a', 0x10000), rom('b', 3), rom('c', 0x9001)];
  const head = { app: 'cartouche', saves: [{ id: 's', sram: new Uint8Array([1, 2]), note: ',"roms":[' }] };
  const blob = await jsonBlob(head, 'roms', (async function* () { yield* roms; })());
  const r = await readStreamed(blob, 'roms', 'saves');
  assert.ok(r);
  assert.deepEqual(r.head, head);
  for (let pass = 0; pass < 2; pass++) {
    const back = [];
    for await (const x of r.items()) back.push(decode(x));
    assert.deepEqual(back, roms);
  }
  // Any chunk boundary: one character at a time.
  const text = await blob.text();
  const body = text.slice(text.lastIndexOf(',"roms":[') + 9);
  const items = [];
  for await (const x of arrayItems((async function* () { yield* body; })())) items.push(decode(JSON.parse(x)));
  assert.deepEqual(items, roms);
  // Written whole, before streaming (the ROMs before the saves): not this layout, read whole.
  assert.equal(await readStreamed(new Blob([JSON.stringify(await encode({ app: 'cartouche', settings: {}, roms, saves: [] }))]), 'roms', 'saves'), null);
  await assert.rejects(async () => { for await (const x of arrayItems((async function* () { yield '{"a":1},{"b":'; })())) void x; }, SyntaxError);
});
