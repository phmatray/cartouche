import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeToSecret, deriveKeys, groupCode, open, pack, prove, randomBytes, rekey, seal, secretToCode, unpack, verify, CODE_PREFIX } from './crypto.ts';

const secret = () => randomBytes(32);

test('the pairing code carries the whole secret and catches typos', async () => {
  const s = secret();
  const code = await secretToCode(s);
  assert.equal(code.length, 54);
  assert.deepEqual(await codeToSecret(code), s);
  // As shown (groups), as scanned (prefix), typed in lower case with O for 0 and L for 1.
  assert.deepEqual(await codeToSecret(groupCode(code)), s);
  assert.deepEqual(await codeToSecret(CODE_PREFIX + code), s);
  assert.deepEqual(await codeToSecret(code.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')), s);
  const typo = code.slice(0, 20) + (code[20] === 'A' ? 'B' : 'A') + code.slice(21);
  assert.equal(await codeToSecret(typo), null);
  assert.equal(await codeToSecret(code.slice(1)), null);
  assert.equal(await codeToSecret('hello'), null);
});

test('keys are derived deterministically, and differ per secret', async () => {
  const s = secret();
  const [a, b, c] = await Promise.all([deriveKeys(s), deriveKeys(s), deriveKeys(secret())]);
  assert.equal(a.room, b.room);
  assert.match(a.room, /^[0-9a-f]{32}$/);
  assert.notEqual(a.room, c.room);
  assert.equal((await open(b, await seal(a, { t: 'x' })))?.t, 'x');
});

test('a sealed message opens only with the same keys, untampered', async () => {
  const k = await deriveKeys(secret());
  const body = new Uint8Array(300_000).map((_, i) => i * 7);
  const sealed = await seal(k, { t: 'chunk', k: 'sram:abc', off: 7, data: body });
  const m = await open(k, sealed);
  assert.equal(m?.t, 'chunk');
  assert.equal(m?.off, 7);
  assert.deepEqual(m?.data, body);
  // Every message gets its own IV.
  assert.notDeepEqual((await seal(k, { t: 'x' })).slice(1, 13), (await seal(k, { t: 'x' })).slice(1, 13));
  const flipped = sealed.slice(); flipped[40] ^= 1;
  assert.equal(await open(k, flipped), null);
  assert.equal(await open(await deriveKeys(secret()), sealed), null);
  assert.equal(await open(k, sealed.slice(0, 20)), null);
  assert.equal(await open(k, new Uint8Array(0)), null);
});

test('the challenge proves the secret, bound to both nonces and the device', async () => {
  const k = await deriveKeys(secret());
  const na = randomBytes(16), nb = randomBytes(16);
  // B answers A's nonce; A checks it against its own nonce.
  const pb = await prove(k, na, nb, 'dev-b');
  assert.equal(await verify(k, pb, na, nb, 'dev-b'), true);
  assert.equal(await verify(k, pb, na, nb, 'dev-c'), false); // claimed by another device
  assert.equal(await verify(k, pb, randomBytes(16), nb, 'dev-b'), false); // replayed to another challenge
  assert.equal(await verify(await deriveKeys(secret()), pb, na, nb, 'dev-b'), false); // wrong secret
});

test('both devices move to the same new secret after pairing', async () => {
  const s = secret(), na = randomBytes(16), nb = randomBytes(16);
  const a = await rekey(s, na, nb), b = await rekey(s, nb, na);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, s);
  assert.notDeepEqual(await rekey(s, na, randomBytes(16)), a);
});

test('pack keeps binary fields', () => {
  const v = { a: 1, s: 'é', bin: new Uint8Array([1, 2, 3]), nested: { more: new Uint8Array([9]) }, empty: new Uint8Array(0) };
  assert.deepEqual(unpack(pack(v)), v);
});
