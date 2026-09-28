// The Game Boy Color and Game Boy Advance LCD response, ported from SameBoy v1.0.3 Core/display.c
// (scale_channel_with_curve, scale_channel_with_curve_agb and GB_convert_rgb15 in its default
// GB_COLOR_CORRECTION_MODERN_BALANCED mode). SameBoy © 2015-2026 Lior Halphon, Expat (MIT) License;
// the notice is in THIRD_PARTY_NOTICES.md. Keep in step with color.glsl.

export type LcdModel = 'gbc' | 'gba';

/** 5-bit channel value to 8-bit, as a Game Boy Color LCD shows it. */
export const CURVE_CGB: readonly number[] = [0, 6, 12, 20, 28, 36, 45, 56, 66, 76, 88, 100, 113, 125, 137, 149, 161, 172, 182, 192, 202, 210, 218, 225, 232, 238, 243, 247, 250, 252, 254, 255];
/** The same on a Game Boy Advance LCD, much darker in the mid-tones. */
export const CURVE_AGB: readonly number[] = [0, 3, 8, 14, 20, 26, 33, 40, 47, 54, 62, 70, 78, 86, 94, 103, 112, 120, 129, 138, 147, 157, 166, 176, 185, 195, 205, 215, 225, 235, 245, 255];

/** How many parts green to one part blue make the displayed green (the LCD's green bleeds into blue). */
export const GREEN_WEIGHT: Record<LcdModel, number> = { gbc: 3, gba: 5 };
/** The gamma SameBoy mixes green and blue in for its balanced modes. */
export const MIX_GAMMA = 1.6;

/** A 5-bit RGB colour as that LCD shows it, 0-255 per channel: the curve, then the green/blue mix. */
export function correctRgb555(r5: number, g5: number, b5: number, mode: LcdModel): [number, number, number] {
  const curve = mode === 'gba' ? CURVE_AGB : CURVE_CGB;
  const r = curve[r5], g = curve[g5], b = curve[b5];
  if (g === b) return [r, g, b];
  const w = GREEN_WEIGHT[mode];
  const mixed = (((g / 255) ** MIX_GAMMA * w + (b / 255) ** MIX_GAMMA) / (w + 1)) ** (1 / MIX_GAMMA);
  return [r, Math.round(mixed * 255), b];
}
