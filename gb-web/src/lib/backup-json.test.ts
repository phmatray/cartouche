// node --test: a backup written one ROM at a time reads back like one written whole (the format before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, jsonBlob } from './backup-json.ts';

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
