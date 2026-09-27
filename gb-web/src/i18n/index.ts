// The app's i18n: the language from Settings (else the browser's), kept on <html lang>, and the React side of ./core.
import { createElement, Fragment, useMemo, type ReactNode } from 'react';
import { create } from 'zustand';
import { useSettingsStore } from '../store/settingsStore';
import { detectLang, loadLang, setLang, translate, type Key, type Lang, type Vars } from './core';

export { ago, date, dur, getLang, headerSize, langName, LANG_NAMES, LANGS, list, num, pct, regionName, size, t, type Key, type Lang } from './core';

/** The language shown: switched once its dictionary is in (the chosen one, else the browser's). */
const useShown = create<{ lang: Lang }>(() => ({ lang: 'en' }));
const wanted = () => useSettingsStore.getState().language ?? detectLang();
async function apply() {
  const l = wanted();
  await loadLang(l);
  if (l !== wanted()) return; // switched again meanwhile
  setLang(l);
  document.documentElement.lang = l;
  useShown.setState({ lang: l });
}
/** Resolves once the first language is ready (main.tsx renders then; offline without it, English shows). */
export const ready = apply().catch(() => {});
useSettingsStore.subscribe((s, prev) => { if (s.language !== prev.language) apply().catch(() => {}); });

/** The active language (re-renders when it changes). */
export const useLang = () => useShown((s) => s.lang);

/** `t` for a component: a new function when the language changes, so the component (and its memos) follow it. */
export function useT() {
  const lang = useLang();
  return useMemo(() => (key: Key, vars?: Vars) => translate(lang, key, vars), [lang]);
}

/**
 * A translated string with markup: `<b>…</b>` (any tag named in `parts`) wraps its text with that part,
 * `{name}` is replaced by a node. rich('Press <b>F12</b>', { b: (s) => <b>{s}</b> }).
 */
export function rich(text: string, parts: Record<string, ReactNode | ((inner: string) => ReactNode)>): ReactNode {
  const out: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    const p = parts[m[1] ?? m[3]];
    out.push(text.slice(last, m.index), createElement(Fragment, { key: m.index }, typeof p === 'function' ? p(m[2] ?? '') : p ?? m[0]));
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}
