import { useEffect } from 'react';
import { create } from 'zustand';
import { getMusic, listMusic, saveMusic, type StoredMusic } from '../lib/db';
import { parseGbsHeader } from '../lib/gbs';
import { computeSha1 } from '../lib/rom-utils';
import type { ImportOutcome } from './useGameLibrary';

/** The music entries (GBS files), apart from the games. */
interface State { music: StoredMusic[]; loaded: boolean; reload(): Promise<void> }
const useStore = create<State>((set) => ({
  music: [], loaded: false,
  reload: async () => set({ music: (await listMusic()).sort((a, b) => a.title.localeCompare(b.title)), loaded: true }),
}));

export function useMusicLibrary() {
  const s = useStore();
  useEffect(() => { if (!s.loaded) s.reload().catch(() => {}); }, [s]);
  return s;
}

/** Store a GBS file as a music entry, keyed by its SHA-1: 'bad' when it isn't one, 'dup' when already there. Storage errors are thrown. */
export async function importMusic(name: string, data: Uint8Array): Promise<ImportOutcome> {
  const h = parseGbsHeader(data);
  if (!h) return { status: 'bad' };
  const sha1 = await computeSha1(data);
  const title = h.title || name.replace(/\.gbs$/i, '');
  if (await getMusic(sha1)) return { status: 'dup', id: sha1, title, sha1 };
  await saveMusic({ id: sha1, ...h, title, sha1, data, importedAt: Date.now() });
  await useStore.getState().reload();
  return { status: 'ok', id: sha1, title, sha1 };
}
