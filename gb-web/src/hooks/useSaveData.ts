import { useEffect, type RefObject } from 'react';
import { writeProfileSram } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';

interface UseSaveDataOptions {
  /** The save profile being played (read at each write: loading a save state can switch it). null: not decided yet. */
  saveTo: RefObject<string | null>;
  romLoaded: boolean;
  hasBatteryRam: () => boolean;
  exportSram: () => Uint8Array | null;
}

/** Keeps the cartridge's battery save in IndexedDB: at the interval set in Settings (when on) and always when the game closes. (The player imports it on load.) */
export function useSaveData({ saveTo, romLoaded, hasBatteryRam, exportSram }: UseSaveDataOptions) {
  const enabled = useSettingsStore((s) => s.autoSaveEnabled);
  const seconds = useSettingsStore((s) => s.autoSaveIntervalSeconds);
  useEffect(() => {
    if (!romLoaded || !hasBatteryRam()) return;
    const flush = () => {
      const data = exportSram();
      if (saveTo.current && data && data.length > 0) writeProfileSram(saveTo.current, data);
    };
    const timer = enabled ? window.setInterval(flush, seconds * 1000) : 0;
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { flush(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onHide); };
  }, [saveTo, romLoaded, hasBatteryRam, exportSram, enabled, seconds]);
}
