/** The display filter chain: what LcdEngine draws and the Screen / Display controls edit. */
import { correctRgb555 } from './lcd-curves.ts';

export type PresetName = 'dmg-classic' | 'gb-pocket' | 'gb-light' | 'clean' | 'crt-tv' | 'gbc-accurate' | 'gba-sp' | 'neural';
export type PaletteId = 'original' | 'pea-soup' | 'pocket-grey' | 'backlit' | 'teal' | 'arctic' | 'sunset' | 'grey' | 'custom';
/** 'gbc' / 'gba': SameBoy's measured Game Boy Color / Game Boy Advance LCD response (lcd-curves.ts). */
export type Correction = 'off' | 'gbc' | 'gba';
/** 'lcd': the LCD's slow response, a fading trail. 'blend': an even mix with the previous frame, no trail (30 Hz flicker transparency). */
export type GhostMode = 'lcd' | 'blend';
/** 'neural': Neural 4x (neural/upscaler.ts), WebGL 2 only; nearest elsewhere. */
export type Upscale = 'nearest' | 'scale2x' | 'scale3x' | 'smooth' | 'neural';
/** Which default a game uses: original Game Boy games, or games the core runs in Color mode. */
export type ScreenKind = 'dmg' | 'cgb';

export interface Filters {
  /** DMG games only: four colours, lightest first. */
  palette: PaletteId;
  custom: string[];
  /** GBC games only. */
  correction: Correction;
  /** LCD persistence, 0 to 0.7: how much of the previous frame stays. */
  ghosting: number;
  ghostMode: GhostMode;
  upscale: Upscale;
  /** 0 to 1 each. */
  grid: number;
  scanlines: number;
  crt: boolean;
  /** -0.5 to 0.5 each, 0 is neutral. */
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface DisplayConfig { preset: PresetName; filters: Filters }

export const PALETTES: { id: PaletteId; label: string; colors: string[] }[] = [
  { id: 'original', label: 'Mint', colors: ['#e0f8d0', '#88c070', '#346856', '#081820'] },
  { id: 'pea-soup', label: 'Pea soup', colors: ['#c4cfa1', '#8b956d', '#4d533c', '#1f1f1f'] },
  { id: 'pocket-grey', label: 'Pocket grey', colors: ['#d9ded4', '#a6ada3', '#545952', '#000000'] },
  { id: 'backlit', label: 'Backlit green', colors: ['#cceab3', '#8cc773', '#337333', '#00260d'] },
  { id: 'teal', label: 'Backlit teal', colors: ['#b8f0e0', '#58c8b0', '#1f7a70', '#0a2a30'] },
  { id: 'arctic', label: 'Arctic', colors: ['#e8f4fc', '#8cbadc', '#3a6890', '#102038'] },
  { id: 'sunset', label: 'Sunset', colors: ['#ffe0a8', '#f09860', '#a04858', '#301838'] },
  { id: 'grey', label: 'Plain grey', colors: ['#ffffff', '#aaaaaa', '#555555', '#000000'] },
];

const NEUTRAL: Filters = {
  palette: 'original', custom: PALETTES[1].colors, correction: 'off', ghosting: 0, ghostMode: 'lcd', upscale: 'nearest',
  grid: 0, scanlines: 0, crt: false, brightness: 0, contrast: 0, saturation: 0,
};

/** `kinds`: the games a preset is offered for (palettes only exist on original Game Boy games). */
export interface PresetInfo { name: PresetName; label: string; description: string; kinds: ScreenKind[]; filters: Filters }

const DMG: ScreenKind[] = ['dmg'], BOTH: ScreenKind[] = ['dmg', 'cgb'];

export const PRESETS: PresetInfo[] = [
  { name: 'dmg-classic', label: 'DMG Classic', description: 'Original 1989 Game Boy', kinds: DMG,
    filters: { ...NEUTRAL, palette: 'pea-soup', correction: 'gbc', ghosting: 0.3, grid: 0.4 } },
  { name: 'gb-pocket', label: 'Pocket', description: 'Game Boy Pocket (1996)', kinds: DMG,
    filters: { ...NEUTRAL, palette: 'pocket-grey', correction: 'gbc', ghosting: 0.15, grid: 0.5 } },
  { name: 'gb-light', label: 'Light', description: 'Game Boy Light (1998)', kinds: DMG,
    filters: { ...NEUTRAL, palette: 'backlit', correction: 'gbc', ghosting: 0.15, grid: 0.5, brightness: 0.05 } },
  { name: 'gbc-accurate', label: 'GBC Accurate', description: 'Color LCD response', kinds: ['cgb'],
    filters: { ...NEUTRAL, correction: 'gbc', ghosting: 0.2, grid: 0.3 } },
  { name: 'gba-sp', label: 'GBA SP', description: 'Color games on a front-lit GBA SP', kinds: ['cgb'],
    filters: { ...NEUTRAL, correction: 'gba', ghosting: 0.1, grid: 0.2 } },
  { name: 'crt-tv', label: 'CRT TV', description: 'Scanlines on a curved tube', kinds: BOTH,
    filters: { ...NEUTRAL, correction: 'gbc', ghosting: 0.1, upscale: 'smooth', scanlines: 0.6, crt: true, brightness: 0.05, saturation: 0.1 } },
  { name: 'neural', label: 'Neural', description: 'Neural 4× upscaling', kinds: BOTH,
    filters: { ...NEUTRAL, upscale: 'neural', correction: 'gbc' } },
  { name: 'clean', label: 'Clean', description: 'No filter, raw pixels', kinds: BOTH, filters: NEUTRAL },
];

export const DEFAULT_DISPLAY: Record<ScreenKind, DisplayConfig> = {
  dmg: { preset: 'dmg-classic', filters: PRESETS[0].filters },
  cgb: { preset: 'gbc-accurate', filters: PRESETS[3].filters },
};

export const presetOf = (name: string | undefined) => PRESETS.find((p) => p.name === name);
export const presetsFor = (kind: ScreenKind) => PRESETS.filter((p) => p.kinds.includes(kind));

export const sameFilters = (a: Filters, b: Filters) =>
  (Object.keys(NEUTRAL) as (keyof Filters)[]).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T) => (all.includes(v as T) ? (v as T) : d);
const HEX = /^#[0-9a-f]{6}$/i;
/** Before SameBoy's curves: one matrix, at full or half strength. */
const LEGACY_CORRECTION: Record<string, Correction> = { accurate: 'gbc', vivid: 'gbc' };

/** Settings from storage or a backup, made safe to render (unknown values fall back to the preset's). */
export function normalizeDisplay(c: unknown, kind: ScreenKind): DisplayConfig {
  const cfg = (c && typeof c === 'object' ? c : {}) as Partial<DisplayConfig>;
  const preset = presetsFor(kind).find((p) => p.name === cfg.preset) ?? presetOf(DEFAULT_DISPLAY[kind].preset)!;
  const d = preset.filters;
  const f = (cfg.filters && typeof cfg.filters === 'object' ? cfg.filters : {}) as Partial<Filters>;
  const custom = Array.isArray(f.custom) && f.custom.length === 4 && f.custom.every((x) => HEX.test(x)) ? f.custom : d.custom;
  return {
    preset: preset.name,
    filters: {
      palette: oneOf(f.palette, [...PALETTES.map((p) => p.id), 'custom'], d.palette),
      custom,
      correction: oneOf(LEGACY_CORRECTION[f.correction as string] ?? f.correction, ['off', 'gbc', 'gba'] as const, d.correction),
      ghosting: clamp(f.ghosting, 0, 0.7, d.ghosting),
      ghostMode: oneOf(f.ghostMode, ['lcd', 'blend'] as const, d.ghostMode),
      upscale: oneOf(f.upscale, ['nearest', 'scale2x', 'scale3x', 'smooth', 'neural'] as const, d.upscale),
      grid: clamp(f.grid, 0, 1, d.grid),
      scanlines: clamp(f.scanlines, 0, 1, d.scanlines),
      crt: typeof f.crt === 'boolean' ? f.crt : d.crt,
      brightness: clamp(f.brightness, -0.5, 0.5, d.brightness),
      contrast: clamp(f.contrast, -0.5, 0.5, d.contrast),
      saturation: clamp(f.saturation, -0.5, 0.5, d.saturation),
    },
  };
}

/** The four palette colours as 0-1 RGB, lightest first. */
export function paletteRgb(f: Filters): number[][] {
  const hex = f.palette === 'custom' ? f.custom : (PALETTES.find((p) => p.id === f.palette) ?? PALETTES[0]).colors;
  return hex.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255));
}

/** 0 raw, 1 DMG palette, 2 colour correction; the Original palette on a DMG game is the core's own output. */
export function colorMode(f: Filters, color: boolean): number {
  if (color) return f.correction === 'off' ? 0 : 2;
  return f.palette === 'original' ? 0 : 1;
}

export const hasAdjustments = (f: Filters) => f.brightness !== 0 || f.contrast !== 0 || f.saturation !== 0;

/**
 * Canvas2D fallback: the colour pass of color.glsl on the CPU (palette or correction, then adjustments).
 * No ghosting or screen textures.
 */
export function cpuColor(src: Uint8ClampedArray, f: Filters, color: boolean): Uint8ClampedArray {
  const mode = colorMode(f, color);
  const adj = hasAdjustments(f);
  const out = new Uint8ClampedArray(src);
  if (mode === 0 && !adj) return out;
  const pal = paletteRgb(f);
  const cache = new Map<number, number>();
  const c = [0, 0, 0];
  for (let i = 0; i < out.length; i += 4) {
    const key = src[i] << 16 | src[i + 1] << 8 | src[i + 2];
    let v = cache.get(key);
    if (v === undefined) {
      c[0] = src[i] / 255; c[1] = src[i + 1] / 255; c[2] = src[i + 2] / 255;
      if (mode === 2) {
        // The core draws 5-bit colour as c5 * 255 / 31: recover c5, then the LCD's response.
        const lcd = correctRgb555(Math.round(c[0] * 31), Math.round(c[1] * 31), Math.round(c[2] * 31), f.correction === 'gba' ? 'gba' : 'gbc');
        for (let k = 0; k < 3; k++) c[k] = lcd[k] / 255;
      } else if (mode === 1) {
        const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        const p = pal[l > 0.79 ? 0 : l > 0.49 ? 1 : l > 0.21 ? 2 : 3];
        c[0] = p[0]; c[1] = p[1]; c[2] = p[2];
      }
      if (adj) {
        for (let k = 0; k < 3; k++) c[k] = (c[k] + f.brightness - 0.5) * (1 + f.contrast) + 0.5;
        const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * (1 + f.saturation);
      }
      v = c.reduce((acc, x) => acc * 256 + Math.min(255, Math.max(0, Math.round(x * 255))), 0);
      cache.set(key, v);
    }
    out[i] = v >> 16; out[i + 1] = v >> 8 & 255; out[i + 2] = v & 255;
  }
  return out;
}
