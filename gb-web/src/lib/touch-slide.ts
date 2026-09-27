// Sliding a thumb across the touch controls: which pad buttons it holds, and what changes from one move to the next.

/**
 * The D-pad directions at (dx, dy) from its centre, on a pad `size` px wide: the arms take 60° each, the diagonals
 * between them 30° (so a thumb rolling from one arm to the next holds both on the way), nothing in the middle.
 */
export function dpadAt(dx: number, dy: number, size: number): string[] {
  if (Math.hypot(dx, dy) < size / 8) return [];
  const t = Math.tan(Math.PI / 6); // an axis counts once the thumb is more than 30° off the other one
  const out: string[] = [];
  if (Math.abs(dy) > t * Math.abs(dx)) out.push(dy < 0 ? 'Up' : 'Down');
  if (Math.abs(dx) > t * Math.abs(dy)) out.push(dx < 0 ? 'Left' : 'Right');
  return out;
}

/** Give pointer `id` the buttons `now` (none: it's gone) and say which buttons, across every pointer, go down and up. */
export function slide(held: Map<number, string[]>, id: number, now: string[]) {
  const before = new Set([...held.values()].flat());
  if (now.length) held.set(id, now); else held.delete(id);
  const after = new Set([...held.values()].flat());
  return { press: [...after].filter((b) => !before.has(b)), release: [...before].filter((b) => !after.has(b)) };
}
