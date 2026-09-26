import { useState, useCallback, useEffect, type RefObject } from 'react';
import { getGameSaveStates, getSaveState, getSram, saveSaveState, resumeStateId, setActiveProfile, slotStateId, type StoredSaveState } from '../lib/db';
import { refreshSavedIds } from './useGameLibrary';
import { toast } from '../components/shell/actions';

/** 'auto' is the resume point written when leaving; numbers are the 5 slots. */
export type SlotKey = 'auto' | number;

/**
 * Resume point + 5 save slots of a game, with their thumbnails.
 * `states[0]` is the resume point, `states[1..5]` the slots (undefined when empty).
 * `profileRef`: the save profile being played; each state records it, and loading a state taken in
 * another profile switches the battery save back to that one (the state holds that profile's SRAM).
 */
export function useSaveStates(
  gameId: string | undefined,
  emulator: {
    saveState: () => Uint8Array | null;
    loadState: (data: Uint8Array) => boolean;
    framebufferSnapshot: () => Uint8Array | null;
  },
  profileRef?: RefObject<string | null>,
) {
  const [states, setStates] = useState<(StoredSaveState | undefined)[]>([]);
  const { saveState, loadState, framebufferSnapshot } = emulator;
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
    const other = profileRef?.current && entry.profile && entry.profile !== profileRef.current ? await getSram(entry.profile).catch(() => undefined) : undefined;
    if (!loadState(entry.data)) return false;
    if (other && profileRef) {
      profileRef.current = other.id;
      setActiveProfile(gameId, other.id).catch(() => {});
      toast(`This save belongs to “${other.name}”: saving there now`, 'c');
    }
    return true;
  }, [gameId, idOf, loadState, profileRef]);

  return { states, save, load };
}
