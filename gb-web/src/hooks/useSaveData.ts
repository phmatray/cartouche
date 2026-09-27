import { useEffect, useState, type RefObject } from 'react';
import { gameOfSave, getSram, listProfiles, newProfileId, saveSram, setActiveProfile, uniqueName, writeProfileSram } from '../lib/db';
import { SramWriter, type SramIO } from '../lib/sram-writer';
import { useSettingsStore } from '../store/settingsStore';
import { toast } from '../components/shell/actions';
import { t } from '../i18n';
import { refreshSavedIds } from './useGameLibrary';

interface UseSaveDataOptions {
  /** The save profile being played (read at each write: loading a save state can switch it). null: not decided yet. */
  saveTo: RefObject<string | null>;
  romLoaded: boolean;
  hasBatteryRam: () => boolean;
  exportSram: () => Uint8Array | null;
}

/** The battery saves in IndexedDB, as a SramWriter reads and writes them (a fork: a new profile named after the save). */
export const sramIO: SramIO = {
  read: getSram,
  put: saveSram,
  fork: async (of, id) => {
    const gameId = gameOfSave(id), now = Date.now();
    const name = uniqueName(await listProfiles(gameId), of?.name ?? t('player.saves.main'));
    return { id: newProfileId(gameId), gameId, name, sram: new Uint8Array(), timestamp: now, created: now };
  },
};

/** How often the stored save is looked at: learns the profile soon after boot, and spots a write from elsewhere. */
export const CHECK_MS = 5000;

/**
 * Keeps the cartridge's battery save in IndexedDB: at the interval set in Settings (when on) and always when the
 * game closes or the page goes away. (The player imports it on load.) See SramWriter: only a change is written,
 * and never over a save written elsewhere meanwhile. The player tells it which record it loaded (adopt).
 */
export function useSaveData({ saveTo, romLoaded, hasBatteryRam, exportSram }: UseSaveDataOptions) {
  const enabled = useSettingsStore((s) => s.autoSaveEnabled);
  const seconds = useSettingsStore((s) => s.autoSaveIntervalSeconds);
  const [writer] = useState(() => new SramWriter(sramIO));
  useEffect(() => {
    if (!romLoaded || !hasBatteryRam()) return;
    const check = () => (saveTo.current ? writer.check(saveTo.current).catch(() => {}) : Promise.resolve());
    const flush = () => {
      const id = saveTo.current, data = exportSram();
      if (!id || !data?.length) return;
      const w = writer.write(id, data, t('player.saves.main'));
      // ponytail: blind read-then-write before the first check (the first seconds after boot or a profile switch).
      if (w === 'unknown') { writeProfileSram(id, data).catch(() => {}); return; }
      if (!w) return;
      w.done.catch(() => {});
      if (w.to.id === id) return;
      saveTo.current = w.to.id;
      setActiveProfile(w.to.gameId, w.to.id).catch(() => {});
      refreshSavedIds();
      toast(t('player.toast.changedElsewhere', { name: w.to.name }), 'm');
    };
    check();
    const watch = window.setInterval(check, CHECK_MS);
    // Looked at just before each timed write; on leaving, the write must be issued at once (see SramWriter).
    const timer = enabled ? window.setInterval(() => { check().then(flush); }, seconds * 1000) : 0;
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    // WebKit drops a write issued in pagehide during a reload or close; one from beforeunload lands.
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      window.clearInterval(watch);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [saveTo, romLoaded, hasBatteryRam, exportSram, enabled, seconds, writer]);
  return writer;
}
