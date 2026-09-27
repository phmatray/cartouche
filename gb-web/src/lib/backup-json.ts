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

/**
 * Read a backup without holding it as one string (a big library's backup is past the longest string a browser allows):
 * the bytes are scanned in chunks; `head` is the JSON with `key`'s array left empty, and each item of that array is a
 * byte range of `file`, parsed only when read. JSON's structural characters are ASCII, never part of a UTF-8 sequence.
 * Throws SyntaxError when it isn't a JSON object.
 */
export async function splitJson(file: Blob, key: string, chunk = 8 << 20): Promise<{ head: unknown; items: [number, number][] }> {
  const parts: Blob[] = [];
  const items: [number, number][] = [];
  let depth = 0, inStr = false, esc = false, str = '', lastKey = '', inList = false, itemAt = -1, headAt = 0, started = false;
  for (let at = 0; at < file.size; at += chunk) {
    const b = new Uint8Array(await file.slice(at, at + chunk).arrayBuffer());
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true; // \
        else if (c === 0x22) { inStr = false; if (depth === 1) lastKey = str; continue; } // "
        else if (depth > 1) { // jump over the string's body (base64: megabytes) to its next " or \
          // The \ is looked for only up to that ": searching the rest of the chunk for every short string is quadratic.
          const q = b.indexOf(0x22, i + 1), end = q < 0 ? b.length : q, s = b.subarray(i + 1, end).indexOf(0x5c);
          i = (s < 0 ? end : i + 1 + s) - 1;
          continue;
        }
        if (depth === 1 && str.length <= key.length) str += String.fromCharCode(c);
        continue;
      }
      if (!started) {
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xef || c === 0xbb || c === 0xbf) continue; // whitespace, BOM
        if (c !== 0x7b) throw new SyntaxError('not a JSON object');
        started = true;
      }
      if (c === 0x22) { inStr = true; str = ''; } else if (c === 0x7b || c === 0x5b) { // { [
        if (depth === 1 && c === 0x5b && lastKey === key && !parts.length) { inList = true; parts.push(file.slice(headAt, at + i + 1)); }
        else if (inList && depth === 2) itemAt = at + i;
        depth++;
      } else if (c === 0x7d || c === 0x5d) { // } ]
        depth--;
        if (inList && depth === 2 && itemAt >= 0) { items.push([itemAt, at + i + 1]); itemAt = -1; }
        else if (inList && depth === 1) { inList = false; headAt = at + i; }
      }
    }
  }
  if (depth || inStr) throw new SyntaxError('Unexpected end of JSON'); // cut short: never parse the whole file as the head
  parts.push(file.slice(headAt));
  return { head: JSON.parse(await new Blob(parts).text()), items };
}
