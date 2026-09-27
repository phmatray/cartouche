/**
 * The player's side of Live translate: whether this game has it on, which frames to sample, and where they go.
 * Everything heavy (reader worker, glyph set, providers) loads only when it is turned on.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useTranslate } from './store';
import { chromeStatus, chromeTranslator, hasChromeTranslator } from './chrome';
import type { Live } from './live';

/** Frames between two looks at the screen (6 a second): text boxes print far slower than that. */
const EVERY = 10;

let current: Live | null = null;
/** The running session, for the Manual's controls (teaching a character, a new language). */
export const liveSession = () => current;

export function useLiveTranslate(gameId: string, title: string) {
  const on = useTranslate((s) => !!s.games[gameId]);
  const count = useRef(0);
  useEffect(() => {
    if (!on) return;
    let dead = false, mine: Live | null = null;
    import('./live').then(({ Live }) => {
      if (dead) return;
      mine = current = new Live(gameId, title);
    }).catch((e) => console.warn('Live translate failed to load', e));
    return () => { dead = true; mine?.dispose(); if (current === mine) current = null; };
  }, [on, gameId, title]);
  // A new language, provider or key: translate what's on screen again.
  useEffect(() => useTranslate.subscribe((s, p) => {
    if (s.lang !== p.lang || s.provider !== p.provider || s.claudeKey !== p.claudeKey) current?.refresh();
  }), []);
  /** Call once per animation frame: true when this frame's trace should be read. */
  const want = useCallback(() => !!current && ++count.current % EVERY === 0, []);
  const feed = useCallback((meta: Uint8Array) => current?.feed(meta), []);
  return { on, want, feed };
}

/**
 * Turn Live translate on or off for a game. Call it from the click: Chrome only starts downloading its
 * translation model within a user gesture. Returns false, leaving it off, when nothing here can translate
 * (no built-in translator, no Claude key) and `anyway` isn't set: the text as read over the game's own would
 * only make the screen worse, so the caller explains what is needed instead.
 */
export function toggleTranslate(gameId: string, on: boolean, anyway = false): boolean {
  const s = useTranslate.getState();
  if (on && !anyway && s.provider !== 'none' && !hasChromeTranslator() && !s.claudeKey) return false;
  s.setOn(gameId, on);
  if (!on || s.provider === 'claude' || s.provider === 'none') return true;
  chromeStatus('ja', s.lang).then((st) => {
    useTranslate.setState({ chrome: st });
    if (st === 'downloadable' || st === 'downloading') {
      chromeTranslator('ja', s.lang, (p) => useTranslate.setState({ chrome: 'downloading', chromeProgress: p }))
        .then(() => useTranslate.setState({ chrome: 'available' }), () => useTranslate.setState({ chrome: 'downloadable' }));
    }
  });
  return true;
}
