// A game's flood ink: a saturated hue, dark enough that the white text on it passes WCAG AA.

/** Contrast of white text on hsl(h s% l%). */
export function whiteContrast(h: number, s: number, l: number): number {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
  return 1.05 / (y + 0.05);
}

/** The ink for a hue: 62% saturation at 32% lightness, darker for the bright hues (yellows, greens, cyans). */
export function inkFor(h: number): string {
  let l = 32;
  while (l > 12 && whiteContrast(h, 62, l) < 4.6) l--;
  return `hsl(${h} 62% ${l}%)`;
}
