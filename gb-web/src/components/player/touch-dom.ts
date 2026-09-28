// The touch controls' DOM side shared by the player and its (lazy) layout editor.
import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { overlaps, SHELLS, SKINS, type Rect } from '../../lib/touch-layout';

/** The touch controls' skin as chosen (or the default, whatever a backup brought in). */
export function useSkin() {
  const skin = useSettingsStore((s) => s.touchSkin);
  const shell = useSettingsStore((s) => s.touchShell);
  return { skin: SKINS.includes(skin) ? skin : 'box', shell: SHELLS.includes(shell) ? shell : 'raspberry' };
}

/** Whether a media query matches, kept up to date (a phone turned, a window resized). */
export function useMedia(q: string) {
  return useSyncExternalStore((cb) => {
    const m = matchMedia(q);
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  }, () => matchMedia(q).matches);
}

/**
 * iOS starts a selection, the magnifier or a double-tap zoom from a touch unless its touchstart is cancelled, which
 * React's (passive) touch listeners can't do. The pads run on pointer events, which still arrive.
 */
export function holdTouches(el: HTMLElement | null) {
  if (!el) return;
  const stop = (e: TouchEvent) => e.preventDefault();
  el.addEventListener('touchstart', stop, { passive: false });
  return () => el.removeEventListener('touchstart', stop);
}

export const rectOf = (el: Element | null): Rect | null => {
  const r = el?.getBoundingClientRect();
  return r && r.width ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
};
/** The controls' layer, its safe area, and what no part may cover: the screen (unless the layout plays over it) and the deck. */
export function geometry(zone: HTMLElement, overlay: boolean, extra: Element | null = null) {
  const z = zone.getBoundingClientRect();
  const cs = getComputedStyle(zone);
  const safe = { left: z.left + parseFloat(cs.paddingLeft), right: z.right - parseFloat(cs.paddingRight), top: z.top + parseFloat(cs.paddingTop), bottom: z.bottom - parseFloat(cs.paddingBottom) };
  const walls = [overlay ? null : rectOf(document.querySelector('.pl .screen')), rectOf(document.querySelector('.pl .deck')), rectOf(extra)]
    .filter((r): r is Rect => !!r && overlaps(r, z));
  return { z, safe, walls };
}
/** Whether a rect leaves the safe area (a pixel of slack for rounding). */
export const outside = (r: Rect, safe: Rect) => r.left < safe.left - 1 || r.top < safe.top - 1 || r.right > safe.right + 1 || r.bottom > safe.bottom + 1;
/** Whether r covers o by more than the pixel places are rounded to. */
export const hits = (r: Rect, o: Rect) => overlaps({ left: r.left + 1, top: r.top + 1, right: r.right - 1, bottom: r.bottom - 1 }, o);
/** Whether a drawn layout can't be played here: a part off the safe area, on the screen or the deck, or on another part. */
export function misfit(zone: HTMLElement, overlay: boolean) {
  const { safe, walls } = geometry(zone, overlay);
  const parts = [...zone.querySelectorAll('[data-part]')].map(rectOf).filter((r): r is Rect => !!r);
  return parts.some((r, i) => outside(r, safe) || walls.some((w) => hits(r, w)) || parts.some((o, j) => j !== i && hits(r, o)));
}
