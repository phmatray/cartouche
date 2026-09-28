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
type Kind = 'open' | 'close' | 'play' | 'eject' | 'page' | 'fade';
type Page = 'lib' | 'game' | 'player' | 'other';

const supported = typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const pageOf = (p: string): Page => (p === '/' ? 'lib' : /^\/game\/[^/]+\/play\/?$/.test(p) ? 'player' : /^\/game\/[^/]+\/?$/.test(p) ? 'game' : 'other');
const gameOf = (p: string) => decodeURIComponent(p.split('/')[2] ?? '');
const inSettings = (p: string) => /^\/settings(\/|$)/.test(p);
function kindOf(from: string, to: string): Kind {
  if (inSettings(from) && inSettings(to)) return 'page';
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
/** The library hero's screen when it shows this game: already 10:9, it is the LCD's natural twin. */
const shotOf = (id: string) => document.querySelector<HTMLElement>(`.shot[data-game="${CSS.escape(id)}"] .frame`);
/**
 * Where the game lands back on the shelf: its old slot (brought into view if the page moved under it), else a box
 * of it already on screen, else nowhere: the box then fades out where it is rather than flying off screen.
 */
function slotBox(id: string) {
  const s = slots.get(idx());
  const all = boxesOf(id);
  const slot = s?.id === id ? all.find((b) => b.closest(`[aria-labelledby="${s.section}"]`)) : undefined;
  if (slot && !inView(slot)) slot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return slot ?? all.find(inView) ?? null;
}

/**
 * Which way the move goes, read off the links on screen: to a later page of the settings manual (or back), or to a
 * tab further right in the header (or left). Null when the two aren't neighbours in either list.
 */
function directionOf(kind: Kind, from: string, to: string): 'fwd' | 'back' | null {
  const paths = [...document.querySelectorAll<HTMLAnchorElement>(kind === 'page' ? '.toc a' : '.top .nav a')]
    .map((a) => (routed ? strip(routed, a.pathname) : a.pathname));
  const at = (p: string) => paths.findIndex((h) => (h === '/' ? p === '/' : p === h || p.startsWith(`${h}/`)));
  // Settings without a section is its first page.
  const norm = (p: string) => (kind === 'page' && !/^\/settings\/./.test(p) ? paths[0] ?? p : p);
  const a = at(norm(from)), b = at(norm(to));
  return a < 0 || b < 0 || a === b ? null : b > a ? 'fwd' : 'back';
}

// ---- running a transition ----

let active: ViewTransition | null = null;
let activeTo = '';
const waiters: (() => void)[] = [];
/** Resolves once no route transition is running: heavy start-up work (audio) waits so the landing stays smooth. */
export const settled = (): Promise<unknown> => active?.finished.catch(() => {}) ?? Promise.resolve();
/** Called by the root route after every committed location: releases the transition's update callback. */
export function committed() { waiters.splice(0).forEach((f) => f()); }
// The page is frozen while it waits: never long (a slow lazy chunk then lands without the flight).
const nextCommit = () => new Promise<void>((r) => { waiters.push(r); setTimeout(r, 400); });
/** A newer navigation interrupts: the running transition jumps to its end and stops waiting for its page. */
function interrupt() { active?.skipTransition(); committed(); }

/**
 * Focus a sensible landing point on the new page (the heading, the LCD, or the box we came back to). Focus that
 * survived inside the page (a settings section tab) stays where it is. A lazy page may draw a few frames late.
 */
function land(to: string, back: HTMLElement | null, had: Element | null, tries = 10) {
  if (had?.isConnected && had.closest('main') && document.activeElement === had) return;
  const page = pageOf(to);
  const el = page === 'player' ? document.querySelector<HTMLElement>('.pl .stage canvas.lcd')
    : (page === 'lib' && back ? back.closest<HTMLElement>('a') ?? back.closest('.lrow')?.querySelector<HTMLElement>('a.t') : null)
      ?? document.querySelector<HTMLElement>('main h1');
  if (!el) { if (tries) requestAnimationFrame(() => land(to, back, had, tries - 1)); return; }
  if (!el.matches('a,button')) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

/** `fade`: a plain cross-fade whatever the pages. `overlay`: the search is open on one side (the header can't hold still over it). */
function run(from: string, to: string, go: () => unknown, fade = false, overlay = fade): Promise<void> {
  const kind = fade ? 'fade' : kindOf(from, to);
  const id = gameOf(kind === 'open' || kind === 'play' ? to : from);
  const had = document.activeElement;
  if (!supported) {
    const done = nextCommit().then(() => land(to, kind === 'close' || kind === 'eject' ? slotBox(id) : null, had));
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
    if (kind === 'play' && pageOf(from) === 'lib') src = shotOf(id) ?? sourceBox(id);
    else if (kind === 'open' || kind === 'play') src = sourceBox(id);
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
  const dir = still || overlay ? null : directionOf(kind, from, to);
  if (dir && (kind === 'fade' || kind === 'page')) html.dataset.vtDir = dir;
  // The header holds still between shell pages, but not over the search overlay it would pop in front of.
  if (pageOf(from) !== 'player' && pageOf(to) !== 'player' && !still && !overlay && !src?.closest('dialog[open]')) html.dataset.vtShell = '';

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
    else if (kind === 'eject') dest = [shotOf(id)].find((s) => s && inView(s)) ?? slotBox(id);
    else if (kind === 'close') dest = slotBox(id);
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
    land(to, dest, had);
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
    delete html.dataset.vtDir;
    ['--vt-x', '--vt-y', '--vt-r'].forEach((p) => html.style.removeProperty(p));
  });
  return t.updateCallbackDone.catch(() => {});
}

// Back / forward: hold the router's own popstate handling until the old page is captured, then replay it.
// Registered at import, in the capture phase, so it runs before the router's listener.
let routed: Router | null = null;
/** A pathname without the /cartouche/ basename (the router's location keeps it). */
const strip = (r: Router, p: string) => { const b = r.basename?.replace(/\/$/, ''); return (b && p.startsWith(b) ? p.slice(b.length) : p) || '/'; };
/** A location with the search overlay open (`?q=`): opening it, or leaving it with Esc / back, cross-fades. */
const searching = (search = '') => new URLSearchParams(search).has('q');
const here = (r: Router) => strip(r, r.state.location.pathname);
let replaying = false;
window.addEventListener('popstate', (e) => {
  if (replaying || !routed) return;
  const from = here(routed), to = strip(routed, location.pathname);
  if (to === from) { interrupt(); return; }
  const fade = searching(routed.state.location.search), overlay = fade || searching(location.search);
  if (!supported) { run(from, to, () => {}, fade, overlay); return; } // the router navigates as usual; focus lands after
  e.stopImmediatePropagation();
  run(from, to, () => {
    replaying = true;
    try { window.dispatchEvent(new PopStateEvent('popstate', { state: e.state })); } finally { replaying = false; }
  }, fade, overlay);
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
    // A tag link into the search (/?q=…) opens it over the library: a cross-fade, never a back step.
    if (searching(typeof to === 'string' ? to.split('#')[0].split('?')[1] : (to as { search?: string }).search)) return run(from, path, () => navigate(to as never, opts as never), true);
    // "Back" links to the page we just came from are real back steps: scroll position and slot come back.
    const kind = kindOf(from, path);
    if ((kind === 'close' || kind === 'eject') && entries.get(idx() - 1) === path && !(opts as { replace?: boolean })?.replace) {
      history.back();
      return Promise.resolve();
    }
    return run(from, path, () => navigate(to as never, opts as never), false, searching(router.state.location.search));
  }) as Router['navigate'];
}
