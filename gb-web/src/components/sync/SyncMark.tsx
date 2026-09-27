import { useEffect } from 'react';
import { Link } from 'react-router';
import { engine, useSync } from '../../lib/sync/status';
import { ago, list, useT } from '../../i18n';
import './mark.css';

/**
 * The header's sync light, once a device is paired: two little screens, lit when a paired device is on the line,
 * with current flowing while they sync. Starts auto-sync (when on) once the page has settled.
 */
export function SyncMark() {
  const t = useT();
  const devices = useSync((s) => s.devices);
  const auto = useSync((s) => s.auto);
  const links = useSync((s) => s.links);
  const paired = devices.length > 0;
  useEffect(() => {
    if (!paired || !auto) return;
    const timer = setTimeout(() => { engine().then((e) => e.startAuto()).catch(() => {}); }, 2500);
    return () => clearTimeout(timer);
  }, [paired, auto]);
  if (!paired) return null;

  const states = devices.map((d) => links[d.id]?.phase ?? 'offline');
  const syncing = states.includes('syncing');
  const on = syncing || states.some((p) => p === 'online' || p === 'done');
  const noted = devices.some((d) => d.report?.notes.length && !d.report.seen);
  const last = Math.max(0, ...devices.map((d) => d.lastSync ?? 0));
  const state = syncing ? t('sync.mark.syncing')
    : on ? t('sync.mark.inStep', { names: list(devices.filter((d) => ['online', 'done'].includes(links[d.id]?.phase ?? '')).map((d) => d.name)) })
    : last ? t('sync.mark.last', { ago: ago(last) }) : t('sync.mark.never');
  const label = t(noted ? 'sync.mark.check' : 'sync.mark.label', { state });
  return (
    <Link to="/settings/sync" className={`sy-mark${on ? ' on' : ''}${syncing ? ' busy' : ''}`} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2.5" y="5" width="7" height="10" /><rect x="14.5" y="9" width="7" height="10" />
        <path className="w" d="M9.5 12.5h2.5v-1h2.5" />
      </svg>
      {noted && <i className="sy-dot" aria-hidden="true" />}
    </Link>
  );
}
