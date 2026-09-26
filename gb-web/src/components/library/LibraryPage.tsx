import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useGameLibrary, useSearchIndex } from '../../hooks/useGameLibrary';
import { formatQuery, search, type Filter as SearchFilter } from '../../lib/search';
import type { GameEntry } from '../../types/game';
import { letterOf, motion, owned, paths, playsNow, searchState, sortTitle, TEST_CATEGORY } from '../../lib/ui';
import { I } from '../icons';
import { ContinueHero, FirstHero } from './Heroes';
import { Item, ListRow } from './GameItem';

type Sort = 'name' | 'recent' | 'most' | 'year';
// Shortcuts into the search model (the same filters as `is:mine`, `region:us`… in the search overlay).
const FILTERS = {
  all: ['All', []], mine: ['In my library', [{ key: 'is', value: 'mine' }]], now: ['Play now', [{ key: 'is', value: 'now' }]],
  fav: ['Favorites', [{ key: 'is', value: 'favorite' }]], US: ['US', [{ key: 'region', value: 'us' }]],
  EU: ['EU', [{ key: 'region', value: 'eu' }]], JP: ['JP', [{ key: 'region', value: 'jp' }]],
} satisfies Record<string, [string, SearchFilter[]]>;
type Filter = keyof typeof FILTERS;
const SORTS: [Sort, string][] = [['name', 'Name A–Z'], ['recent', 'Recently played'], ['most', 'Most played'], ['year', 'Release year']];
const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const byName = (a: GameEntry, b: GameEntry) => sortTitle(a.title).localeCompare(sortTitle(b.title));
const COMPARE: Record<Sort, (a: GameEntry, b: GameEntry) => number> = {
  name: byName,
  recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b),
  most: (a, b) => (b.totalPlayTime || 0) - (a.totalPlayTime || 0) || byName(a, b),
  year: (a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999) || byName(a, b),
};

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
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [letter, setLetter] = useState<string | null>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useSpatialFocus();
  useEffect(() => { document.title = 'Library · Cartouche'; }, []);

  const { cont, shelf, free, tests, hasRoms } = useMemo(() => {
    const when = (g: GameEntry) => g.lastPlayed || g.importedAt || 0;
    const mine = games.filter((g) => owned(g) && when(g)).sort((a, b) => when(b) - when(a));
    return {
      cont: mine[0] as GameEntry | undefined,
      shelf: mine.slice(1),
      free: games.filter((g) => playsNow(g) && g !== mine[0] && g.category !== TEST_CATEGORY),
      tests: games.filter((g) => playsNow(g) && g.category === TEST_CATEGORY),
      hasRoms: games.some((g) => g.isLocal),
    };
  }, [games]);

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
    el.scrollIntoView({ behavior: motion(), block: 'center' });
    el.classList.remove('hl');
    void el.offsetWidth; // restart the highlight animation
    el.classList.add('hl');
    setTimeout(() => (el.matches('a') ? el : el.querySelector<HTMLElement>('a.t'))?.focus({ preventScroll: true }), 400);
  };

  if (loading) return <main className="wrap loading" aria-busy="true">Loading your library…</main>;

  return (
    <main>
      {cont ? <ContinueHero game={cont} /> : <FirstHero bundled={free[0]} />}
      <div className="wrap">
        {storageError && <StorageNotice />}
        <section className="sec" aria-labelledby="h-shelf">
          <div className="sec-h">
            <h2 id="h-shelf">Your shelf</h2>
            <span className="count">{shelf.length ? `${shelf.length}${cont ? ' more' : ''} · recently played first` : 'Nothing here yet'}</span>
            {hasRoms && <button className="linkbtn end" onClick={() => pickFilter('mine', true)}>Only mine {I.next}</button>}
          </div>
          {shelf.length ? (
            <div className="shelf rail">{shelf.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          ) : (
            <>
              <div className="slotrow">
                <Link to="/add">{I.plus}Add ROMs</Link>
                {Array.from({ length: 6 }, (_, i) => <span key={i} />)}
              </div>
              <p className="shelf-empty">Games you add or play stand here, most recent first.{cont ? '' : ' Your files are read in this browser and never uploaded.'}</p>
            </>
          )}
        </section>

        {free.length > 0 && (
          <section className="sec" aria-labelledby="h-free">
            <div className="sec-h"><h2 id="h-free">Play right now</h2><span className="count">No file needed: free homebrew that comes with the app</span></div>
            <div className="shelf">{free.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          </section>
        )}

        {tests.length > 0 && (
          <section className="sec" aria-labelledby="h-tests">
            <div className="sec-h"><h2 id="h-tests">Test cartridges</h2><span className="count">Hardware tests that come with the app: see if the emulator passes</span></div>
            <div className="shelf">{tests.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          </section>
        )}

        <section className="sec" aria-labelledby="h-cat" id="catalog" ref={catalogRef}>
          <div className="sec-h">
            <h2 id="h-cat">All games</h2>
            <span className="count">{games.length.toLocaleString('en-US')} {games.length === 1 ? 'game' : 'games'} · free homebrew, test cartridges and your own ROMs</span>
          </div>
          <div className="tools">
            <div className="chips" role="group" aria-label="Filter">
              {(Object.keys(FILTERS) as Filter[]).map((v) => <button key={v} className="chip" aria-pressed={filter === v} onClick={() => pickFilter(v)}>{FILTERS[v][0]}</button>)}
              <Link className="chip more" to={paths.search(formatQuery({ text: '', filters: FILTERS[filter][1] }))} state={searchState()}>{I.search}More filters</Link>
            </div>
            <div className="right">
              <label className="sel">Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <div className="vt" role="group" aria-label="View">
                <button aria-pressed={view === 'grid'} aria-label="Grid" onClick={() => setView('grid')}>{I.grid}</button>
                <button aria-pressed={view === 'list'} aria-label="List" onClick={() => setView('list')}>{I.list}</button>
              </div>
            </div>
          </div>
          {sort === 'name' && list.length > 0 && (
            <nav className="index" aria-label="Jump to letter">
              {LETTERS.map((l) => (
                <button key={l} disabled={!present.has(l)} aria-current={letter === l || undefined} aria-label={`Jump to ${l}`} onClick={() => jumpTo(l)}>{l}</button>
              ))}
            </nav>
          )}
          <div ref={bodyRef}>
            {!list.length ? (
              <div className="empty-inline" style={{ borderColor: '#3a3a3a', color: 'var(--mute)' }}>
                No games match this filter. <button className="linkbtn" onClick={() => pickFilter('all')}>Show all</button>
              </div>
            ) : view === 'grid' ? (
              <div className="shelf cat">{list.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
            ) : (
              <>
                <div className="lhead"><span /><span>Title</span><span className="c">Played</span><span className="c">Last played</span><span>Status</span><span /></div>
                <div className="list">{list.map((g) => <ListRow key={g.id} game={g} saved={savedIds} onFavorite={toggleFavorite} />)}</div>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/** Shown when the browser blocks IndexedDB: nothing can be kept, but the bundled games still play. */
export function StorageNotice() {
  return (
    <div className="notice" role="status" style={{ marginTop: 24 }}>
      <span className="ic">i</span>
      <span>This browser is blocking storage. You can browse and play the bundled games, but ROMs and saves can’t be kept.</span>
    </div>
  );
}
