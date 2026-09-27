import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { centreOf, MAX_SCALE, MIN_OPACITY, MIN_SCALE, OPTIONAL, overlaps, PARTS, placeAt, snap, type Layout, type Part, type Rect } from '../../lib/touch-layout';
import { SwitchRow } from '../settings/parts';
import { geometry as zoneGeometry, hits, holdTouches, outside, rectOf } from './touch-dom';
import { toast } from '../shell/actions';
import { I } from '../icons';
import { pct, useT } from '../../i18n';

interface Props {
  /** The controls' layer (.tz): positions are relative to it. */
  zone: RefObject<HTMLDivElement | null>;
  layout: Layout | null;
  /** "Phone, upright"…: which of the saved layouts this is. */
  layoutName: string;
  onDraft: (l: Layout) => void;
  onCommit: (l: Layout) => void;
  onReset: () => void;
  onDone: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const box = (r: Rect): CSSProperties => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });
/** The rewind and fast-forward buttons' size before they're on screen (touch.css). */
const NEW_PART = 48;

interface Drag { part: Part; mode: 'move' | 'size'; pts: Map<number, { x: number; y: number }>; x0: number; y0: number; cx: number; cy: number; s0: number; d0: number; moved: boolean }

/**
 * Edit controls: drag a part to move it, pinch it or drag its corner to resize it, arrows and +/- from the keyboard.
 * Every part stays inside the safe area, off the screen (unless the layout plays over it), off the deck and off the others.
 */
export default function ControlsEditor({ zone, layout, layoutName, onDraft, onCommit, onReset, onDone }: Props) {
  const t = useT();
  const [sel, setSel] = useState<Part>('dpad');
  const [more, setMore] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [rects, setRects] = useState<{ parts: Partial<Record<Part, Rect>>; walls: Rect[]; hidden: boolean }>({ parts: {}, walls: [], hidden: false });
  const cur = useRef(layout);
  const drag = useRef<Drag | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [noRoom, setNoRoom] = useState(false);
  useEffect(() => { cur.current = layout; });

  /** The zone, its safe area, and what no part may cover (the editor's bar too). */
  const geometry = (overlay: boolean) => zoneGeometry(zone.current!, overlay, bar.current);
  const size = (part: Part) => {
    const el = zone.current?.querySelector<HTMLElement>(`[data-part="${part}"]`);
    return { w: el?.offsetWidth || NEW_PART, h: el?.offsetHeight || NEW_PART };
  };
  const rectFor = (part: Part, l: Layout, z: DOMRect): Rect | null => {
    const p = l.parts[part];
    if (!p) return null;
    const c = centreOf(p, z.width, z.height);
    const { w, h } = size(part);
    return { left: z.left + c.x - (w * p.s) / 2, right: z.left + c.x + (w * p.s) / 2, top: z.top + c.y - (h * p.s) / 2, bottom: z.top + c.y + (h * p.s) / 2 };
  };

  /** The layout with `part` centred at (cx, cy) (viewport px) and scaled by s, or null where it can't go. */
  const tryPlace = (l: Layout, part: Part, cx: number, cy: number, s: number): Layout | null => {
    const { z, safe, walls } = geometry(l.overlay);
    s = clamp(s, MIN_SCALE[part], MAX_SCALE);
    const { w: bw, h: bh } = size(part);
    const w = bw * s, h = bh * s;
    cx = clamp(z.left + snap(cx - z.left, snapOn), safe.left + w / 2, safe.right - w / 2);
    cy = clamp(z.top + snap(cy - z.top, snapOn), safe.top + h / 2, safe.bottom - h / 2);
    const r = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
    const others = PARTS.filter((p) => p !== part).map((p) => rectFor(p, l, z)).filter((x): x is Rect => !!x);
    if ([...walls, ...others].some((o) => overlaps(r, o))) return null;
    return { ...l, parts: { ...l.parts, [part]: placeAt(part, cx - z.left, cy - z.top, z.width, z.height, s, l.parts[part]?.o ?? 1) } };
  };
  /** The first free spot for a part, from the bottom middle outwards. */
  const freeSpot = (l: Layout, part: Part, s = 1): Layout | null => {
    const { safe } = geometry(l.overlay);
    const mid = (safe.left + safe.right) / 2;
    for (let y = safe.bottom - 40; y > safe.top + 24; y -= 16) {
      for (let dx = 0; dx < (safe.right - safe.left) / 2; dx += 16) {
        const next = tryPlace(l, part, mid + dx, y, s) ?? tryPlace(l, part, mid - dx, y, s);
        if (next) return next;
      }
    }
    return null;
  };
  const apply = (l: Layout) => { cur.current = l; onDraft(l); onCommit(l); };
  /**
   * Move every part that is off the safe area or covers something (after the screen grew, or a layout made on another
   * phone) to a free spot, smaller if need be. No room at all: back to the skin's layout, and say so.
   */
  const settle = () => {
    if (!cur.current || !zone.current) return;
    let l: Layout = cur.current;
    const { z, safe, walls } = geometry(l.overlay);
    let changed = false;
    for (const part of PARTS) {
      const r = rectFor(part, l, z);
      const others = PARTS.filter((p) => p !== part).map((p) => rectFor(p, l!, z)).filter((x): x is Rect => !!x);
      if (!r || (!outside(r, safe) && ![...walls, ...others].some((o) => hits(r, o)))) continue;
      const { [part]: gone, ...rest } = l.parts;
      const next = freeSpot({ ...l, parts: rest }, part, gone!.s) ?? freeSpot({ ...l, parts: rest }, part, MIN_SCALE[part]);
      if (!next) { onReset(); toast(t('player.edit.noFit'), 'm'); return; }
      l = { ...next, parts: { ...next.parts, [part]: { ...next.parts[part]!, o: gone!.o } } };
      changed = true;
    }
    if (changed) apply(l);
  };

  // Keyboard and screen readers: into the editor on open, nothing behind it reachable meanwhile, Escape is Done.
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  useEffect(() => {
    const f = requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.ced-p, .ced-bar .btn')?.focus({ preventScroll: true }));
    const behind = [...document.querySelectorAll<HTMLElement>('.pl > :not(.ced):not(.toasts)')];
    behind.forEach((el) => { el.inert = true; });
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done.current(); } };
    addEventListener('keydown', esc);
    return () => { cancelAnimationFrame(f); behind.forEach((el) => { el.inert = false; }); removeEventListener('keydown', esc); };
  }, []);

  // No layout of the player's own yet: start from the skin's, as drawn.
  useLayoutEffect(() => {
    if (layout || !zone.current) return;
    const top = document.querySelector('.pl-top')?.getBoundingClientRect().bottom ?? 0;
    const w = document.documentElement.clientWidth, h = innerHeight - top;
    const parts: Layout['parts'] = {};
    zone.current.querySelectorAll<HTMLElement>('[data-part]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const part = el.dataset.part as Part;
      if (r.width) parts[part] = placeAt(part, r.left + r.width / 2, r.top + r.height / 2 - top, w, h, parseFloat(getComputedStyle(el).zoom) || 1);
    });
    if (parts.dpad && parts.ab && parts.ss) onDraft({ overlay: false, parts });
  }, [layout, zone, onDraft]);

  // Where everything is, for the handles; again after a resize or a rotation.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    addEventListener('resize', again);
    return () => removeEventListener('resize', again);
  }, []);
  const settled = useRef(false);
  useLayoutEffect(() => {
    const el = zone.current;
    if (!el) return;
    const parts: Partial<Record<Part, Rect>> = {};
    el.querySelectorAll<HTMLElement>('[data-part]').forEach((p) => { const r = rectOf(p); if (r) parts[p.dataset.part as Part] = r; });
    const hidden = getComputedStyle(el.closest('.touch')!).display === 'none';
    setRects({ parts, walls: layout && !hidden ? geometry(layout.overlay).walls : [], hidden });
    // A layout made on a bigger phone may cover the screen here: fix it once, when the editor opens.
    if (layout && !settled.current && !hidden) { settled.current = true; settle(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry and settle read the DOM and the latest layout
  }, [layout, tick, zone]);

  // ---- pointer: move, corner resize, pinch ----
  const start = (part: Part, mode: Drag['mode']) => (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(part);
    const l = cur.current, r = rects.parts[part];
    if (!l || !r) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* keep going */ }
    const d = drag.current;
    if (d && d.part === part) { // a second finger: pinch
      d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...d.pts.values()];
      d.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      d.s0 = l.parts[part]!.s;
      return;
    }
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    root.current!.style.pointerEvents = 'auto'; // a second finger anywhere pinches the part held
    drag.current = { part, mode, pts: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]), x0: e.clientX, y0: e.clientY, cx, cy, s0: l.parts[part]!.s, d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, moved: false };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current, l = cur.current;
    if (!d || !l || !d.pts.has(e.pointerId)) return;
    d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = l.parts[d.part]!;
    const { z } = geometry(l.overlay);
    const c = centreOf(p, z.width, z.height);
    const cx = z.left + c.x, cy = z.top + c.y;
    let next: Layout | null;
    if (d.pts.size > 1) {
      const [a, b] = [...d.pts.values()];
      next = tryPlace(l, d.part, cx, cy, d.s0 * Math.hypot(a.x - b.x, a.y - b.y) / d.d0);
    } else if (d.mode === 'size') {
      next = tryPlace(l, d.part, cx, cy, d.s0 * Math.hypot(e.clientX - cx, e.clientY - cy) / d.d0);
    } else {
      const x = d.cx + e.clientX - d.x0, y = d.cy + e.clientY - d.y0;
      // blocked: slide along whatever is in the way
      next = tryPlace(l, d.part, x, y, p.s) ?? tryPlace(l, d.part, x, cy, p.s) ?? tryPlace(l, d.part, cx, y, p.s);
    }
    if (next) { d.moved = true; cur.current = next; onDraft(next); }
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    d.pts.delete(e.pointerId);
    if (d.pts.size) { // one finger of a pinch lifted: keep moving with the other
      const [pt] = [...d.pts.values()];
      const r = rects.parts[d.part];
      if (r) Object.assign(d, { x0: pt.x, y0: pt.y, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, s0: cur.current!.parts[d.part]!.s });
      return;
    }
    drag.current = null;
    root.current!.style.pointerEvents = '';
    if (d.moved && cur.current) onCommit(cur.current);
  };

  // ---- keyboard and toolbar ----
  const nudge = (part: Part, dx: number, dy: number, ds: number) => {
    const l = cur.current, r = rects.parts[part];
    if (!l || !r) return;
    const next = tryPlace(l, part, (r.left + r.right) / 2 + dx, (r.top + r.bottom) / 2 + dy, l.parts[part]!.s + ds);
    if (next) apply(next);
  };
  const key = (part: Part) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    const k: Record<string, [number, number, number]> = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, -step, 0], ArrowDown: [0, step, 0], '+': [0, 0, 0.1], '=': [0, 0, 0.1], '-': [0, 0, -0.1] };
    if (k[e.key]) { e.preventDefault(); nudge(part, ...k[e.key]); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && OPTIONAL.includes(part)) { e.preventDefault(); toggle(part); }
  };
  const toggle = (part: Part) => {
    const l = cur.current;
    if (!l) return;
    if (l.parts[part]) {
      const rest = { ...l.parts };
      delete rest[part];
      apply({ ...l, parts: rest });
      if (sel === part) setSel('dpad');
      return;
    }
    const next = freeSpot(l, part);
    if (next) { apply(next); setSel(part); } else setNoRoom(true);
  };
  const setOverlay = (on: boolean) => {
    const l = cur.current;
    if (!l) return;
    apply({ ...l, overlay: on });
    // Off: the screen shrinks back on the next frame; whatever now covers it moves.
    if (!on) requestAnimationFrame(() => requestAnimationFrame(settle));
  };

  const name = (p: Part) => t(`player.edit.parts.${p}`);
  const p = layout?.parts[sel];
  return (
    <div className="ced" ref={root} onPointerDown={(e) => { if (drag.current) start(drag.current.part, 'move')(e); }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {rects.walls.map((r, i) => <i key={i} className="ced-no" style={box(r)} />)}
      {PARTS.map((part) => {
        const r = rects.parts[part];
        return r && (
          <button key={part} type="button" className="ced-p" ref={holdTouches} aria-pressed={sel === part} style={box(r)}
            aria-label={t('player.edit.partLabel', { part: name(part) })}
            onFocus={() => setSel(part)} onKeyDown={key(part)} onPointerDown={start(part, 'move')}>
            {sel === part && <span className={`ced-h${r.right + 26 > document.documentElement.clientWidth ? ' l' : ''}`} aria-hidden="true" onPointerDown={start(part, 'size')} />}
          </button>
        );
      })}

      <div className="ced-bar" ref={bar} role="toolbar" aria-label={t('player.edit.title')}>
        <button type="button" className="btn y" onClick={onDone}>{I.check}{t('player.edit.done')}</button>
        {rects.hidden ? <p className="ced-msg">{t('player.edit.hidden')}</p> : p && (
          <>
            <span className="ced-name"><b>{name(sel)}</b><small>{layoutName}</small></span>
            <span className="ced-sz" role="group" aria-label={t('player.edit.size', { part: name(sel) })}>
              <button type="button" aria-label={t('player.edit.smaller')} disabled={p.s <= MIN_SCALE[sel] + 0.001} onClick={() => nudge(sel, 0, 0, -0.1)}>{I.minus}</button>
              <button type="button" aria-label={t('player.edit.bigger')} disabled={p.s >= MAX_SCALE - 0.001} onClick={() => nudge(sel, 0, 0, 0.1)}>{I.plus}</button>
            </span>
            <label className="ced-op">
              <span>{t('player.edit.opacity')}</span>
              <input type="range" min={MIN_OPACITY * 100} max={100} step={5} value={Math.round(p.o * 100)}
                aria-valuetext={pct(Math.round(p.o * 100))}
                onChange={(e) => { const l = cur.current!; apply({ ...l, parts: { ...l.parts, [sel]: { ...l.parts[sel]!, o: +e.target.value / 100 } } }); }} />
            </label>
          </>
        )}
        <button type="button" className="ced-more-btn" aria-expanded={more} aria-controls="ced-more" onClick={() => { setMore(!more); setNoRoom(false); }}>
          {more ? I.close : I.menu}<span className="sr">{t('player.edit.more')}</span>
        </button>
      </div>

      {more && layout && (
        <div className="ced-more paper" id="ced-more">
          <SwitchRow label={t('player.edit.rew')} sub={t('player.edit.rewSub')} on={!!layout.parts.rew} set={() => toggle('rew')} />
          <SwitchRow label={t('player.edit.ff')} sub={t('player.edit.ffSub')} on={!!layout.parts.ff} set={() => toggle('ff')} />
          {noRoom && <p className="ced-warn" role="alert">{t('player.edit.noRoom')}</p>}
          <SwitchRow label={t('player.edit.overlay')} sub={t('player.edit.overlaySub')} on={layout.overlay} set={setOverlay} />
          <SwitchRow label={t('player.edit.snap')} sub={t('player.edit.snapSub')} on={snapOn} set={setSnapOn} />
          <p><button type="button" className="btn line" onClick={() => { settled.current = false; onReset(); setMore(false); }}>{t('player.edit.reset', { layout: layoutName })}</button></p>
        </div>
      )}
    </div>
  );
}
