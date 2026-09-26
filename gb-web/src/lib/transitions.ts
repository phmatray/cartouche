import type { createBrowserRouter } from 'react-router';
import { sampleInk } from './cover-art';

/**
 * Route changes as View Transitions: one box (the clicked cover) flies between pages, the game's ink
 * floods out of it onto the game page, and Play inserts it into the LCD. Every navigation goes through
 * here (router.navigate is wrapped, back/forward is replayed inside the transition), so links, buttons,
 * keyboard and search results all animate the same way. Only the source box and its destination ever
 * carry a view-transition-name, and only while a transition runs. Without the API: plain navigation.
 */

type Router = ReturnType<typeof createBrowserRouter>;
type Kind = 'open' | 'close' | 'play' | 'eject' | 'fade';
type Page = 'lib' | 'game' | 'player' | 'other';

const supported = typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const pageOf = (p: string): Page => (p === '/' ? 'lib' : /^\/game\/[^/]+\/play\/?$/.test(p) ? 'player' : /^\/game\/[^/]+\/?$/.test(p) ? 'game' : 'other');
const gameOf = (p: string) => decodeURIComponent(p.split('/')[2] ?? '');
function kindOf(from: string, to: string): Kind {
  const a = pageOf(from), b = pageOf(to);
  if (a === 'lib' && b === 'game') return 'open';
  if (a === 'game' && b === 'lib') return 'close';
  if ((a === 'lib' || a === 'game') && b === 'player') return 'play';
  if (a === 'player' && (b === 'lib' || b === 'game')) return 'eject';
  return 'fade';
}

// ---- which element flies ----

let pressed: { el: Element; t: number } | null = null;
const idx = () => (history.state as { idx?: number } | null)?.idx ?? 0;
/** Library entry (history index) → the box that was opened from it, to fly back into on return. */
const slots = new Map<number, { id: string; section: string }>();

const boxesOf = (id: string) => [...document.querySelectorAll<HTMLElement>(`.cv[data-game="${CSS.escape(id)}"]`)];
const inView = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };

/** The box of `id` the user just activated: in the pressed card or row, else in the open search, else the first on screen. */
function sourceBox(id: string) {
  const all = boxesOf(id);
  const near = pressed && performance.now() - pressed.t < 1500 ? pressed.el.closest('a,button,label,.item,.lrow,[role=option]') : null;
  return all.find((b) => near?.contains(b) || b.closest('.lrow')?.contains(near))
    ?? all.find((b) => b.closest('dialog[open]'))
    ?? all.find(inView) ?? null;
}
const heroBox = () => document.querySelector<HTMLElement>('.gp .hero .cv');
const screen = () => document.querySelector<HTMLElement>('.pl .screen .frame');
function slotBox(id: string) {
  const s = slots.get(idx());
  const all = boxesOf(id);
  // Its old slot, else where the game stands now (played, it moved up to Continue), even off screen.
  return (s?.id === id && all.find((b) => b.closest(`[aria-labelledby="${s.section}"]`))) || all.find(inView) || all[0] || null;
}

// ---- running a transition ----

let active: ViewTransition | null = null;
let activeTo = '';
const waiters: (() => void)[] = [];
/** Resolves once no route transition is running: heavy start-up work (audio) waits so the landing stays smooth. */
export const settled = (): Promise<unknown> => active?.finished.catch(() => {}) ?? Promise.resolve();
/** Called by the root route after every committed location: releases the transition's update callback. */
export function committed() { waiters.splice(0).forEach((f) => f()); }
// The page is frozen while it waits: never more than a second (a slow lazy chunk then lands without the flight).
const nextCommit = () => new Promise<void>((r) => { waiters.push(r); setTimeout(r, 1000); });
/** A newer navigation interrupts: the running transition jumps to its end and stops waiting for its page. */
function interrupt() { active?.skipTransition(); committed(); }

/** Focus a sensible landing point on the new page (the heading, the LCD, or the box we came back to). */
function land(to: string, back: HTMLElement | null) {
  const page = pageOf(to);
  const el = page === 'player' ? document.querySelector<HTMLElement>('.pl canvas.lcd')
    : page === 'lib' && back ? back.closest<HTMLElement>('a') ?? back.closest('.lrow')?.querySelector<HTMLElement>('a.t') ?? null
    : document.querySelector<HTMLElement>('main h1');
  if (!el) return;
  if (!el.matches('a,button')) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

function run(from: string, to: string, go: () => unknown): Promise<void> {
  const kind = kindOf(from, to);
  const id = gameOf(kind === 'open' || kind === 'play' ? to : from);
  if (!supported) {
    const done = nextCommit().then(() => land(to, kind === 'close' || kind === 'eject' ? slotBox(id) : null));
    go();
    return done;
  }
  interrupt();
  const html = document.documentElement;
  const still = reduced();
  const named = new Set<HTMLElement>();
  const name = (el: HTMLElement | null, n: string) => { if (el) { el.style.viewTransitionName = n; named.add(el); } };
  const clear = () => { named.forEach((el) => { el.style.viewTransitionName = ''; }); named.clear(); };

  // Old state: the box that leaves, and (going back to the shelf) the ink band that retracts.
  let src: HTMLElement | null = null;
  let band: DOMRect | null = null;
  if (!still) {
    if (kind === 'open' || kind === 'play') src = sourceBox(id);
    else if (kind === 'close') src = heroBox();
    else if (kind === 'eject') src = screen();
    name(src, 'box');
    if (kind === 'close') {
      const flood = document.querySelector<HTMLElement>('.gp > .flood');
      name(flood, 'flood');
      band = flood?.getBoundingClientRect() ?? null;
    }
  }
  if (src && pageOf(from) === 'lib') slots.set(idx(), { id, section: src.closest('[aria-labelledby]')?.getAttribute('aria-labelledby') ?? '' });
  const from_ = src?.getBoundingClientRect() ?? null;
  html.dataset.vt = still ? 'still' : kind;
  if (pageOf(from) !== 'player' && pageOf(to) !== 'player' && !still) html.dataset.vtShell = '';

  let dest: HTMLElement | null = null;
  const t = document.startViewTransition(async () => {
    clear();
    // The ink comes from the cover: sample it now (a few ms, never more than 80) so the page floods in its colour.
    const art = kind === 'open' ? src?.querySelector<HTMLImageElement>('img.in') : null;
    if (art) await Promise.race([sampleInk(art.src).catch(() => {}), new Promise((r) => setTimeout(r, 80))]);
    const done = nextCommit();
    go();
    await done;
    if (kind === 'open' || kind === 'eject' && pageOf(to) === 'game') dest = heroBox();
    else if (kind === 'play') dest = screen();
    else if (kind === 'close' || kind === 'eject') dest = slotBox(id);
    if (!still) {
      name(dest, 'box');
      // The ink spreads from (or shrinks into) the box: a circle centred on it, big enough to cover the band.
      const flood = kind === 'open' ? document.querySelector<HTMLElement>('.gp > .flood') : null;
      if (flood) { name(flood, 'flood'); band = flood.getBoundingClientRect(); }
      const at = kind === 'open' ? from_ : dest?.getBoundingClientRect();
      if (band) {
        const x = at ? at.left + at.width / 2 - band.left : band.width / 2, y = at ? at.top + at.height / 2 - band.top : band.height / 2;
        const r = Math.hypot(Math.max(x, band.width - x), Math.max(y, band.height - y));
        html.style.setProperty('--vt-x', `${x}px`);
        html.style.setProperty('--vt-y', `${y}px`);
        html.style.setProperty('--vt-r', `${r}px`);
      }
    }
    land(to, dest);
  });
  active = t;
  activeTo = to;
  t.ready.catch(() => {}); // skipped by the next navigation: nothing to report
  t.finished.catch(() => {}).finally(() => {
    clear();
    if (active !== t) return;
    active = null;
    activeTo = '';
    delete html.dataset.vt;
    delete html.dataset.vtShell;
  });
  return t.updateCallbackDone.catch(() => {});
}

// Back / forward: hold the router's own popstate handling until the old page is captured, then replay it.
// Registered at import, in the capture phase, so it runs before the router's listener.
let routed: Router | null = null;
/** A pathname without the /cartouche basename (the router's location keeps it). */
const strip = (r: Router, p: string) => (r.basename && r.basename !== '/' && p.startsWith(r.basename) ? p.slice(r.basename.length) : p) || '/';
const here = (r: Router) => strip(r, r.state.location.pathname);
let replaying = false;
window.addEventListener('popstate', (e) => {
  if (replaying || !routed) return;
  const from = here(routed), to = strip(routed, location.pathname);
  if (to === from) { interrupt(); return; }
  if (!supported) { run(from, to, () => {}); return; } // the router navigates as usual; focus lands after
  e.stopImmediatePropagation();
  run(from, to, () => {
    replaying = true;
    try { window.dispatchEvent(new PopStateEvent('popstate', { state: e.state })); } finally { replaying = false; }
  });
}, true);

/** Route every navigation of `router` through a view transition (and back/forward through the same, reversed). */
export function install(router: Router) {
  routed = router;
  const entries = new Map<number, string>([[idx(), here(router)]]);
  router.subscribe(() => entries.set(idx(), here(router)));
  document.addEventListener('click', (e) => { if (e.target instanceof Element) pressed = { el: e.target, t: performance.now() }; }, true);

  const navigate = router.navigate.bind(router);
  router.navigate = ((to: unknown, opts?: unknown) => {
    if (typeof to === 'number') return navigate(to as never, opts as never);
    const from = here(router);
    const path = typeof to === 'string' ? to.split(/[?#]/)[0] : (to as { pathname?: string }).pathname ?? from;
    if (!path.startsWith('/') || path === from) return navigate(to as never, opts as never);
    if (path === activeTo) return Promise.resolve(); // a double click: already on its way
    // "Back" links to the page we just came from are real back steps: scroll position and slot come back.
    const kind = kindOf(from, path);
    if ((kind === 'close' || kind === 'eject') && entries.get(idx() - 1) === path && !(opts as { replace?: boolean })?.replace) {
      history.back();
      return Promise.resolve();
    }
    return run(from, path, () => navigate(to as never, opts as never));
  }) as Router['navigate'];
}
