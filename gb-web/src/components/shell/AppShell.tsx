import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useGameLibrary, useSearchIndex } from '../../hooks/useGameLibrary';
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
import { LANG_NAMES, LANGS, rich, useLang, useT, type Key } from '../../i18n';
import { useSettingsStore } from '../../store/settingsStore';
import { version } from '../../../package.json';
import { SyncSlot } from '../sync/SyncSlot';

const NAV: [string, Key][] = [['/', 'shell.nav.library'], ['/link-cable', 'shell.nav.link'], ['/settings', 'shell.nav.settings']];
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
  const { storageError } = useGameLibrary();
  const shown = useSearchIndex().items.length; // the games listed: hidden test cartridges left out
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [dropping, setDropping] = useState(false);
  const canInstall = useInstall((s) => s.can) !== null;
  const t = useT();

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
      {/* First Tab stop: past the header to the page's heading, where a new page lands too. */}
      <a className="skip" href="#main" onClick={(e) => {
        e.preventDefault();
        const h = document.querySelector<HTMLElement>('main h1') ?? document.getElementById('main');
        if (h) { h.tabIndex = -1; h.focus(); }
      }}>{t('shell.skip')}</a>
      {/* a link or button in the header also closes the menu (the dimmed page sits under the header) */}
      <header className="top" onClick={(e) => { if (menu && (e.target as Element).closest('a,button:not(.menu)')) closeMenu(false); }}>
        <div className="wrap">
          <Wordmark />
          <nav className="nav" aria-label={t('shell.nav.main')}>
            {/* The underline is its own element so a route transition can slide it to the next tab. */}
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{({ isActive }) => <>{t(label)}{isActive && <i className="mk" />}</>}</NavLink>)}
          </nav>
          <button className="search" aria-label={t('shell.search')} onClick={openSearch}>
            {I.search}<span>{shown ? t('shell.searchN', { count: shown }) : t('shell.search')}</span><kbd>/</kbd>
          </button>
          <Link className="btn y" aria-label={t('shell.addRoms')} to="/add">{I.plus}<span className="lbl">{t('shell.addRoms')}</span></Link>
          <SyncSlot />
          <a className="gh" href={REPO_URL} target="_blank" rel="noopener" aria-label={t('shell.github')} title={t('shell.github')}>{I.github}</a>
          <button ref={menuBtn} className="menu" aria-label={menu ? t('shell.closeMenu') : t('shell.menu')} aria-expanded={menu} aria-controls="mnav" onClick={() => (menu ? closeMenu() : setMenu(true))}>{menu ? I.close : I.menu}</button>
        </div>
        <ArtProgress />
      </header>
      {menu && <div className="mscrim" aria-hidden="true" onClick={() => closeMenu()} />}
      {/* A choice closes it; without a route change (the current page, GitHub in a new tab) focus returns to the button.
          Tabbing out of it closes it too. */}
      <nav className={`mnav${menu ? ' open' : ''}`} id="mnav" aria-label={t('shell.nav.main')}
        onClick={(e) => { const a = (e.target as Element).closest('a'); if (a) closeMenu(!!a.getAttribute('aria-current') || a.target === '_blank'); }}
        onBlur={(e) => { const to = e.relatedTarget; if (to && !e.currentTarget.contains(to) && to !== menuBtn.current) setMenu(false); }}>
        {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{t(label)}{I.next}</NavLink>)}
        <NavLink to="/add">{t('shell.addRoms')}{I.next}</NavLink>
        {canInstall && <button type="button" onClick={() => { closeMenu(); startInstall(); }}>{t('common.install')}{I.load}</button>}
        <a href={REPO_URL} target="_blank" rel="noopener">{t('shell.source')}{I.github}</a>
        <LangSwitch />
      </nav>

      {/* A new page remounts (fresh state); a settings section is the same page, so focus stays in its table of contents. */}
      <div className="route" id="main" key={pathname.startsWith('/settings') ? '/settings' : pathname}><Outlet /></div>

      <footer className="foot">
        {/* Three groups: what Cartouche promises, where to go next, then the small print (language, version, credits). */}
        <div className="wrap">
          <p className="f-note">{rich(t('shell.foot.stays'), { b: (s) => <b>{s}</b> })}</p>
          <div className="f-links">
            <Link to="/settings/storage">{t('shell.foot.backup')}</Link>
            {canInstall && <a href="#install" onClick={(e) => { e.preventDefault(); startInstall(); }}>{t('common.install')}</a>}
            <a href="#shortcuts" onClick={(e) => { e.preventDefault(); setShortcuts(true); }}>{t('shell.shortcuts')}</a>
            <Link to="/legal">{t('shell.legal')}</Link>
            <a href={REPO_URL} target="_blank" rel="noopener">{t('shell.source')}</a>
          </div>
          <div className="f-meta">
            <LangSwitch />
            <p className="f-small">
              <a href={`${REPO_URL}/releases/tag/v${version}`} target="_blank" rel="noopener" aria-label={t('shell.foot.version', { v: version })}>v{version}</a>
              <span>{t('shell.foot.art')}</span>
            </p>
          </div>
        </div>
      </footer>

      <SearchDialog />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <div className={`dropall${dropping ? ' on' : ''}`} aria-hidden="true">
        <div><b>{t('shell.drop')}</b><span>{t('shell.dropSub')}</span></div>
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
  const t = useT();
  const [n, of] = imp ? [total - left, total] : [art.n, art.of];
  const label = imp ? t('shell.importing') : t('shell.fetchingArt');
  return (
    <div className="artbar" role="status" aria-live="polite">
      {of > 0 && (
        <>
          <span className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={n}><i style={{ transform: `scaleX(${n / of})` }} /></span>
          <span className="wrap"><span className="cnt">{t('shell.progress', { label, n, of })}</span></span>
        </>
      )}
    </div>
  );
}

export function NotFound() {
  const t = useT();
  useEffect(() => { document.title = t('common.docTitle', { page: t('common.notFound.docTitle') }); }, [t]);
  return (
    <main className="wrap nf">
      <h1>{t('common.notFound.title')}</h1>
      <p className="lede" style={{ color: 'var(--mute)' }}>{t('common.notFound.body')}</p>
      <div className="acts" style={{ marginTop: 28 }}><Link className="btn y" to="/">{t('common.notFound.back')}</Link></div>
    </main>
  );
}

/** The three languages, each named in itself (mobile menu and footer; Settings › Language also has Automatic). */
function LangSwitch() {
  const t = useT();
  const lang = useLang();
  const set = useSettingsStore((s) => s.set);
  return (
    <span className="langs" role="group" aria-label={t('common.language')}>
      {LANGS.map((l) => <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => set({ language: l })}>{LANG_NAMES[l]}</button>)}
    </span>
  );
}
