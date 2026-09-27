// Touch controls: skins and the player's own layouts (pure data and geometry; the DOM side is in components/player).

export const SKINS = ['box', 'brick', 'pocket', 'color', 'clear'] as const;
export type Skin = (typeof SKINS)[number];
export const SHELLS = ['raspberry', 'plum', 'lime', 'sun', 'lagoon'] as const;
export type Shell = (typeof SHELLS)[number];

/** The pieces a layout places: the D-pad, the A/B pair, the Select/Start pair, and two optional hold buttons. */
export const PARTS = ['dpad', 'ab', 'ss', 'rew', 'ff'] as const;
export type Part = (typeof PARTS)[number];
/** Rewind and fast-forward are off until the player adds them. */
export const OPTIONAL: Part[] = ['rew', 'ff'];

/**
 * Where a part sits: its centre is `x` px from an anchor at `ax` of the zone's width (0 left edge, .5 middle, 1 right edge),
 * same for y. Anchoring to the nearest edge keeps a layout made on one phone in place on a taller or wider one.
 * `s` scales the part, `o` is its opacity.
 */
export interface Place { ax: number; x: number; ay: number; y: number; s: number; o: number }
export interface Layout { overlay: boolean; parts: Partial<Record<Part, Place>> }
export type Orient = 'portrait' | 'landscape';
export type Device = 'phone' | 'tablet';
export const layoutKey = (device: Device, orient: Orient) => `${device}-${orient}`;
/** Phones and tablets keep their own layouts (a tablet's short side is 600 px or more). */
export const deviceClass = (): Device => (Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone');

/** The smallest scale that keeps every button of a part at least 44 px (its smallest button's size at scale 1). */
export const MIN_SCALE: Record<Part, number> = { dpad: 44 / 52, ab: 44 / 72, ss: 1, rew: 1, ff: 1 };
export const MAX_SCALE = 1.6;
export const MIN_OPACITY = 0.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const anchorOf = (v: number, size: number) => (v < size / 3 ? 0 : v > (size * 2) / 3 ? 1 : 0.5);

/** A part's place from its centre (px, in the zone) and the zone's size. */
export function placeAt(part: Part, cx: number, cy: number, w: number, h: number, s = 1, o = 1): Place {
  const ax = anchorOf(cx, w), ay = anchorOf(cy, h);
  return { ax, x: Math.round(cx - ax * w), ay, y: Math.round(cy - ay * h), s: clamp(s, MIN_SCALE[part], MAX_SCALE), o: clamp(o, MIN_OPACITY, 1) };
}
/** A place's centre in a zone of that size. */
export const centreOf = (p: Place, w: number, h: number) => ({ x: p.ax * w + p.x, y: p.ay * h + p.y });

export interface Rect { left: number; top: number; right: number; bottom: number }
export const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Snap to an 8 px grid. */
export const snap = (v: number, on: boolean) => (on ? Math.round(v / 8) * 8 : v);

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : NaN);
const ANCHORS = [0, 0.5, 1];

/** A stored or imported layout, checked field by field (null when it isn't one). Unknown parts are dropped. */
export function cleanLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { overlay?: unknown; parts?: unknown };
  if (!r.parts || typeof r.parts !== 'object') return null;
  const parts: Layout['parts'] = {};
  for (const part of PARTS) {
    const p = (r.parts as Record<string, unknown>)[part] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') continue;
    const place = {
      ax: ANCHORS.includes(p.ax as number) ? (p.ax as number) : NaN,
      x: num(p.x, -4000, 4000),
      ay: ANCHORS.includes(p.ay as number) ? (p.ay as number) : NaN,
      y: num(p.y, -4000, 4000),
      s: num(p.s, MIN_SCALE[part], MAX_SCALE),
      o: num(p.o, MIN_OPACITY, 1),
    };
    // A part with any field missing or wrong is dropped, never guessed.
    if (!Object.values(place).some(Number.isNaN)) parts[part] = place;
  }
  // The pad and the buttons are never missing (a layout without them couldn't play), nor stacked on one another.
  const req = [parts.dpad, parts.ab, parts.ss];
  if (req.some((p) => !p)) return null;
  const spots = new Set(req.map((p) => `${p!.ax},${p!.x},${p!.ay},${p!.y}`));
  if (spots.size < req.length) return null;
  return { overlay: r.overlay === true, parts };
}

/** The .json file a skin and its layouts are exported to and imported from. */
export interface ControlsFile { skin: Skin; shell: Shell; layouts: Record<string, Layout> }
const APP = 'cartouche-controls';
const KEYS = (['phone', 'tablet'] as Device[]).flatMap((d) => (['portrait', 'landscape'] as Orient[]).map((o) => layoutKey(d, o)));

export const exportControls = (f: ControlsFile) => JSON.stringify({ app: APP, version: 1, ...f }, null, 1);

/** Parse an exported file; null when it isn't one. Anything unknown or out of range is dropped or clamped. */
export function importControls(text: string): ControlsFile | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const r = raw as Partial<ControlsFile> & { app?: unknown };
  if (!r || typeof r !== 'object' || r.app !== APP) return null;
  const layouts: Record<string, Layout> = {};
  for (const k of KEYS) {
    const l = cleanLayout((r.layouts as Record<string, unknown> | undefined)?.[k]);
    if (l) layouts[k] = l;
  }
  return {
    skin: SKINS.includes(r.skin as Skin) ? (r.skin as Skin) : 'box',
    shell: SHELLS.includes(r.shell as Shell) ? (r.shell as Shell) : 'raspberry',
    layouts,
  };
}
