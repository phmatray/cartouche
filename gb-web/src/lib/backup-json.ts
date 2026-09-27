/**
 * The JSON of a .cartouche backup. Bytes are written as {"$b64": "..."}; Blobs (screenshots) as {"$blob": "...", "type": "image/png"}.
 */
function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export async function encode(v: unknown): Promise<unknown> {
  if (v instanceof Uint8Array) return { $b64: toB64(v) };
  if (v instanceof Blob) return { $blob: toB64(new Uint8Array(await v.arrayBuffer())), type: v.type };
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await encode(x)])));
  return v;
}
export function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$b64 === 'string') return fromB64(o.$b64);
    if (typeof o.$blob === 'string') return new Blob([fromB64(o.$blob) as BlobPart], { type: typeof o.type === 'string' ? o.type : 'image/png' });
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

/**
 * `head` with `key` added as an array whose items arrive one at a time: each is encoded and folded into the Blob
 * before the next is read, so a multi-GB list is never in memory at once. The JSON is the same as encoding it whole.
 */
export async function jsonBlob(head: object, key: string, items: AsyncIterable<unknown>): Promise<Blob> {
  const h = JSON.stringify(await encode(head));
  let out = new Blob([`${h.slice(0, -1)}${h === '{}' ? '' : ','}${JSON.stringify(key)}:[`]);
  let sep = '';
  for await (const x of items) {
    out = new Blob([out, sep, JSON.stringify(await encode(x))]);
    sep = ',';
  }
  return new Blob([out, ']}'], { type: 'application/json' });
}
