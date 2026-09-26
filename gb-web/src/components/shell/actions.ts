import { create } from 'zustand';

/** Files waiting for the Add ROMs page (dropped anywhere in the app, or chosen there). */
export const usePendingImport = create<{ files: File[] }>(() => ({ files: [] }));
export const queueImport = (files: File[]) => { if (files.length) usePendingImport.setState((s) => ({ files: [...s.files, ...files] })); };

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
