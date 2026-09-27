/**
 * Device sync crypto (threat model: docs/SYNC.md). Everything comes from one random 256-bit pairing secret,
 * through HKDF-SHA-256 (WebCrypto):
 *   - room: the rendezvous name on the public relays (reveals nothing about the secret),
 *   - enc:  AES-256-GCM key sealing every message, on top of WebRTC's own DTLS,
 *   - auth: HMAC-SHA-256 key for the challenge that proves the other device holds the secret.
 * After pairing, both devices move to a new secret derived from the old one and both challenge nonces, so the
 * QR code or typed code that was shown can't be reused by someone who saw it.
 * Pure (no DOM): runs in the browser and under Node's test runner.
 */
const te = new TextEncoder();
const td = new TextDecoder();
const SALT = te.encode('cartouche-sync/v1');
const VERSION = 1;
export const SECRET_BYTES = 32;

export interface Keys { room: string; enc: CryptoKey; auth: CryptoKey }

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

const hkdf = (info: string, s: Uint8Array = SALT) => ({ name: 'HKDF', hash: 'SHA-256', salt: buf(s), info: te.encode(info) });

export async function deriveKeys(secret: Uint8Array): Promise<Keys> {
  const ikm = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const room = hex(new Uint8Array(await crypto.subtle.deriveBits(hkdf('room'), ikm, 128)));
  const enc = await crypto.subtle.deriveKey(hkdf('enc'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const auth = await crypto.subtle.deriveKey(hkdf('auth'), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  return { room, enc, auth };
}

/** The secret both devices keep once paired: the shown one, mixed with both nonces of the pairing handshake (order-independent). */
export async function rekey(secret: Uint8Array, a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [lo, hi] = hex(a) < hex(b) ? [a, b] : [b, a];
  const ikm = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf('rekey', concat([lo, hi])), ikm, SECRET_BYTES * 8));
}

/* ---------- challenge ---------- */

const proofData = (room: string, challenge: Uint8Array, own: Uint8Array, device: string) =>
  concat([te.encode(`proof|${room}|${device}|`), challenge, own]);
/** Answer to the other device's `challenge` nonce: binds the room, our own nonce and our device id. */
export async function prove(keys: Keys, challenge: Uint8Array, own: Uint8Array, device: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', keys.auth, buf(proofData(keys.room, challenge, own, device))));
}
/** Checks their answer to our nonce (constant-time, by WebCrypto). */
export function verify(keys: Keys, proof: Uint8Array, ours: Uint8Array, theirs: Uint8Array, device: string): Promise<boolean> {
  return crypto.subtle.verify('HMAC', keys.auth, buf(proof), buf(proofData(keys.room, ours, theirs, device)));
}

/* ---------- messages: JSON with binary fields, sealed ---------- */

export type Msg = Record<string, unknown>;

/** A value with Uint8Array fields as bytes: [u32 header length][header JSON][the arrays, in order]. */
export function pack(value: unknown): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = te.encode(JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { $u: parts.push(v) - 1, n: v.length } : v)));
  const out = new Uint8Array(4 + head.length + parts.reduce((a, p) => a + p.length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function unpack<T = unknown>(bytes: Uint8Array): T {
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (n > bytes.length - 4) throw new Error('bad frame');
  let at = 4 + n;
  return JSON.parse(td.decode(bytes.subarray(4, 4 + n)), (_, v) => {
    if (v && typeof v === 'object' && typeof v.$u === 'number' && typeof v.n === 'number') {
      if (at + v.n > bytes.length) throw new Error('bad frame');
      const part = bytes.slice(at, at + v.n);
      at += v.n;
      return part;
    }
    return v;
  }) as T;
}

/** [version][12-byte random IV][AES-GCM ciphertext + tag]. The room name is authenticated data. */
export async function seal(keys: Keys, msg: Msg): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(keys.room) }, keys.enc, buf(pack(msg)));
  return concat([Uint8Array.of(VERSION), iv, new Uint8Array(ct)]);
}
/** The message, or null when it isn't one sealed with these keys (wrong secret, tampered, garbage). */
export async function open(keys: Keys, sealed: Uint8Array): Promise<Msg | null> {
  if (sealed.length < 29 || sealed[0] !== VERSION) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(1, 13), additionalData: te.encode(keys.room) }, keys.enc, buf(sealed.slice(13)));
    const m = unpack<Msg>(new Uint8Array(pt));
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  } catch { return null; }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** SHA-256 of bytes, as 32 hex characters (128 bits: plenty to tell two versions of a save apart). */
export async function digest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes)))).slice(0, 32);
}

/* ---------- the pairing code: the secret as something a person can type ---------- */

/** Crockford base32: no I, L, O, U. Typed O/I/L are read as 0/1/1. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PREFIX = 'CARTOUCHE-SYNC:';

/** 256 bits as 52 characters, plus 2 of checksum (a typo is caught before any network use): 54, shown in groups of 6. */
export async function secretToCode(secret: Uint8Array): Promise<string> {
  let bits = '';
  for (const b of secret) bits += b.toString(2).padStart(8, '0');
  const check = (await crypto.subtle.digest('SHA-256', buf(secret)));
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0') + Array.from(new Uint8Array(check).slice(0, 2), (b) => b.toString(2).padStart(8, '0')).join('').slice(0, 10);
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export const groupCode = (code: string) => code.match(/.{1,6}/g)!.join(' ');

/** What was scanned, typed or pasted, as the secret; null if it isn't a pairing code (or has a typo). */
export async function codeToSecret(input: string): Promise<Uint8Array | null> {
  const s = input.toUpperCase().replace(CODE_PREFIX, '').replace(/[\s\-·.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 54 || [...s].some((c) => !B32.includes(c))) return null;
  const bits = [...s].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  const secret = new Uint8Array(SECRET_BYTES);
  for (let i = 0; i < SECRET_BYTES; i++) secret[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return (await secretToCode(secret)) === s ? secret : null;
}
