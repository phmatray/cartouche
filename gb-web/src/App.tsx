import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Outlet, RouterProvider, ScrollRestoration, useLocation } from 'react-router';
import { committed, install } from './lib/transitions';
import { AppShell, NotFound } from './components/shell/AppShell';
import { LibraryPage } from './components/library/LibraryPage';

// Every screen but the library loads on first visit, so the first paint only ships what it shows.
// The game page and the player are fetched once the library is idle: opening a game never waits for its code.
const loadGame = () => import('./components/game/GamePage');
const loadPlayer = () => import('./components/player/PlayerPage');
const LegalPage = lazy(() => import('./components/LegalPage').then((m) => ({ default: m.LegalPage })));
const GamePage = lazy(() => loadGame().then((m) => ({ default: m.GamePage })));
const PlayerPage = lazy(() => loadPlayer().then((m) => ({ default: m.PlayerPage })));
const LinkCablePage = lazy(() => import('./components/LinkCablePage').then((m) => ({ default: m.LinkCablePage })));
const SettingsPage = lazy(() => import('./components/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AddRomsPage = lazy(() => import('./components/add/AddRomsPage').then((m) => ({ default: m.AddRomsPage })));

/** Last line of defence: a render error shows the "Nothing in this slot." page instead of a blank screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="wrap nf">
        <h1>Nothing in this slot.</h1>
        <p className="lede" style={{ color: 'var(--mute)' }}>Something went wrong while showing this page. Your games and saves are untouched.</p>
        <div className="acts" style={{ marginTop: 28 }}><a className="btn y" href={import.meta.env.BASE_URL}>Back to the library</a></div>
      </main>
    );
  }
}

/** Every route: error boundary, lazy-page suspense, scroll restoration, and the commit signal view transitions wait for. */
function Root() {
  const { key } = useLocation();
  useEffect(committed, [key]);
  useEffect(() => {
    const t = setTimeout(() => { loadGame().catch(() => {}); loadPlayer().catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <ErrorBoundary>
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
        { path: '/add', element: <AddRomsPage /> },
        { path: '/link-cable', element: <LinkCablePage /> },
        { path: '/settings/:section?', element: <SettingsPage /> },
        { path: '/game/:id', element: <GamePage /> },
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
