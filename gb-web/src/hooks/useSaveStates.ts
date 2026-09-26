import { useState, useCallback, useEffect } from 'react';
import { getGameSaveStates, getSaveState, saveSaveState, resumeStateId, slotStateId, type StoredSaveState } from '../lib/db';
import { refreshSavedIds } from './useGameLibrary';

/** 'auto' is the resume point written when leaving; numbers are the 5 slots. */
export type SlotKey = 'auto' | number;

/**
 * Resume point + 5 save slots of a game, with their thumbnails.
 * `states[0]` is the resume point, `states[1..5]` the slots (undefined when empty).
 */
export function useSaveStates(
  gameId: string | undefined,
  emulator: {
    saveState: () => Uint8Array | null;
    loadState: (data: Uint8Array) => boolean;
    framebufferSnapshot: () => Uint8Array | null;
  },
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
    await saveSaveState({ id: idOf(k), data: new Uint8Array(data), thumbnail: new Uint8Array(thumbnail ?? []), timestamp: Date.now() });
    await Promise.all([reload(), refreshSavedIds()]);
    return true;
  }, [gameId, idOf, saveState, framebufferSnapshot, reload]);

  const load = useCallback(async (k: SlotKey) => {
    if (!gameId) return false;
    const entry = await getSaveState(idOf(k));
    return !!entry && loadState(entry.data);
  }, [gameId, idOf, loadState]);

  return { states, save, load };
}
