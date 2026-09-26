import { useEffect } from 'react';
import { saveSram } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';

interface UseSaveDataOptions {
  gameId: string | undefined;
  romLoaded: boolean;
  hasBatteryRam: () => boolean;
  exportSram: () => Uint8Array | null;
}

/** Keeps the cartridge's battery save in IndexedDB: at the interval set in Settings (when on) and always when the game closes. (The player imports it on load.) */
export function useSaveData({ gameId, romLoaded, hasBatteryRam, exportSram }: UseSaveDataOptions) {
  const enabled = useSettingsStore((s) => s.autoSaveEnabled);
  const seconds = useSettingsStore((s) => s.autoSaveIntervalSeconds);
  useEffect(() => {
    if (!gameId || !romLoaded || !hasBatteryRam()) return;
    const flush = () => {
      const data = exportSram();
      if (data && data.length > 0) saveSram({ id: gameId, sram: data, timestamp: Date.now() });
    };
    const timer = enabled ? window.setInterval(flush, seconds * 1000) : 0;
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { flush(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onHide); };
  }, [gameId, romLoaded, hasBatteryRam, exportSram, enabled, seconds]);
}
