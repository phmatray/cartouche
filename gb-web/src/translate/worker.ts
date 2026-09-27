/// <reference lib="webworker" />
// Live translate's reader, off the main thread: a traced frame's meta in, the text boxes out.
// Matching a tile never seen before takes a few ms; the emulator never waits for it.
import glyphsUrl from './glyphs.bin?url';
import { parseGlyphs, readBoxes, screenRows, type Box, type Reader } from './ocr.ts';

export type ToReader =
  | { type: 'read'; meta: ArrayBuffer }
  /** Taught or confirmed characters (bitmap key -> char, '' = not text), replacing the learned set. */
  | { type: 'learned'; map: Record<string, string> };
export type FromReader = { type: 'ready' } | { type: 'boxes'; boxes: Box[]; ms: number } | { type: 'error'; message: string };

const post = (m: FromReader) => (self as DedicatedWorkerGlobalScope).postMessage(m);
let reader: Reader | null = null;
let learned = new Map<string, string>();

const loading = fetch(glyphsUrl)
  .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`glyphs: ${r.status}`))))
  .then((b) => { reader = { glyphs: parseGlyphs(new Uint8Array(b)), learned }; post({ type: 'ready' }); })
  .catch((e) => post({ type: 'error', message: String(e) }));

self.onmessage = async (e: MessageEvent<ToReader>) => {
  const m = e.data;
  if (m.type === 'learned') {
    learned = new Map(Object.entries(m.map));
    if (reader) reader.learned = learned;
    return;
  }
  await loading;
  if (!reader) return; // the glyph set failed to load: Live was told when it happened
  const t0 = performance.now();
  try {
    const boxes = readBoxes(screenRows(new Uint8Array(m.meta)), reader);
    post({ type: 'boxes', boxes, ms: performance.now() - t0 });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
