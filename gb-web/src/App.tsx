import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, ScrollRestoration, useLocation } from 'react-router';
import { committed, install } from './lib/transitions';
import { warmAudio } from './audio/AudioEngine';
import { useGamepadNav } from './hooks/useGamepadNav';
import { AppShell, NotFound } from './components/shell/AppShell';
import { LibraryPage } from './components/library/LibraryPage';
import { t } from './i18n';
import { useSettingsStore } from './store/settingsStore';

// Settings › Display › Animations, on <html> before the first paint: CSS and lib/ui's reducedMotion() read it.
const applyMotion = (m: string) => { if (m === 'system') delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = m; };
applyMotion(useSettingsStore.getState().motion);
useSettingsStore.subscribe((s) => applyMotion(s.motion));

// Every screen but the library loads on first visit, so the first paint only ships what it shows.
// The game page and the player are fetched once the library is idle: opening a game never waits for its code.
const loadGame = () => import('./components/game/GamePage');
const loadPlayer = () => import('./components/player/PlayerPage');
const LegalPage = lazy(() => import('./components/LegalPage').then((m) => ({ default: m.LegalPage })));
const GamePage = lazy(() => loadGame().then((m) => ({ default: m.GamePage })));
const PlayerPage = lazy(() => loadPlayer().then((m) => ({ default: m.PlayerPage })));
const LinkCablePage = lazy(() => import('./components/LinkCablePage').then((m) => ({ default: m.LinkCablePage })));
const OnlineLinkPage = lazy(() => import('./components/netlink/OnlineLinkPage').then((m) => ({ default: m.OnlineLinkPage })));
const SettingsPage = lazy(() => import('./components/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AddRomsPage = lazy(() => import('./components/add/AddRomsPage').then((m) => ({ default: m.AddRomsPage })));
const MusicPage = lazy(() => import('./components/music/MusicPage').then((m) => ({ default: m.MusicPage })));

/**
 * Last line of defence: a render error shows the "Nothing in this slot." page instead of a blank screen.
 * `at` (the path): going to another page, or back, tries rendering again.
 */
class ErrorBoundary extends Component<{ children: ReactNode; at: string }, { failed: boolean; at: string }> {
  state = { failed: false, at: this.props.at };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { at: string }, state: { at: string }) {
    return props.at === state.at ? null : { failed: false, at: props.at };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="wrap nf">
        <h1>{t('common.notFound.title')}</h1>
        <p className="lede" style={{ color: 'var(--mute)' }}>{t('common.crash')}</p>
        <div className="acts" style={{ marginTop: 28 }}><a className="btn y" href={import.meta.env.BASE_URL}>{t('common.notFound.back')}</a></div>
      </main>
    );
  }
}

function ToLibrary() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/', search, hash }} replace />;
}

/** Every route: error boundary, lazy-page suspense, scroll restoration, and the commit signal view transitions wait for. */
function Root() {
  const { key, pathname } = useLocation();
  useEffect(committed, [key]);
  useGamepadNav();
  // One click away from Play (library, game page): open the audio device once the page has settled.
  const nearPlay = pathname === '/' || /^\/game\/[^/]+\/?$/.test(pathname);
  useEffect(() => {
    if (!nearPlay) return;
    const t = setTimeout(warmAudio, 1500);
    return () => clearTimeout(t);
  }, [nearPlay]);
  useEffect(() => {
    const t = setTimeout(() => { loadGame().catch(() => {}); loadPlayer().catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <ErrorBoundary at={pathname}>
      <Suspense fallback={<div className="loading wrap" aria-busy="true" />}><Outlet /></Suspense>
      <ScrollRestoration />
    </ErrorBoundary>
  );
}

// Served from /cartouche/ on GitHub Pages; 404.html (a copy of index.html) routes deep links here.
// The basename keeps its trailing slash: the search at the root is /cartouche/?q=… (/cartouche?q=… 404s on reload).
const router = createBrowserRouter([{
  element: <Root />,
  children: [
    {
      element: <AppShell />,
      children: [
        { path: '/', element: <LibraryPage /> },
        // The server's own name for the page (a bookmark, a self-hosted copy): the library, not "Nothing in this slot".
        { path: '/index.html', element: <ToLibrary /> },
        { path: '/add', element: <AddRomsPage /> },
        { path: '/link-cable', element: <LinkCablePage /> },
        { path: '/link-cable/online', element: <OnlineLinkPage /> },
        { path: '/settings/:section?', element: <SettingsPage /> },
        { path: '/game/:id', element: <GamePage /> },
        { path: '/music/:id', element: <MusicPage /> },
        { path: '/legal', element: <LegalPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
    { path: '/game/:id/play', element: <PlayerPage /> },
  ],
}], { basename: import.meta.env.BASE_URL });
install(router);

export default function App() {
  return <RouterProvider router={router} />;
}
