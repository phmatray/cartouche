import { t } from '../i18n';
import { useState, useCallback, useEffect, type RefObject } from 'react';
import { createProfile, getGameSaveStates, getSaveState, getSram, listProfiles, saveSaveState, resumeStateId, setActiveProfile, slotStateId, uniqueName, type StoredSaveState } from '../lib/db';
import { refreshSavedIds } from './useGameLibrary';
import { toast } from '../components/shell/actions';

/** 'auto' is the resume point written when leaving; numbers are the 5 slots. */
export type SlotKey = 'auto' | number;

/**
 * Resume point + 5 save slots of a game, with their thumbnails.
 * `states[0]` is the resume point, `states[1..5]` the slots (undefined when empty).
 * `profileRef`: the save profile being played; each state records it, and loading a state taken in
 * another profile switches the battery save back to that one (the state holds that profile's SRAM).
 * A state from before profiles belongs to Main; one whose profile was deleted goes to a new save.
 */
export function useSaveStates(
  gameId: string | undefined,
  emulator: {
    saveState: () => Uint8Array | null;
    loadState: (data: Uint8Array, frame?: Uint8Array) => boolean;
    framebufferSnapshot: () => Uint8Array | null;
    exportSram: () => Uint8Array | null;
  },
  profileRef?: RefObject<string | null>,
) {
  const [states, setStates] = useState<(StoredSaveState | undefined)[]>([]);
  const { saveState, loadState, framebufferSnapshot, exportSram } = emulator;
  const idOf = useCallback((k: SlotKey) => (k === 'auto' ? resumeStateId(gameId!) : slotStateId(gameId!, k)), [gameId]);

  const reload = useCallback(async () => {
    if (gameId) setStates(await getGameSaveStates(gameId));
  }, [gameId]);
  useEffect(() => {
    let cancelled = false;
    if (gameId) getGameSaveStates(gameId).then((s) => { if (!cancelled) setStates(s); }).catch(() => {}); // storage blocked: no slots
    return () => { cancelled = true; };
  }, [gameId]);

  /** Snapshot the running game now (synchronously), then store it. */
  const save = useCallback(async (k: SlotKey) => {
    if (!gameId) return false;
    const data = saveState();
    if (!data) return false;
    const thumbnail = framebufferSnapshot();
    await saveSaveState({ id: idOf(k), data: new Uint8Array(data), thumbnail: new Uint8Array(thumbnail ?? []), timestamp: Date.now(), profile: profileRef?.current ?? undefined });
    await Promise.all([reload(), refreshSavedIds()]);
    return true;
  }, [gameId, idOf, saveState, framebufferSnapshot, reload, profileRef]);

  const load = useCallback(async (k: SlotKey) => {
    if (!gameId) return false;
    const entry = await getSaveState(idOf(k));
    if (!entry) return false;
    // Look the profile up before loading: once the state is in, a battery write must already go to the right profile.
    const owner = entry.profile ?? gameId; // states from before profiles belong to Main
    const switching = !!profileRef?.current && owner !== profileRef.current;
    const other = switching ? await getSram(owner).catch(() => undefined) : undefined;
    if (!loadState(entry.data, entry.thumbnail)) return false;
    if (!switching || !profileRef) return true;
    if (other) {
      profileRef.current = other.id;
      setActiveProfile(gameId, other.id).catch(() => {});
      toast(t('player.toast.belongs', { name: other.name }), 'c');
      return true;
    }
    // Its save was deleted: never let it overwrite the one being played; it becomes a save of its own.
    try {
      const name = uniqueName(await listProfiles(gameId), k === 'auto' ? t('player.saves.fromResume') : t('player.saves.fromSlot', { n: String(k + 1) }));
      const p = await createProfile(gameId, name, exportSram() ?? new Uint8Array());
      profileRef.current = p.id;
      await setActiveProfile(gameId, p.id);
      refreshSavedIds();
      toast(t('player.toast.newSave', { name: p.name }), 'c');
    } catch {
      profileRef.current = null; // storage failed: write nowhere rather than over another save
    }
    return true;
  }, [gameId, idOf, loadState, exportSram, profileRef]);

  return { states, save, load };
}
