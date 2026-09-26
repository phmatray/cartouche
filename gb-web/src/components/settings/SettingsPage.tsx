import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ControlsTab } from './ControlsTab';
import { DisplayTab } from './DisplayTab';
import { AudioTab } from './AudioTab';
import { EmulationTab } from './EmulationTab';
import { StorageTab } from './StorageTab';
import { AboutTab } from './AboutTab';

const SECTIONS = [
  ['controls', 'Controls', 2, ControlsTab], ['display', 'Display', 4, DisplayTab], ['audio', 'Audio', 6, AudioTab],
  ['emulation', 'Emulation', 8, EmulationTab], ['storage', 'Storage', 10, StorageTab], ['about', 'About', 12, AboutTab],
] as const;

/** Settings laid out as a printed manual: table of contents on the left, one paper page per section. */
export function SettingsPage() {
  const { section } = useParams();
  const cur = SECTIONS.find(([id]) => id === section);
  useEffect(() => { if (cur) document.title = `${cur[1]} · Settings · Cartouche`; }, [cur]);
  if (!cur) return <Navigate to="/settings/controls" replace />;
  const [, label, page, Body] = cur;
  return (
    <main className="wrap">
      <div className="pagehead"><h1>Settings</h1><p>Saved in this browser and applied to every game.</p></div>
      <div className="manual">
        <nav className="toc" aria-label="Settings sections">
          {SECTIONS.map(([id, l, p]) => <Link key={id} to={`/settings/${id}`} aria-current={id === section ? 'page' : undefined}>{l}<small>p. {p}</small></Link>)}
        </nav>
        <section className="paper" aria-label={label}>
          <span className="pgno">p. {page}</span>
          <Body />
        </section>
      </div>
    </main>
  );
}
