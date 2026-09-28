import { create } from 'zustand';
import { promptInstall, useInstall } from '../../lib/pwa';

/** "Install the app" (menu, first-launch hero): the browser's own dialog, else the iPhone/iPad steps. */
/** The one-time iPhone/iPad install hint's "seen" key. */
export const HINT_SEEN = 'cartouche-ios-install-hint';
/** used: the sheet was opened once, so the one-time install hint steps aside for good. */
export const useInstallSheet = create<{ open: boolean; used: boolean }>(() => ({ open: false, used: false }));
export function startInstall() {
  if (useInstall.getState().can === 'prompt') promptInstall().catch(() => {});
  else {
    useInstallSheet.setState({ open: true, used: true });
    try { localStorage.setItem(HINT_SEEN, '1'); } catch { /* storage blocked */ }
  }
}

export type Tone = '' | 'm' | 'c';
export interface ToastAction { label: string; run: () => void }
export interface ToastItem { id: number; msg: string; tone: Tone; action?: ToastAction }
export const useToasts = create<{ list: ToastItem[] }>(() => ({ list: [] }));
let seq = 0;

export const dismissToast = (id: number) => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));

/** Show a short status message (bottom left). Tone: '' yellow, 'm' magenta, 'c' cyan. */
export function toast(msg: string, tone: Tone = '', action?: ToastAction) {
  const id = ++seq;
  useToasts.setState((s) => ({ list: [...s.list, { id, msg, tone, action }] }));
  // Held while the pointer or the focus is on it (its button stays reachable), then gone 4.2 s later.
  const later = () => setTimeout(() => (document.querySelector(`.toast[data-id="${id}"]:is(:hover,:focus-within)`) ? later() : dismissToast(id)), 4200);
  later();
}
