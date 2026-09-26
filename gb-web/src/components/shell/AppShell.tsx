import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { I, REPO_URL } from '../icons';
import { queueImport } from './actions';
import { BoxArtDialog } from './BoxArtDialog';
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
  const [search, setSearch] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [dropping, setDropping] = useState(false);

  // Close the mobile menu and go back to the top on navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) { setLastPath(pathname); setMenu(false); }
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing() || document.querySelector('dialog[open]')) return;
      if (e.key === '/') { e.preventDefault(); setSearch(true); }
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
      <header className="top">
        <div className="wrap">
          <Wordmark />
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
          </nav>
          <button className="search" aria-label="Search games" onClick={() => setSearch(true)}>
            {I.search}<span>Search {games.length ? games.length.toLocaleString('en-US') : ''} games</span><kbd>/</kbd>
          </button>
          <Link className="btn y" aria-label="Add ROMs" to="/add">{I.plus}<span className="lbl">Add ROMs</span></Link>
          <a className="gh" href={REPO_URL} target="_blank" rel="noopener" aria-label="Cartouche on GitHub" title="Cartouche on GitHub">{I.github}</a>
          <button className="menu" aria-label="Menu" aria-expanded={menu} aria-controls="mnav" onClick={() => setMenu(!menu)}>{menu ? I.close : I.menu}</button>
        </div>
      </header>
      <nav className={`mnav${menu ? ' open' : ''}`} id="mnav" aria-label="Main">
        {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}{I.next}</NavLink>)}
        <NavLink to="/add">Add ROMs{I.next}</NavLink>
      </nav>

      <div className="route" key={pathname}><Outlet /></div>

      <footer className="foot">
        <div className="wrap">
          <span><b>Everything stays in this browser.</b> ROMs, saves and play time live on your device. No account, no upload.</span>
          <Link to="/settings/storage">Back up your data</Link>
          <a href="#shortcuts" onClick={(e) => { e.preventDefault(); setShortcuts(true); }}>Keyboard shortcuts</a>
          <Link to="/legal">Legal</Link>
          <a href={REPO_URL} target="_blank" rel="noopener">Source on GitHub</a>
          <span className="sp">Box art: libretro-thumbnails</span>
        </div>
      </footer>

      <SearchDialog open={search} onClose={() => setSearch(false)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <div className={`dropall${dropping ? ' on' : ''}`} aria-hidden="true">
        <div><b>Drop to add</b><span>Your files are read in this browser and never uploaded.</span></div>
      </div>
      <BoxArtDialog />
      <Toasts />
    </>
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
