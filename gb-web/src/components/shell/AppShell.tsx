import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { useBoxArtProgress } from '../../lib/cover-art';
import { queueImport, useImports } from '../../lib/import-queue';
import { useInstall } from '../../lib/pwa';
import { paths, searchState } from '../../lib/ui';
import { I, REPO_URL } from '../icons';
import { startInstall } from './actions';
import { BoxArtDialog } from './BoxArtDialog';
import { InstallHint, InstallSheet } from './InstallHint';
import { SearchDialog } from './SearchDialog';
import { ShortcutsDialog } from './Shortcuts';
import { Toasts } from './Toasts';

const NAV: [string, string][] = [['/', 'Library'], ['/link-cable', 'Link Cable'], ['/settings', 'Settings']];
const typing = () => {
  const el = document.activeElement as HTMLInputElement | null;
  return !!el && (/INPUT|SELECT|TEXTAREA/.test(el.tagName) && el.type !== 'range' || el.isContentEditable);
};

function Wordmark() {
  return (
    <Link className="mark" to="/">
      <span className="strip" aria-hidden="true"><i /><i /><i /></span><b>Cartouche</b>
    </Link>
  );
}

/** Header, footer, search, shortcuts, toasts and drop-anywhere import around every library-style page. */
export function AppShell() {
  const { games, storageError } = useGameLibrary();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [dropping, setDropping] = useState(false);
  const canInstall = useInstall((s) => s.can) !== null;

  // Close the mobile menu on navigation. Scroll: <ScrollRestoration> (top on a new page, restored on back).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) { setLastPath(pathname); setMenu(false); }

  // The mobile menu also closes on Escape, a tap outside it, a scroll or swipe of the page, and any choice in it;
  // focus goes back to its button (a new page takes focus itself).
  const closeMenu = useCallback((refocus = true) => { setMenu(false); if (refocus) menuBtn.current?.focus(); }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } };
    const onScroll = () => closeMenu(!!document.activeElement?.closest('#mnav'));
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); };
  }, [menu, closeMenu]);

  // The overlay is open while the URL has ?q= (over whatever page is showing).
  const openSearch = () => { setMenu(false); navigate(paths.search('').slice(1), { state: searchState() }); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing() || document.querySelector('dialog[open]')) return;
      if (e.key === '/') { e.preventDefault(); openSearch(); }
      else if (e.key === '?') { e.preventDefault(); setShortcuts(true); }
    };
    // Drop files anywhere: the Add ROMs page opens with them (on that page, its own drop zone lights up instead).
    let depth = 0;
    const onAdd = pathname === '/add';
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (isFiles(e) && !onAdd && !storageError) { depth++; setDropping(true); } };
    const leave = () => { if (--depth <= 0) { depth = 0; setDropping(false); } };
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      if (storageError) return; // nowhere to keep them: the Add ROMs page explains why
      queueImport([...e.dataTransfer!.files]);
      if (!onAdd) navigate('/add');
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });

  return (
    <>
      {/* a link or button in the header also closes the menu (the dimmed page sits under the header) */}
      <header className="top" onClick={(e) => { if (menu && (e.target as Element).closest('a,button:not(.menu)')) closeMenu(false); }}>
        <div className="wrap">
          <Wordmark />
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
          </nav>
          <button className="search" aria-label="Search games" onClick={openSearch}>
            {I.search}<span>Search {games.length ? games.length.toLocaleString('en-US') : ''} games</span><kbd>/</kbd>
          </button>
          <Link className="btn y" aria-label="Add ROMs" to="/add">{I.plus}<span className="lbl">Add ROMs</span></Link>
          <a className="gh" href={REPO_URL} target="_blank" rel="noopener" aria-label="Cartouche on GitHub" title="Cartouche on GitHub">{I.github}</a>
          <button ref={menuBtn} className="menu" aria-label={menu ? 'Close menu' : 'Menu'} aria-expanded={menu} aria-controls="mnav" onClick={() => (menu ? closeMenu() : setMenu(true))}>{menu ? I.close : I.menu}</button>
        </div>
        <ArtProgress />
      </header>
      {menu && <div className="mscrim" aria-hidden="true" onClick={() => closeMenu()} />}
      {/* A choice closes it; without a route change (the current page, GitHub in a new tab) focus returns to the button.
          Tabbing out of it closes it too. */}
      <nav className={`mnav${menu ? ' open' : ''}`} id="mnav" aria-label="Main"
        onClick={(e) => { const a = (e.target as Element).closest('a'); if (a) closeMenu(!!a.getAttribute('aria-current') || a.target === '_blank'); }}
        onBlur={(e) => { const to = e.relatedTarget; if (to && !e.currentTarget.contains(to) && to !== menuBtn.current) setMenu(false); }}>
        {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}{I.next}</NavLink>)}
        <NavLink to="/add">Add ROMs{I.next}</NavLink>
        {canInstall && <button type="button" onClick={() => { closeMenu(); startInstall(); }}>Install the app{I.load}</button>}
        <a href={REPO_URL} target="_blank" rel="noopener">Source on GitHub{I.github}</a>
      </nav>

      {/* A new page remounts (fresh state); a settings section is the same page, so focus stays in its table of contents. */}
      <div className="route" key={pathname.startsWith('/settings') ? '/settings' : pathname}><Outlet /></div>

      <footer className="foot">
        <div className="wrap">
          <span><b>Everything stays in this browser.</b> ROMs, saves and play time live on your device. No account, no upload.</span>
          <Link to="/settings/storage">Back up your data</Link>
          {canInstall && <a href="#install" onClick={(e) => { e.preventDefault(); startInstall(); }}>Install the app</a>}
          <a href="#shortcuts" onClick={(e) => { e.preventDefault(); setShortcuts(true); }}>Keyboard shortcuts</a>
          <Link to="/legal">Legal</Link>
          <a href={REPO_URL} target="_blank" rel="noopener">Source on GitHub</a>
          <span className="sp">Box art: libretro-thumbnails · Tobu Tobu Girl art: Tangram Games (CC BY 4.0)</span>
        </div>
      </footer>

      <SearchDialog />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <div className={`dropall${dropping ? ' on' : ''}`} aria-hidden="true">
        <div><b>Drop to add</b><span>Your files are read in this browser and never uploaded.</span></div>
      </div>
      <BoxArtDialog />
      <InstallHint />
      <InstallSheet />
      <Toasts />
    </>
  );
}

/**
 * "Importing ROMs · n of m" (away from the Add ROMs page, which shows its own) or "Fetching box art · n of m":
 * a thin yellow bar pinned under the header while it runs (nothing when idle).
 */
function ArtProgress() {
  const art = useBoxArtProgress();
  const onAdd = useLocation().pathname === '/add';
  const total = useImports((s) => s.rows.length);
  const left = useImports((s) => s.rows.reduce((k, r) => k + +(r.st === 'work'), 0));
  const imp = left > 0 && !onAdd;
  const [n, of] = imp ? [total - left, total] : [art.n, art.of];
  const label = imp ? 'Importing ROMs' : 'Fetching box art';
  return (
    <div className="artbar" role="status" aria-live="polite">
      {of > 0 && (
        <>
          <span className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={n}><i style={{ width: `${(n / of) * 100}%` }} /></span>
          <span className="wrap"><span className="cnt">{label} · {n.toLocaleString('en-US')} of {of.toLocaleString('en-US')}</span></span>
        </>
      )}
    </div>
  );
}

export function NotFound() {
  useEffect(() => { document.title = 'Not found · Cartouche'; }, []);
  return (
    <main className="wrap nf">
      <h1>Nothing in this slot.</h1>
      <p className="lede" style={{ color: 'var(--mute)' }}>This page doesn’t exist, or the game was removed from your library.</p>
      <div className="acts" style={{ marginTop: 28 }}><Link className="btn y" to="/">Back to the library</Link></div>
    </main>
  );
}
