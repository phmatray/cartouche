// The keyboard, the gamepad and the touch controls each hold buttons: the game sees one down while any of them holds it.

export type Source = 'key' | 'pad' | 'touch';
type Send = (button: number, player?: number) => void;

/** Wraps the core's press and release so each source lets go of only what it holds. */
export function combine(press: Send, release: Send) {
  const by = new Map<string, Set<Source>>(); // `${player}:${button}` -> the sources holding it
  const up = (src: Source, button: number, player = 0) => {
    const s = by.get(`${player}:${button}`);
    if (!s?.delete(src) || s.size) return;
    by.delete(`${player}:${button}`);
    release(button, player);
  };
  return {
    press(src: Source, button: number, player = 0) {
      const k = `${player}:${button}`, s = by.get(k) ?? new Set();
      if (s.has(src)) return;
      s.add(src); by.set(k, s);
      if (s.size === 1) press(button, player);
    },
    release: up,
    /** Let go of all `src` holds (the window lost focus: its key and touch releases never come). */
    clear(src: Source) {
      for (const [k, s] of [...by]) if (s.has(src)) { const [p, b] = k.split(':').map(Number); up(src, b, p); }
    },
  };
}
