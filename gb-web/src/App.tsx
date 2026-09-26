import { Component, lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { AppShell, NotFound } from './components/shell/AppShell';
import { LibraryPage } from './components/library/LibraryPage';

// Every screen but the library loads on first visit, so the first paint only ships what it shows.
const LegalPage = lazy(() => import('./components/LegalPage').then((m) => ({ default: m.LegalPage })));
const GamePage = lazy(() => import('./components/game/GamePage').then((m) => ({ default: m.GamePage })));
const PlayerPage = lazy(() => import('./components/player/PlayerPage').then((m) => ({ default: m.PlayerPage })));
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

function App() {
  return (
    // Served from /cartouche/ on GitHub Pages; 404.html (a copy of index.html) routes deep links here.
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <ErrorBoundary>
      <Suspense fallback={<div className="loading wrap" aria-busy="true" />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/add" element={<AddRomsPage />} />
            <Route path="/link-cable" element={<LinkCablePage />} />
            <Route path="/settings/:section?" element={<SettingsPage />} />
            <Route path="/game/:id" element={<GamePage />} />
            <Route path="/legal" element={<LegalPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="/game/:id/play" element={<PlayerPage />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
