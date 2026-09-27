import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ControlsTab } from './ControlsTab';
import { DisplayTab } from './DisplayTab';
import { AudioTab } from './AudioTab';
import { EmulationTab } from './EmulationTab';
import { StorageTab } from './StorageTab';
import { AboutTab } from './AboutTab';
import { LanguageTab } from './LanguageTab';
import { useT, type Key } from '../../i18n';

// Sync brings the pairing QR code with it: loaded when opened.
const SyncTab = lazy(() => import('../sync/SyncTab').then((m) => ({ default: m.SyncTab })));

const SECTIONS: [string, Key, number, ComponentType][] = [
  ['controls', 'settings.tabs.controls', 2, ControlsTab], ['display', 'settings.tabs.display', 4, DisplayTab], ['audio', 'settings.tabs.audio', 6, AudioTab],
  ['emulation', 'settings.tabs.emulation', 8, EmulationTab], ['storage', 'settings.tabs.storage', 10, StorageTab], ['sync', 'settings.tabs.sync', 12, SyncTab],
  ['language', 'common.language', 14, LanguageTab], ['about', 'settings.tabs.about', 16, AboutTab],
];

/** Settings laid out as a printed manual: table of contents on the left, one paper page per section. */
export function SettingsPage() {
  const { section } = useParams();
  const cur = SECTIONS.find(([id]) => id === section);
  const t = useT();
  useEffect(() => { if (cur) document.title = t('common.docTitle', { page: `${t(cur[1])} · ${t('shell.nav.settings')}` }); }, [cur, t]);
  if (!cur) return <Navigate to="/settings/controls" replace />;
  const [, label, page, Body] = cur;
  return (
    <main className="wrap">
      <div className="pagehead"><h1>{t('shell.nav.settings')}</h1><p>{t('settings.intro')}</p></div>
      <div className="manual">
        <nav className="toc" aria-label={t('settings.sections')}>
          {SECTIONS.map(([id, l, p]) => <Link key={id} to={`/settings/${id}`} aria-current={id === section ? 'page' : undefined}>{t(l)}<small>{t('player.page', { n: String(p) })}</small></Link>)}
        </nav>
        <section className="paper" aria-label={t(label)}>
          <span className="pgno">{t('player.page', { n: String(page) })}</span>
          <Suspense fallback={null}><Body /></Suspense>
        </section>
      </div>
    </main>
  );
}
