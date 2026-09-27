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

/** A Blob's text, a chunk at a time (a reader loop: Safari's streams aren't async-iterable). */
async function* textChunks(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * The items of a JSON array of objects, one at a time, as their JSON text. `chunks` start right after the '['
 * and may split anywhere; it stops at the closing ']'. Only one item is held in memory at a time.
 */
export async function* arrayItems(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let depth = 0, inStr = false, esc = false, parts: string[] = [];
  const quoteOrSlash = /["\\]/g;
  for await (const c of chunks) {
    let start = 0;
    for (let i = 0; i < c.length; i++) {
      if (inStr) {
        if (esc) { esc = false; continue; }
        quoteOrSlash.lastIndex = i;
        const m = quoteOrSlash.exec(c); // jump over the string's body (base64: megabytes)
        if (!m) break;
        i = m.index;
        if (c[i] === '\\') esc = true; else inStr = false;
        continue;
      }
      const ch = c[i];
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') { if (depth++ === 0) start = i; }
      else if (ch === '}' || ch === ']') {
        if (depth === 0) return; // the array's own ']'
        if (--depth === 0) { parts.push(c.slice(start, i + 1)); yield parts.join(''); parts = []; }
      } else if (depth === 0 && ch !== ',' && ch.trim()) throw new SyntaxError('Expected an object');
    }
    if (depth > 0) parts.push(c.slice(start));
  }
  throw new SyntaxError('Unexpected end of JSON');
}

/**
 * Read a file written by jsonBlob(head, key, items) without holding it whole (a string can't pass ~512 MB):
 * the head is parsed and decoded; each call of items() parses the items again, one at a time (left encoded: decode() them).
 * `headKey`: a key only the head has. null: not that layout (an older file with `key` before the others): read it whole.
 */
export async function readStreamed(blob: Blob, key: string, headKey: string): Promise<{ head: Record<string, unknown>; items: () => AsyncGenerator<unknown> } | null> {
  const marker = `,${JSON.stringify(key)}:[`;
  const find = async () => {
    const it = textChunks(blob);
    let acc = '';
    for (let r = await it.next(); !r.done; r = await it.next()) {
      const from = Math.max(0, acc.length - marker.length);
      acc += r.value;
      const at = acc.indexOf(marker, from);
      if (at >= 0) return { before: acc.slice(0, at), after: acc.slice(at + marker.length), rest: it };
    }
    return null;
  };
  const found = await find();
  if (!found) return null;
  let head: unknown;
  try { head = JSON.parse(`${found.before}}`); } catch { return null; }
  if (!head || typeof head !== 'object' || !(headKey in head)) return null;
  const items = async function* () {
    const f = await find();
    if (!f) return;
    for await (const text of arrayItems((async function* () { yield f.after; yield* f.rest; })())) yield JSON.parse(text);
  };
  return { head: decode(head) as Record<string, unknown>, items };
}
