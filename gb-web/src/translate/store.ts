/** Live translate: the player's choices (kept in this browser) and what the reader and translators are doing now. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectLang, LANGS, type Lang } from '../i18n/core.ts';

export { LANGS, type Lang };
/** 'auto': Chrome's on-device translator when it can, else Claude when a key is set, else the text as read. */
export type Provider = 'auto' | 'chrome' | 'claude' | 'none';
export type ChromeStatus = 'checking' | 'missing' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** A text box on screen and what became of it. Coordinates in Game Boy pixels (160 x 144). */
export interface LiveBox {
  x: number; y: number; w: number; h: number;
  /** The text as read, lines joined. */
  source: string;
  sourceLang: 'ja' | 'en';
  /** The bitmap keys of its characters ("Not text" teaches them all as not text). */
  keys: string[];
  state: 'translating' | 'done' | 'raw' | 'error';
  translation?: string;
  /** Who translated it: 'chrome', 'claude', or 'cache' (translated before). */
  by?: 'chrome' | 'claude' | 'cache';
  error?: string;
  /** Why it isn't translated yet (a model to download). */
  note?: string;
}

/** One recognised cell of the last text read, for the teaching chart: its ink bitmap, its reading and look-alikes. */
export interface SeenGlyph { key: string; char: string; alts?: string[] }

/** Where the key lives when it isn't remembered: this tab's session, gone when the browser or app closes. */
export const STORE_KEY = 'cartouche-translate', SESSION_KEY = 'cartouche-translate-key';
const session = {
  get: () => { try { return sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; } },
  set: (k: string) => { try { if (k) sessionStorage.setItem(SESSION_KEY, k); else sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } },
};

interface TranslateState {
  /** Games with live translate on, by id. */
  games: Record<string, boolean>;
  lang: Lang;
  provider: Provider;
  /**
   * The player's own Anthropic API key, sent only to api.anthropic.com. In sessionStorage unless
   * `rememberKey` (then localStorage, with the rest of these choices).
   */
  claudeKey: string;
  rememberKey: boolean;

  // Runtime (not persisted)
  boxes: LiveBox[];
  chrome: ChromeStatus;
  chromeProgress: number;
  /** Last error from Claude (bad key, no credit, offline), cleared by the next success. */
  claudeError: string;
  /** The reader failed (its glyph set didn't load, a read threw): translate can't work until reloaded. */
  readerError: string;
  seen: SeenGlyph[];
  /** Reading needs the glyph set and the worker: false until they are up. */
  ready: boolean;

  setOn: (gameId: string, on: boolean) => void;
  set: (p: Partial<Pick<TranslateState, 'lang' | 'provider' | 'claudeKey' | 'rememberKey'>>) => void;
}

export const useTranslate = create<TranslateState>()(
  persist(
    (set) => ({
      games: {}, lang: detectLang(), provider: 'auto', claudeKey: session.get(), rememberKey: false,
      boxes: [], chrome: 'checking', chromeProgress: 0, claudeError: '', readerError: '', seen: [], ready: false,
      setOn: (gameId, on) => set((s) => {
        const games = { ...s.games };
        if (on) games[gameId] = true; else delete games[gameId];
        return { games, ...(on ? {} : { boxes: [], seen: [] }) };
      }),
      set: (p) => {
        if (p.claudeKey !== undefined) session.set(p.claudeKey);
        set(p);
      },
    }),
    {
      name: STORE_KEY,
      partialize: (s) => ({ games: s.games, lang: s.lang, provider: s.provider, rememberKey: s.rememberKey, ...(s.rememberKey ? { claudeKey: s.claudeKey } : {}) }),
    },
  ),
);
