import { lazy, Suspense } from 'react';

const SyncMark = lazy(() => import('./SyncMark').then((m) => ({ default: m.SyncMark })));
/** Paired devices are stored by lib/sync/status (zustand persist); peeked at here so the app's first load carries none of it. */
const paired = () => { try { return /"devices":\[\{/.test(localStorage.getItem('cartouche.sync') ?? ''); } catch { return false; } };

/** The header's sync light, loaded only on a device that has been paired (checked again on every page change). */
export function SyncSlot() {
  return paired() ? <Suspense fallback={null}><SyncMark /></Suspense> : null;
}
