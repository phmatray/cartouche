import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_DISPLAY, normalizeDisplay, presetOf, sameFilters, type DisplayConfig, type Filters, type PresetName, type ScreenKind } from '../shaders/filters';

export type GameBoyButton = 'A' | 'B' | 'Select' | 'Start' | 'Right' | 'Left' | 'Up' | 'Down';

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

  // Audio
  masterVolume: number;
  channelMutes: ChannelMutes;

  // Emulation
  defaultSpeed: number;
  rewindBufferSeconds: number;
  autoSaveEnabled: boolean;
  autoSaveIntervalSeconds: number;
  bootRomEnabled: boolean;
  /** Keep a resume point every time the player is left. */
  resumePoints: boolean;
  muteWhenHidden: boolean;
  touchSize: TouchSize;
  haptics: boolean;

  // Library
  /** Fetch box art from libretro-thumbnails (only for recognized ROMs the user added). When off, no request is ever made. */
  showBoxArt: boolean;
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
  setBootRomEnabled: (enabled: boolean) => void;
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
  masterVolume: 50,
  channelMutes: { pulse1: false, pulse2: false, wave: false, noise: false },
  defaultSpeed: 1,
  rewindBufferSeconds: 10,
  autoSaveEnabled: true,
  autoSaveIntervalSeconds: 60,
  bootRomEnabled: false,
  showBoxArt: false, // opt-in: box art is third-party content fetched from GitHub
  boxArtAnswer: null as BoxArtAnswer | null,
  resumePoints: true,
  muteWhenHidden: true,
  touchSize: 'M' as TouchSize,
  haptics: true,
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
      setBootRomEnabled: (enabled) => set({ bootRomEnabled: enabled }),
      setShowBoxArt: (show) => set({ showBoxArt: show }),

      set: (patch) => set(patch),
      resetKeybindings: () => set({ keybindings: DEFAULT_KEYBINDINGS }),
      resetToDefaults: () => set(DEFAULT_STATE),
    }),
    {
      name: 'gb-settings',
      version: 4,
      migrate: (state, version) => {
        let s = state as SettingsValues;
        // v2: box art became opt-in; an earlier default of "on" was never the player's choice.
        if (version < 2) s = { ...s, showBoxArt: false };
        // v3: the "Show box art?" question. Box art still on means the player already turned it on themselves.
        if (version < 3) s = { ...s, boxArtAnswer: s.showBoxArt ? { consent: true, at: Date.now() } : null };
        // v4: the four screen styles became presets of the filter chain; Color games get their own default.
        if (version < 4) {
          const { shaderPreset, pixelGrid, ...rest } = s as SettingsValues & { shaderPreset?: string; pixelGrid?: boolean };
          const preset = presetOf(shaderPreset) ?? presetOf(DEFAULT_DISPLAY.dmg.preset)!;
          const filters = pixelGrid === false ? { ...preset.filters, grid: 0 } : preset.filters;
          // Color games were always drawn raw before: a player who had picked Clean keeps it for them too.
          const cgb = preset.name === 'clean' ? { preset: preset.name, filters: preset.filters } : DEFAULT_DISPLAY.cgb;
          s = { ...rest, display: { dmg: { preset: preset.name, filters }, cgb }, gameDisplay: {} };
        }
        return s;
      },
      partialize: (state) => Object.fromEntries(SETTINGS_KEYS.map((k) => [k, state[k]])) as SettingsValues,
    }
  )
);

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
