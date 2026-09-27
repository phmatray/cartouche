/**
 * Live translate over time: when a text box has finished printing (its text stopped changing), and what the
 * reader learns from a corrected original. Pure functions: unit-tested in session.test.ts.
 */
import { BG_CRAM_OFF, H, LINES_OFF, LINE_LEN, META_LEN, VRAM_OFF } from '../neural/trace.ts';
import { voice } from './ocr.ts';

export interface SettleState { text: string; since: number; done: string }
export const settleState = (): SettleState => ({ text: '', since: 0, done: '' });

/**
 * Feed the text on screen (all boxes, in reading order) at time `now`. Returns true once, when the text has
 * stayed the same for `hold` ms: typewriter printing and scrolling keep changing it, a box waiting for the
 * player doesn't. Text that disappears resets, so the same line shown again later settles again.
 */
export function settle(s: SettleState, text: string, now: number, hold = 350): boolean {
  if (text !== s.text) { s.text = text; s.since = now; if (!text) s.done = ''; return false; }
  if (!text || text === s.done || now - s.since < hold) return false;
  s.done = text;
  return true;
}

/**
 * What a corrected original teaches: read glyphs (reading order, one per cell) against the corrected text,
 * position by position, when both have the same number of characters (spaces aside). A voiced kana whose
 * mark sits on another tile is skipped (the tile only holds the base kana). Returns [bitmap key, char].
 */
export function corrections(glyphs: { key: string; char: string }[], corrected: string): [string, string][] {
  const want = [...corrected.replace(/\s/g, '')];
  if (want.length !== glyphs.length) return [];
  const out: [string, string][] = [];
  glyphs.forEach((g, i) => {
    const c = want[i];
    if (c === g.char || voice(g.char, '゛') === c || voice(g.char, '゜') === c) return;
    out.push([g.key, c]);
  });
  // Many differences means the lines don't line up (a rewrite, not a correction): learn nothing.
  return out.length * 3 > glyphs.length ? [] : out;
}

/** Corrections become learned after two agreeing sightings (a single guess from context can be wrong). */
export function confirm(pending: Map<string, { char: string; n: number }>, found: [string, string][]): [string, string][] {
  const ok: [string, string][] = [];
  for (const [key, char] of found) {
    const p = pending.get(key);
    const n = p?.char === char ? p.n + 1 : 1;
    pending.set(key, { char, n });
    if (n === 2) ok.push([key, char]);
  }
  return ok;
}

/**
 * Two metas show the same BG and window text when every scanline's registers, the BG palettes (a Game Boy
 * Color fade changes only those) and VRAM match: sprites, their palettes and the frame number don't count,
 * so a character walking about doesn't cost a read.
 */
export function sameText(a: Uint8Array, b: Uint8Array): boolean {
  for (let y = 0; y < H; y++) for (let i = LINES_OFF + y * LINE_LEN, e = i + 11; i < e; i++) if (a[i] !== b[i]) return false;
  for (let i = BG_CRAM_OFF; i < BG_CRAM_OFF + 64; i++) if (a[i] !== b[i]) return false;
  for (let i = VRAM_OFF; i < META_LEN; i++) if (a[i] !== b[i]) return false;
  return true;
}
