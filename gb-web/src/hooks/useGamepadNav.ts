import { useEffect } from 'react';
import { held, reader, type PadKey } from '../lib/pad';
import { spatialNext } from '../lib/ui';

/**
 * The player's hold on the pad: while its game runs (`game`), only the menu button reaches the app (`menu`: pause and
 * open the Manual, or resume); everywhere else the pad works the interface.
 */
export const padNav: { game: boolean; menu?: () => void } = { game: false };

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
const shown = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest('[inert],[aria-hidden=true]')
  && (el.checkVisibility?.({ visibilityProperty: true }) ?? true);

function act(k: PadKey) {
  if (k === 'menu') { padNav.menu?.(); return; }
  if (padNav.game) return;
  const dlg = document.querySelector<HTMLDialogElement>('dialog[open]');
  const cur = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  if (k === 'a') { cur?.click(); return; }
  if (k === 'b') {
    // As Escape does: a dialog closes (unless it handles its own cancel), else back one page.
    if (dlg) { if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close(); }
    else if (((history.state as { idx?: number } | null)?.idx ?? 0) > 0) history.back();
    return;
  }
  const pool = [...(dlg ?? document).querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
  const next = cur && pool.includes(cur) ? spatialNext(cur, k, pool) : pool[0];
  if (!next) return;
  next.focus({ focusVisible: true } as FocusOptions); // the ring shows, as for the keyboard
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** A gamepad in the menus (TV use): D-pad or left stick moves the focus on screen, A presses, B goes back. */
export function useGamepadNav() {
  useEffect(() => {
    if (!navigator.getGamepads) return;
    const read = reader();
    let raf = 0;
    const loop = () => {
      const gp = [...navigator.getGamepads()].find(Boolean);
      if (!gp) { raf = 0; return; } // until the next one connects
      for (const k of read(held(gp), performance.now())) act(k);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
    start();
    window.addEventListener('gamepadconnected', start);
    return () => { window.removeEventListener('gamepadconnected', start); cancelAnimationFrame(raf); };
  }, []);
}
