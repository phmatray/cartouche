import { useCallback, useEffect, useState } from 'react';
import type { GameEntry } from '../types/game';
import { addScreenshot, createProfile, getScreenshots, listProfiles, uniqueName, type StoredSave, type StoredScreenshot } from '../lib/db';
import { computeSha1, isGameBoyRom, parseRomHeader, savSizeError, type RomMetadata } from '../lib/rom-utils';
import { lookupByHash } from '../lib/gamedb';
import { owned } from '../lib/ui';
import { toast } from '../components/shell/actions';
import { fetchRom, titleKey, useGameLibrary } from './useGameLibrary';

/** A game's album, newest first, and a way to add to it. */
export function useAlbum(gameId: string) {
  const [shots, setShots] = useState<StoredScreenshot[]>([]);
  const reload = useCallback(async () => setShots(await getScreenshots(gameId)), [gameId]);
  useEffect(() => {
    let cancelled = false;
    getScreenshots(gameId).then((s) => { if (!cancelled) setShots(s); }).catch(() => {}); // storage blocked: empty album
    return () => { cancelled = true; };
  }, [gameId]);
  const add = useCallback(async (rgba: Uint8Array) => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 144;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), 160, 144), 0, 0);
    const png = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!png) return;
    await addScreenshot({ gameId, png, timestamp: Date.now() });
    await reload();
  }, [gameId, reload]);
  return { shots, add };
}

/** Cartridge header facts read from the game's ROM (stored or bundled). null when there is no ROM. */
export function useRomHeader(game: GameEntry | undefined) {
  const [header, setHeader] = useState<{ id: string; meta: RomMetadata | null } | null>(null);
  useEffect(() => {
    if (!game || !owned(game)) return;
    let cancelled = false;
    fetchRom(game).then((d) => { if (!cancelled) setHeader({ id: game.id, meta: parseRomHeader(d) }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [game]);
  return header && header.id === game?.id ? header.meta : null;
}

/**
 * A .sav file as a new save profile of the game, named after the file. Its size is checked against the
 * cartridge's save memory (ROM header). Resolves to the profile, or to the reason it was refused.
 */
export async function importSav(game: GameEntry, file: File): Promise<StoredSave | string> {
  const [rom, data] = await Promise.all([fetchRom(game), file.arrayBuffer().then((b) => new Uint8Array(b))]);
  const err = savSizeError(rom, data.length);
  if (err) return `${file.name}: ${err}`;
  const name = uniqueName(await listProfiles(game.id), file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Imported');
  return createProfile(game.id, name, data);
}

/** "Game Boy", "Game Boy Color" or both, from the header's CGB flag. */
export const hardwareOf = (m: RomMetadata) => (m.cgbFlag === 'CGB Only' ? 'Game Boy Color' : m.cgbFlag === 'CGB Compatible' ? 'Game Boy + Color' : 'Game Boy');

/**
 * Link the user's own file to a catalog entry. The file's SHA-1 is looked up among known dumps:
 * a match confirms it, another title is reported, an unknown file is linked as asked.
 * Resolves to the ROM bytes (to start playing right away), or null on failure.
 */
export function useLinkRom(game: GameEntry | undefined) {
  const { linkRomToGame } = useGameLibrary();
  return useCallback(async (file: File): Promise<Uint8Array | null> => {
    if (!game) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    if (!isGameBoyRom(data)) { toast(`${file.name} is damaged or isn’t a Game Boy ROM`, 'm'); return null; }
    const sha1 = await computeSha1(data);
    const known = await lookupByHash(sha1);
    await linkRomToGame(game, data, sha1);
    if (!known) toast(`Linked to ${game.title}. This file isn’t among the known dumps, so it could be a hack or a bad dump.`, 'm');
    else if (titleKey(known.title) !== titleKey(game.title)) toast(`Linked, but its fingerprint says ${known.title}`, 'm');
    else toast(`${game.title} recognized: your ROM is linked`, 'c');
    return data;
  }, [game, linkRomToGame]);
}
