/** Live translate: the player's choices (kept in this browser) and what the reader and translators are doing now. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'en' | 'fr' | 'es';
export const LANGS: [Lang, string][] = [['en', 'English'], ['fr', 'Français'], ['es', 'Español']];
/** 'auto': Chrome's on-device translator when it can, else Claude when a key is set, else the text as read. */
export type Provider = 'auto' | 'chrome' | 'claude' | 'none';
export type ChromeStatus = 'checking' | 'missing' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** A text box on screen and what became of it. Coordinates in Game Boy pixels (160 x 144). */
export interface LiveBox {
  x: number; y: number; w: number; h: number;
  /** The text as read, lines joined. */
  source: string;
  sourceLang: 'ja' | 'en';
  state: 'translating' | 'done' | 'raw' | 'error';
  translation?: string;
  /** Who translated it: 'chrome', 'claude', or 'cache' (translated before). */
  by?: string;
  error?: string;
  /** Why it isn't translated yet (a model downloading). */
  note?: string;
}

/** One recognised cell of the last text read, for the teaching chart: its ink bitmap and its reading. */
export interface SeenGlyph { key: string; char: string }

const guessLang = (): Lang => {
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2);
  return l === 'fr' || l === 'es' ? l : 'en';
};

interface TranslateState {
  /** Games with live translate on, by id. */
  games: Record<string, boolean>;
  lang: Lang;
  provider: Provider;
  /** The player's own Anthropic API key: stored in this browser only, sent only to api.anthropic.com. */
  claudeKey: string;

  // Runtime (not persisted)
  boxes: LiveBox[];
  chrome: ChromeStatus;
  chromeProgress: number;
  /** Last error from Claude (bad key, no credit, offline), cleared by the next success. */
  claudeError: string;
  seen: SeenGlyph[];
  /** Reading needs the glyph set and the worker: false until they are up. */
  ready: boolean;

  setOn: (gameId: string, on: boolean) => void;
  set: (p: Partial<Pick<TranslateState, 'lang' | 'provider' | 'claudeKey'>>) => void;
}

export const useTranslate = create<TranslateState>()(
  persist(
    (set) => ({
      games: {}, lang: guessLang(), provider: 'auto', claudeKey: '',
      boxes: [], chrome: 'checking', chromeProgress: 0, claudeError: '', seen: [], ready: false,
      setOn: (gameId, on) => set((s) => {
        const games = { ...s.games };
        if (on) games[gameId] = true; else delete games[gameId];
        return { games, ...(on ? {} : { boxes: [], seen: [] }) };
      }),
      set: (p) => set(p),
    }),
    {
      name: 'cartouche-translate',
      partialize: (s) => ({ games: s.games, lang: s.lang, provider: s.provider, claudeKey: s.claudeKey }),
    },
  ),
);
