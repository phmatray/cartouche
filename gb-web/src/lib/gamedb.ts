import gamedbUrl from '../data/gamedb.json?url';

export interface GameDbEntry {
  title: string;
  developer: string;
  year: string;
  region: string;
  genre: string;
  players: number;
  platform: 'gb' | 'gbc';
  /** libretro-thumbnails box-art file name (no .png), from the No-Intro DAT of `platform`. */
  libretroName?: string;
}

// A hashed static file, fetched on first use (identifying a ROM): most visits never need it.
let db: Promise<Record<string, GameDbEntry>> | null = null;

export async function lookupByHash(sha1: string): Promise<GameDbEntry | undefined> {
  db ??= fetch(gamedbUrl).then((r) => {
    if (!r.ok) throw new Error(`GameDB: ${r.status}`);
    return r.json();
  });
  try {
    return (await db)[sha1.toLowerCase()];
  } catch {
    db = null; // offline or failed: the ROM is added unrecognized, and the next lookup retries
    return undefined;
  }
}
