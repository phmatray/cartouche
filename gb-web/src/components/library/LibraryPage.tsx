import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useGameLibrary, useSearchIndex } from '../../hooks/useGameLibrary';
import { formatQuery, search, type Filter as SearchFilter } from '../../lib/search';
import type { GameEntry } from '../../types/game';
import { letterOf, motion, owned, paths, playsNow, searchState, sortTitle, TEST_CATEGORY } from '../../lib/ui';
import { I } from '../icons';
import { ContinueHero, FirstHero } from './Heroes';
import { queueDownloads, useImports } from '../../lib/import-queue';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { Item, ListRow } from './GameItem';
import { size, t as tNow, useT, type Key } from '../../i18n';
import { useSettingsStore } from '../../store/settingsStore';

type Sort = 'name' | 'recent' | 'most' | 'year';
// Shortcuts into the search model (the same filters as `is:mine`, `region:us`… in the search overlay).
const FILTERS = {
  all: ['library.filter.all', []], mine: ['library.filter.mine', [{ key: 'is', value: 'mine' }]], now: ['common.tag.now', [{ key: 'is', value: 'now' }]],
  fav: ['library.filter.fav', [{ key: 'is', value: 'favorite' }]], US: ['US', [{ key: 'region', value: 'us' }]],
  EU: ['EU', [{ key: 'region', value: 'eu' }]], JP: ['JP', [{ key: 'region', value: 'jp' }]],
} satisfies Record<string, [Key | 'US' | 'EU' | 'JP', SearchFilter[]]>;
type Filter = keyof typeof FILTERS;
const SORTS: [Sort, Key][] = [['name', 'library.sort.name'], ['recent', 'library.sort.recent'], ['most', 'library.sort.most'], ['year', 'library.sort.year']];
const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const byName = (a: GameEntry, b: GameEntry) => sortTitle(a.title).localeCompare(sortTitle(b.title));
const COMPARE: Record<Sort, (a: GameEntry, b: GameEntry) => number> = {
  name: byName,
  recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b),
  most: (a, b) => (b.totalPlayTime || 0) - (a.totalPlayTime || 0) || byName(a, b),
  year: (a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999) || byName(a, b),
};

/**
 * State kept for the tab's session (first option by default), so coming back from a game finds the
 * shelf as it was left: same filter, sort and view, and the box back in its slot.
 */
function useKept<T extends string>(key: string, options: readonly T[]) {
  const [value, set] = useState<T>(() => {
    try { const v = sessionStorage.getItem(key) as T; return options.includes(v) ? v : options[0]; } catch { return options[0]; }
  });
  const keep = (v: T) => { set(v); try { sessionStorage.setItem(key, v); } catch { /* storage blocked: kept for this visit only */ } };
  return [value, keep] as const;
}

/** Arrow keys move focus between boxes (TV / gamepad-style spatial navigation). */
function useSpatialFocus() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = document.activeElement as HTMLElement | null;
      if (!cur?.classList.contains('item') || !e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey) return;
      const dir = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, number[]>)[e.key];
      if (!dir) return;
      e.preventDefault();
      const r0 = cur.getBoundingClientRect();
      // Sideways: stay in the same shelf row; up/down: any box on the page.
      const pool = [...(dir[1] ? document : cur.closest('.shelf') ?? document).querySelectorAll<HTMLElement>('.item')];
      let best: HTMLElement | null = null, bestDist = Infinity;
      for (const it of pool) {
        if (it === cur) continue;
        const r = it.getBoundingClientRect(), dx = r.left - r0.left, dy = r.top - r0.top;
        if (dir[0] && (Math.sign(dx) !== dir[0] || Math.abs(dy) > 20)) continue;
        if (dir[1] && (Math.sign(dy) !== dir[1] || Math.abs(dy) < 20)) continue;
        const dist = Math.abs(dx) + Math.abs(dy) * 2;
        if (dist < bestDist) { bestDist = dist; best = it; }
      }
      if (best) {
        best.focus({ preventScroll: true });
        best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: motion() });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function LibraryPage() {
  const { games, savedIds, loading, storageError, toggleFavorite } = useGameLibrary();
  const index = useSearchIndex();
  const showTests = useSettingsStore((s) => s.showTests);
  const [filter, setFilter] = useKept<Filter>('lib.filter', Object.keys(FILTERS) as Filter[]);
  const [sort, setSort] = useKept<Sort>('lib.sort', SORTS.map(([s]) => s));
  const [view, setView] = useKept('lib.view', ['grid', 'list'] as const);
  const [letter, setLetter] = useState<string | null>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useSpatialFocus();
  const t = useT();
  useEffect(() => { document.title = t('common.docTitle', { page: t('shell.nav.library') }); }, [t]);

  // While an import runs the hero keeps its game: following each new ROM would restart its live demo every flush.
  const importing = useImports((s) => s.rows.some((r) => r.st === 'work'));
  const [held, setHeld] = useState<string>();
  const { cont, shelf, free, tests, gbs, hasRoms } = useMemo(() => {
    const when = (g: GameEntry) => g.lastPlayed || g.importedAt || 0;
    const mine = games.filter((g) => owned(g) && when(g)).sort((a, b) => when(b) - when(a));
    const i = importing && held ? mine.findIndex((g) => g.id === held) : -1;
    if (i > 0) mine.unshift(...mine.splice(i, 1));
    return {
      cont: mine[0] as GameEntry | undefined,
      shelf: mine.slice(1),
      free: games.filter((g) => playsNow(g) && g !== mine[0] && g.category !== TEST_CATEGORY && !g.madeWith),
      // The GB Studio collection, best first; the ones that play here (hosted or already added) lead.
      gbs: games.filter((g) => g.madeWith === 'GB Studio').sort((a, b) => +owned(b) - +owned(a)),
      tests: showTests ? games.filter((g) => playsNow(g) && g.category === TEST_CATEGORY) : [],
      hasRoms: games.some((g) => g.isLocal),
    };
  }, [games, importing, held, showTests]);
  if (cont?.id !== held) setHeld(cont?.id);

  const list = useMemo(() => search(index, { text: '', filters: FILTERS[filter][1] }).sort(COMPARE[sort]), [index, filter, sort]);
  const present = useMemo(() => new Set(list.map(letterOf)), [list]);

  const pickFilter = (f: Filter, jump = false) => {
    setFilter(f);
    setLetter(null);
    if (jump) catalogRef.current?.scrollIntoView({ behavior: motion() });
  };
  const jumpTo = (l: string) => {
    setLetter(l);
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-letter="${l}"]`);
    if (!el) return;
    // Off-screen rows and boxes have estimated heights (content-visibility) until drawn, so a smooth scroll lands off
    // target: jump, then center again each frame until the rows around it have their real size.
    let last = NaN;
    const center = (n: number) => {
      el.scrollIntoView({ block: 'center' });
      const top = el.getBoundingClientRect().top;
      if (top !== last && n < 20) { last = top; requestAnimationFrame(() => center(n + 1)); }
    };
    center(0);
    el.classList.remove('hl');
    void el.offsetWidth; // restart the highlight animation
    el.classList.add('hl');
    setTimeout(() => (el.matches('a') ? el : el.querySelector<HTMLElement>('a.t'))?.focus({ preventScroll: true }), 400);
  };

  if (loading) return <main className="wrap loading" aria-busy="true">{t('common.loadingLibrary')}</main>;

  return (
    <main>
      {cont ? <ContinueHero game={cont} /> : <FirstHero bundled={free[0]} />}
      <div className="wrap">
        {storageError && <StorageNotice />}
        <section className="sec" aria-labelledby="h-shelf">
          <div className="sec-h">
            <h2 id="h-shelf">{t('library.shelf')}</h2>
            <span className="count">{shelf.length ? t(cont ? 'library.shelfMore' : 'library.shelfCount', { count: shelf.length }) : t('library.shelfEmpty')}</span>
            {hasRoms && <button className="linkbtn end" onClick={() => pickFilter('mine', true)}>{t('library.onlyMine')} {I.next}</button>}
          </div>
          {shelf.length ? (
            <div className="shelf rail">{shelf.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          ) : (
            <>
              <div className="slotrow">
                <Link to="/add">{I.plus}{t('shell.addRoms')}</Link>
                {Array.from({ length: 6 }, (_, i) => <span key={i} />)}
              </div>
              <p className="shelf-empty">{t('library.shelfHint')}{cont ? '' : ` ${t('shell.dropSub')}`}</p>
            </>
          )}
        </section>

        {free.length > 0 && (
          <section className="sec" aria-labelledby="h-free">
            <div className="sec-h"><h2 id="h-free">{t('library.free')}</h2><span className="count">{t('library.freeSub')}</span></div>
            <div className="shelf">{free.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          </section>
        )}

        {gbs.length > 0 && (
          <section className="sec" aria-labelledby="h-gbs">
            <div className="sec-h">
              <h2 id="h-gbs">{t('library.gbs.title')}</h2>
              <span className="count">{t('library.gbs.sub', { count: gbs.filter((g) => g.romUrl).length, games: t('common.games', { count: gbs.length }) })}</span>
              <Link className="linkbtn end" to={paths.search('made:gbstudio')} state={searchState()}>{t('library.gbs.all')} {I.next}</Link>
            </div>
            <div className="shelf rail">{gbs.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
            <DownloadAll games={gbs} />
          </section>
        )}

        {tests.length > 0 && (
          <section className="sec" aria-labelledby="h-tests">
            <div className="sec-h"><h2 id="h-tests">{t('library.tests')}</h2><span className="count">{t('library.testsSub')}</span></div>
            <div className="shelf">{tests.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          </section>
        )}

        <section className="sec" aria-labelledby="h-cat" id="catalog" ref={catalogRef}>
          <div className="sec-h">
            <h2 id="h-cat">{t('library.all')}</h2>
            <span className="count">{t('library.allSub', { games: t('common.games', { count: index.items.length }) })}</span>
          </div>
          <div className="tools">
            <div className="chips" role="group" aria-label={t('library.filterLabel')}>
              {(Object.keys(FILTERS) as Filter[]).map((v) => { const l = FILTERS[v][0]; return <button key={v} className="chip" aria-pressed={filter === v} onClick={() => pickFilter(v)}>{l.includes('.') ? t(l as Key) : l}</button>; })}
              <Link className="chip more" to={paths.search(formatQuery({ text: '', filters: FILTERS[filter][1] }))} state={searchState()}>{I.search}{t('library.moreFilters')}</Link>
            </div>
            <div className="right">
              <label className="sel">{t('library.sortLabel')}
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
                </select>
              </label>
              <div className="vt" role="group" aria-label={t('library.view')}>
                <button aria-pressed={view === 'grid'} aria-label={t('library.grid')} onClick={() => setView('grid')}>{I.grid}</button>
                <button aria-pressed={view === 'list'} aria-label={t('library.list')} onClick={() => setView('list')}>{I.list}</button>
              </div>
            </div>
          </div>
          {sort === 'name' && list.length > 0 && (
            <nav className="index" aria-label={t('library.jump')}>
              {LETTERS.map((l) => (
                <button key={l} disabled={!present.has(l)} aria-current={letter === l || undefined} aria-label={t('library.jumpTo', { letter: l })} onClick={() => jumpTo(l)}>{l}</button>
              ))}
            </nav>
          )}
          <div ref={bodyRef}>
            {!list.length ? (
              <div className="empty-inline" style={{ borderColor: '#3a3a3a', color: 'var(--mute)' }}>
                {t('library.noMatch')} <button className="linkbtn" onClick={() => pickFilter('all')}>{t('library.showAll')}</button>
              </div>
            ) : view === 'grid' ? (
              <div className="shelf cat">{list.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
            ) : (
              <>
                <div className="lhead"><span /><span>{t('library.col.title')}</span><span className="c">{t('library.col.played')}</span><span className="c">{t('library.col.last')}</span><span>{t('library.col.status')}</span><span /></div>
                <div className="list">{list.map((g) => <ListRow key={g.id} game={g} saved={savedIds} onFavorite={toggleFavorite} />)}</div>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Every hosted game not in the library yet, through the import queue (progress and Stop on the Add ROMs page).
 * Asks first, with the total size and a warning when the browser's storage estimate looks too small.
 */
function DownloadAll({ games }: { games: GameEntry[] }) {
  const left = games.filter((g) => g.romUrl && !g.isLocal);
  const total = left.reduce((n, g) => n + (g.size ?? 0), 0);
  const busy = useImports((s) => s.rows.some((r) => r.st === 'work'));
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const navigate = useNavigate();
  const t = useT();
  if (!games.some((g) => g.romUrl)) return null;
  const ask = async () => {
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    const room = est?.quota ? est.quota - (est.usage ?? 0) : Infinity;
    setConfirm({
      title: tNow('library.gbs.confirmTitle', { count: left.length }), ok: tNow('library.gbs.confirmOk'),
      body: `${tNow('library.gbs.confirmBody', { size: size(total) })}${room < total * 2 ? ` ${tNow('library.gbs.lowSpace', { free: size(room) })}` : ''}`,
      run: () => { queueDownloads(left); navigate('/add'); },
    });
  };
  return (
    <div className="gbs-all">
      {left.length ? (
        <button className="btn line" onClick={ask} disabled={busy}>{I.load}{t('library.gbs.download', { count: left.length, size: size(total) })}</button>
      ) : <span>{I.check}{t('library.gbs.downloaded')}</span>}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** Shown when the browser blocks IndexedDB: nothing can be kept, but the bundled games still play. */
export function StorageNotice() {
  const t = useT();
  return (
    <div className="notice" role="status" style={{ marginTop: 24 }}>
      <span className="ic">i</span>
      <span>{t('library.storageBlocked')}</span>
    </div>
  );
}
