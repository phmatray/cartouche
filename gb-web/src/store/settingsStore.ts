import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lang } from '../i18n/core';
import type { Layout, Shell, Skin } from '../lib/touch-layout';
import type { Startup } from '../lib/settings-clean';
import { DEFAULT_DISPLAY, normalizeDisplay, presetOf, sameFilters, type DisplayConfig, type Filters, type PresetName, type ScreenKind } from '../shaders/filters';

export type GameBoyButton = 'A' | 'B' | 'Select' | 'Start' | 'Right' | 'Left' | 'Up' | 'Down';

/**
 * What an original Game Boy (DMG-only) cartridge runs on: the original Game Boy, or the Game Boy Color
 * with its automatic colours ('gbc') or one of the 12 palettes a held button combination gives ('gbc1'…'gbc12').
 */
export type ConsoleChoice = 'dmg' | 'gbc' | `gbc${number}`;

/** A stored choice made safe ('dmg' for anything unknown), and the core's `palette` argument for it. */
export function consoleOf(v: unknown): ConsoleChoice {
  return v === 'dmg' || v === 'gbc' || (typeof v === 'string' && /^gbc([1-9]|1[0-2])$/.test(v)) ? (v as ConsoleChoice) : 'dmg';
}
export const paletteOf = (c: ConsoleChoice) => (c.length > 3 ? +c.slice(3) : 0);

/** The console a game runs on: its own choice, else the default. */
export const consoleFor = (s: Pick<SettingsValues, 'console' | 'gameConsole'>, gameId: string) => consoleOf(s.gameConsole?.[gameId] ?? s.console);

/**
 * A cartridge's Super Game Boy functions: 'dmg' an original Game Boy game (Super Game Boy on by default),
 * 'cgb' a Color game that also has them (off by default: it has its own colours), null none.
 */
export type SgbCart = 'dmg' | 'cgb' | null;
/** What the game is switched on with: the Super Game Boy when it has its switch on, else its console. */
export type Machine = ConsoleChoice | 'sgb';
export const sgbOn = (s: Pick<SettingsValues, 'gameSgb'>, gameId: string, cart: SgbCart) => !!cart && (s.gameSgb?.[gameId] ?? cart === 'dmg');
export const machineFor = (s: Pick<SettingsValues, 'console' | 'gameConsole' | 'gameSgb'>, gameId: string, cart: SgbCart): Machine =>
  sgbOn(s, gameId, cart) ? 'sgb' : consoleFor(s, gameId);

export type ScreenSize = 'fit' | '2' | '3' | '4';
export type TouchSize = 'S' | 'M' | 'L';

export interface ChannelMutes {
  pulse1: boolean;
  pulse2: boolean;
  wave: boolean;
  noise: boolean;
}
/** In the core's order: the index is the channel number passed to set_channel_muted. */
export const CHANNEL_KEYS: (keyof ChannelMutes)[] = ['pulse1', 'pulse2', 'wave', 'noise'];

export interface BoxArtAnswer { consent: boolean; at: number }

export interface SettingsState {
  // Controls
  keybindings: Record<GameBoyButton, string>;

  // Display
  /** Screen preset + filters every game starts with: one for original Game Boy games, one for Color games. */
  display: Record<ScreenKind, DisplayConfig>;
  /** "Use these settings for this game only", by game id. */
  gameDisplay: Record<string, DisplayConfig>;
  /** Player screen size: fit the stage, or a fixed integer scale. */
  screenSize: ScreenSize;
  /** Smooth motion: in-between frames on displays over 60 Hz (or on any display when forced). */
  smoothMotion: boolean;
  smoothMotionForce: boolean;

  // Audio
  masterVolume: number;
  channelMutes: ChannelMutes;

  // Emulation
  defaultSpeed: number;
  rewindBufferSeconds: number;
  autoSaveEnabled: boolean;
  autoSaveIntervalSeconds: number;
  /** The start-up animation and chime played when a game starts fresh (Start skips it), or 'off'. */
  startupAnimation: Startup;
  /** The console original Game Boy games run on, and a game’s own choice (by game id). */
  console: ConsoleChoice;
  gameConsole: Record<string, ConsoleChoice>;
  /** A game's "Super Game Boy borders and colours" switch (by game id; unset: see `sgbOn`). */
  gameSgb: Record<string, boolean>;
  /** Games switched to the Game Boy because their music plays on the SNES chip (by game id; see skipSilentResume). */
  snesMusic: Record<string, boolean>;
  /** Keep a resume point every time the player is left. */
  resumePoints: boolean;
  touchSize: TouchSize;
  /** On-screen controls: the skin, its shell colour (Color skin), and the player's own layouts by device and orientation. */
  touchSkin: Skin;
  touchShell: Shell;
  touchLayouts: Record<string, Layout>;
  haptics: boolean;
  /** The interface language; null: the browser's (see i18n). */
  language: Lang | null;
  /** Rumble cartridges: drive gamepad / phone motors, at `rumbleIntensity` %, and shake the screen if `rumbleShake`. */
  rumble: boolean;
  rumbleIntensity: number;
  rumbleShake: boolean;

  // Library
  /** Fetch box art from libretro-thumbnails (only for recognized ROMs the user added). When off, no request is ever made. */
  showBoxArt: boolean;
  /** The test cartridges (cpu_instrs, the acid2 screens) in the library and search. */
  showTests: boolean;
  /** The player's answer to "Show box art?" (null: never asked, the dialog shows on launch). */
  boxArtAnswer: BoxArtAnswer | null;

  // Actions
  updateKeybinding: (button: GameBoyButton, key: string) => void;
  /** Store a screen config: the game's own when it has one, else the default for its kind. */
  setDisplay: (kind: ScreenKind, gameId: string | undefined, cfg: DisplayConfig) => void;
  /** Give a game its own screen config, or (null) back to the default. */
  setGameDisplay: (gameId: string, cfg: DisplayConfig | null) => void;
  setScreenSize: (size: ScreenSize) => void;
  setMasterVolume: (vol: number) => void;
  toggleChannelMute: (channel: keyof ChannelMutes) => void;
  setDefaultSpeed: (speed: number) => void;
  setRewindBufferSeconds: (seconds: number) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  setAutoSaveIntervalSeconds: (seconds: number) => void;
  setShowBoxArt: (show: boolean) => void;
  /** Set any plain value (the newer switches use this instead of one setter each). */
  set: (patch: Partial<SettingsValues>) => void;
  resetKeybindings: () => void;
  resetToDefaults: () => void;
}

const DEFAULT_KEYBINDINGS: Record<GameBoyButton, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  A: 'z',
  B: 'x',
  Start: 'Enter',
  Select: 'Shift',
};

const DEFAULT_STATE = {
  keybindings: DEFAULT_KEYBINDINGS,
  display: DEFAULT_DISPLAY,
  gameDisplay: {} as Record<string, DisplayConfig>,
  screenSize: 'fit' as ScreenSize,
  smoothMotion: false,
  smoothMotionForce: false,
  masterVolume: 50,
  channelMutes: { pulse1: false, pulse2: false, wave: false, noise: false },
  defaultSpeed: 1,
  rewindBufferSeconds: 10,
  autoSaveEnabled: true,
  autoSaveIntervalSeconds: 60,
  startupAnimation: 'registration' as Startup,
  console: 'dmg' as ConsoleChoice,
  gameConsole: {} as Record<string, ConsoleChoice>,
  gameSgb: {} as Record<string, boolean>,
  snesMusic: {} as Record<string, boolean>,
  showTests: false,
  showBoxArt: false, // opt-in: box art is third-party content fetched from GitHub
  boxArtAnswer: null as BoxArtAnswer | null,
  resumePoints: true,
  touchSize: 'M' as TouchSize,
  touchSkin: 'box' as Skin,
  touchShell: 'raspberry' as Shell,
  touchLayouts: {} as Record<string, Layout>,
  haptics: true,
  language: null as Lang | null,
  rumble: true,
  rumbleIntensity: 80,
  rumbleShake: true,
};
export type SettingsValues = typeof DEFAULT_STATE;
/** Keys saved in a backup and in localStorage. */
export const SETTINGS_KEYS = Object.keys(DEFAULT_STATE) as (keyof SettingsValues)[];

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,

      updateKeybinding: (button, key) =>
        set((state) => ({
          keybindings: { ...state.keybindings, [button]: key },
        })),

      setDisplay: (kind, gameId, cfg) =>
        set((s) => (gameId !== undefined && s.gameDisplay?.[gameId]
          ? { gameDisplay: { ...s.gameDisplay, [gameId]: cfg } }
          : { display: { ...s.display, [kind]: cfg } })),
      setGameDisplay: (gameId, cfg) =>
        set((s) => {
          const gameDisplay = { ...s.gameDisplay };
          if (cfg) gameDisplay[gameId] = cfg; else delete gameDisplay[gameId];
          return { gameDisplay };
        }),
      setScreenSize: (screenSize) => set({ screenSize }),
      setMasterVolume: (vol) => set({ masterVolume: vol }),

      toggleChannelMute: (channel) =>
        set((state) => ({
          channelMutes: {
            ...state.channelMutes,
            [channel]: !state.channelMutes[channel],
          },
        })),

      setDefaultSpeed: (speed) => set({ defaultSpeed: speed }),
      setRewindBufferSeconds: (seconds) => set({ rewindBufferSeconds: seconds }),
      setAutoSaveEnabled: (enabled) => set({ autoSaveEnabled: enabled }),
      setAutoSaveIntervalSeconds: (seconds) => set({ autoSaveIntervalSeconds: seconds }),
      setShowBoxArt: (show) => set({ showBoxArt: show }),

      set: (patch) => set(patch),
      resetKeybindings: () => set({ keybindings: DEFAULT_KEYBINDINGS }),
      resetToDefaults: () => set(DEFAULT_STATE),
    }),
    {
      name: 'gb-settings',
      version: 5,
      migrate: (state, version) => {
        let s = state as SettingsValues;
        // v2: box art became opt-in; an earlier default of "on" was never the player's choice.
        if (version < 2) s = { ...s, showBoxArt: false };
        // v3: the "Show box art?" question. Box art still on means the player already turned it on themselves.
        if (version < 3) s = { ...s, boxArtAnswer: s.showBoxArt ? { consent: true, at: Date.now() } : null };
        // v4: the four screen styles became presets of the filter chain; Color games get their own default.
        if (version < 4) {
          const { shaderPreset, pixelGrid, ...rest } = s as SettingsValues & { shaderPreset?: string; pixelGrid?: boolean };
          s = { ...rest, display: displayFromV3(shaderPreset, pixelGrid), gameDisplay: {} };
        }
        // v5: Cartouche's own start-up animations replace the console logo that kept it off by default: on for everyone.
        if (version < 5) s = { ...s, startupAnimation: 'registration' };
        return s;
      },
      partialize: (state) => Object.fromEntries(SETTINGS_KEYS.map((k) => [k, state[k]])) as SettingsValues,
    }
  )
);

/** The v4 `display` for settings saved before v4 (a `shaderPreset` + `pixelGrid` pair): the store migration and old backups. */
export function displayFromV3(shaderPreset?: unknown, pixelGrid?: unknown): Record<ScreenKind, DisplayConfig> {
  const preset = presetOf(typeof shaderPreset === 'string' ? shaderPreset : undefined) ?? presetOf(DEFAULT_DISPLAY.dmg.preset)!;
  const filters = pixelGrid === false ? { ...preset.filters, grid: 0 } : preset.filters;
  // Color games were always drawn raw before: a player who had picked Clean keeps it for them too.
  const cgb = preset.name === 'clean' ? { preset: preset.name, filters: preset.filters } : DEFAULT_DISPLAY.cgb;
  return { dmg: { preset: preset.name, filters }, cgb };
}

/** The screen config a game uses (or the default for its kind with no game), plus the actions the controls need. */
export function useDisplay(kind: ScreenKind, gameId?: string) {
  const own = useSettingsStore((s) => (gameId !== undefined ? s.gameDisplay?.[gameId] ?? undefined : undefined));
  const base = useSettingsStore((s) => s.display?.[kind]);
  const raw = own ?? base;
  const setDisplay = useSettingsStore((s) => s.setDisplay);
  const setGameDisplay = useSettingsStore((s) => s.setGameDisplay);
  const cfg = useMemo(() => normalizeDisplay(raw, kind), [raw, kind]);
  const preset = presetOf(cfg.preset)!;
  return {
    cfg,
    custom: !sameFilters(cfg.filters, preset.filters),
    perGame: own !== undefined,
    choose: (name: PresetName) => setDisplay(kind, gameId, { preset: name, filters: presetOf(name)!.filters }),
    tweak: (patch: Partial<Filters>) => setDisplay(kind, gameId, { ...cfg, filters: { ...cfg.filters, ...patch } }),
    reset: () => setDisplay(kind, gameId, { ...cfg, filters: preset.filters }),
    setPerGame: (on: boolean) => { if (gameId !== undefined) setGameDisplay(gameId, on ? cfg : null); },
  };
}
