// "Erase everything" (Settings › Storage): the one place that forgets all this browser keeps for the app.
import { clearAll } from './db';
import { deleteBoxArt } from './cover-art';
import { engine, useSync } from './sync/status';
import { inUse } from './play-lock';
import { useSettingsStore } from '../store/settingsStore';

/**
 * A key this app writes in localStorage or sessionStorage: every `cartouche*` key (RetroAchievements key and hashes,
 * sync pairing, alias and seen maps, TURN credential, link cable choices, controls, hints), the settings and the
 * library's view choices. Only the app's own: the origin (a GitHub Pages user site) is shared with other projects.
 * `cartouche-version` stays: it holds nothing personal and only tells an update from a first visit.
 */
export const isAppKey = (k: string) => (k.startsWith('cartouche') && k !== 'cartouche-version') || k === 'gb-settings' || k.startsWith('lib.');

const forgetKeys = (s: () => Storage) => {
  try { const st = s(); Object.keys(st).filter(isAppKey).forEach((k) => st.removeItem(k)); } catch { /* storage blocked: nothing kept there */ }
};

/**
 * false: nothing erased, a game (or the link cable) is open in another tab. Its player would write its battery save and
 * resume point back right after (at its next autosave, or as it closes).
 */
export async function eraseEverything(): Promise<boolean> {
  const busy = await inUse();
  if (busy.games.length || busy.link) return false;
  // Unpair first, telling each paired device whose link is up (as Unpair does): whoever uses this browser next keeps
  // no link to them, and auto sync can't pull the erased saves back or push the reset settings over theirs.
  const sync = await engine().catch(() => null);
  if (sync) {
    for (const d of useSync.getState().devices) sync.removeDevice(d.id);
    await sync.forgetTransfers().catch(() => {});
    await new Promise((r) => setTimeout(r, 500)); // the unpair messages go out
  }
  useSync.setState({ devices: [], auto: false, roms: false }); // other tabs pick the empty list up
  indexedDB.deleteDatabase('cartouche-sync'); // pieces of interrupted transfers (done once this page's connection closes)
  await clearAll(); // ROMs, saves, states, screenshots, library data
  useSettingsStore.getState().resetToDefaults();
  await deleteBoxArt(); // the offline app shell stays: it holds no personal data
  // Last, so nothing above writes a key back.
  forgetKeys(() => localStorage);
  forgetKeys(() => sessionStorage);
  return true;
}
