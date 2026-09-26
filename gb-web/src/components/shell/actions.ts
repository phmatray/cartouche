import { create } from 'zustand';
import { promptInstall, useInstall } from '../../lib/pwa';

/** "Install the app" (menu, first-launch hero): the browser's own dialog, else the iPhone/iPad steps. */
export const useInstallSheet = create<{ open: boolean }>(() => ({ open: false }));
export function startInstall() {
  if (useInstall.getState().can === 'prompt') promptInstall().catch(() => {});
  else useInstallSheet.setState({ open: true });
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
  setTimeout(() => dismissToast(id), 4200);
}
