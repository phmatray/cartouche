// Cheat codes as the player types and stores them. The core decodes and applies them (`set_cheats`);
// this only checks their shape, for an inline answer before the core sees them.

export interface Cheat { code: string; name: string; on: boolean }

/** A typed code, cleaned up: Game Genie `ABC-DEF[-GHI]` or GameShark `TTVVLLHH` (case, spaces, dashes don't matter). */
export function normalizeCode(s: string): { code: string; kind: 'genie' | 'shark' } | { error: 'format' | 'length' } {
  const d = s.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]*$/.test(d)) return { error: 'format' };
  if (d.length === 8) return { code: d, kind: 'shark' };
  if (d.length === 6 || d.length === 9) return { code: d.match(/.{3}/g)!.join('-'), kind: 'genie' };
  return { error: 'length' };
}

/** The codes switched on, one per line, for `set_cheats`. */
export const activeCodes = (list: readonly Cheat[]) => list.filter((c) => c.on).map((c) => c.code).join('\n');

/** A stored list from untrusted input (a backup, the other device), well-formed codes only; undefined if not a list. */
export function cleanCheats(v: unknown): Cheat[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((c): c is Cheat => !!c && typeof c === 'object' && typeof c.code === 'string' && typeof c.name === 'string' && typeof c.on === 'boolean')
    .map(({ code, name, on }) => ({ code, name, on }));
}
