// A gamepad in the menus (TV use): the keys a standard-mapping pad holds, and which of them act this frame.

export type PadKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'a' | 'b' | 'menu';
interface Pad { buttons: readonly { pressed: boolean }[]; axes: readonly number[] }

const DEAD = 0.5;
/** D-pad or left stick → arrows, A (0), B (1), and the menu: Home (16), or Select + Start (8, 9) together. */
export function held(gp: Pad): Set<PadKey> {
  const b = (i: number) => !!gp.buttons[i]?.pressed, x = gp.axes[0] ?? 0, y = gp.axes[1] ?? 0;
  const s = new Set<PadKey>();
  if (b(12) || y < -DEAD) s.add('ArrowUp');
  if (b(13) || y > DEAD) s.add('ArrowDown');
  if (b(14) || x < -DEAD) s.add('ArrowLeft');
  if (b(15) || x > DEAD) s.add('ArrowRight');
  if (b(0)) s.add('a');
  if (b(1)) s.add('b');
  if (b(16) || (b(8) && b(9))) s.add('menu');
  return s;
}

const DELAY = 400, EVERY = 120;
/** Keys that act now (`t` in ms): each new press, and a direction held down again after DELAY, then every EVERY. */
export function reader() {
  const next = new Map<PadKey, number>();
  return (now: Set<PadKey>, t: number): PadKey[] => {
    for (const k of next.keys()) if (!now.has(k)) next.delete(k);
    const out: PadKey[] = [];
    for (const k of now) {
      const at = next.get(k);
      if (at !== undefined && t < at) continue;
      out.push(k);
      next.set(k, !k.startsWith('Arrow') ? Infinity : at === undefined ? t + DELAY : t + EVERY);
    }
    return out;
  };
}

type Adjustable = Pick<HTMLElement, 'tagName' | 'dispatchEvent'> & Partial<Pick<HTMLInputElement, 'type' | 'value' | 'stepUp' | 'stepDown'>>
  & { selectedIndex?: number; options?: ArrayLike<{ disabled: boolean }> };
/**
 * A slider or dropdown under the focus takes the pad's value keys, as the keyboard's arrows would: left/right step a
 * slider, left/right (and A) cycle a dropdown's options. True when `k` was taken (the focus then stays put).
 */
export function adjust(el: Adjustable | null, k: PadKey): boolean {
  const dir = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0;
  if (!el) return false;
  if (el.tagName === 'INPUT' && el.type === 'range') {
    if (!dir) return false;
    const before = el.value;
    if (dir > 0) el.stepUp!(); else el.stepDown!();
    if (el.value === before) return true; // at an end
  } else if (el.tagName === 'SELECT' && el.options) {
    if (!dir && k !== 'a') return false;
    const n = el.options.length, step = dir || 1;
    let i = el.selectedIndex ?? -1;
    for (let tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      if (!el.options[i].disabled) break;
    }
    if (!n || i === el.selectedIndex) return true;
    el.selectedIndex = i;
  } else return false;
  // stepUp and selectedIndex bypass React's value tracking, so these reach its onChange.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
