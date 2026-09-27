import type { StoredSave } from './db';

export interface SramIO {
  read(id: string): Promise<StoredSave | undefined>;
  put(save: StoredSave): Promise<void>;
  /** A new, empty profile of the same game to go on in (not stored yet), named after `of`. */
  fork(of: StoredSave | undefined, id: string): Promise<StoredSave>;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One player's battery save, written to its profile without going over a save it didn't see.
 * - write() is a single put issued at once: a page unloading never runs a second step (a read, then a write).
 * - It writes only when the SRAM changed since it was loaded or last written: a paused or idle tab writes nothing.
 *   A game with no save yet gets one once its RAM holds something.
 * - check() reads the stored record: when something else wrote it since (another tab, sync, a restore), this
 *   player's next change goes to a new profile, so both are kept.
 * write() before adopt() or the first check() of a profile knows no record: it returns 'unknown' and writes nothing.
 */
export class SramWriter {
  /** The profile's record as last read or written here, and what it held (`fork`: where the next write goes). */
  private known: { id: string; rec?: StoredSave; fork?: StoredSave } | null = null;
  private io: SramIO;
  constructor(io: SramIO) { this.io = io; }

  /** The record the player just loaded into the game (undefined: none yet): what a change is measured against. */
  adopt(id: string, rec: StoredSave | undefined) { this.known = { id, rec }; }

  async check(id: string): Promise<void> {
    const k = this.known;
    const rec = await this.io.read(id);
    if (this.known !== k) return; // written meanwhile: the next check looks again
    if (k?.id !== id) { this.known = { id, rec }; return; }
    if (k.fork || rec?.timestamp === k.rec?.timestamp) return;
    const fork = await this.io.fork(rec ?? k.rec, id);
    if (this.known === k) k.fork = fork;
  }

  /** The profile written to (a new one after a change elsewhere), null when nothing changed. */
  write(id: string, sram: Uint8Array, name: string, now = Date.now()): { to: StoredSave; done: Promise<void> } | null | 'unknown' {
    const k = this.known;
    if (k?.id !== id) return 'unknown';
    // Nothing new since it was loaded or written; or no save yet and the RAM still blank (the core powers it on zeroed).
    if (k.rec ? same(k.rec.sram, sram) : sram.every((x) => x === 0)) return null;
    const base = k.fork ?? k.rec ?? { id, gameId: id.split('~')[0], name, created: now };
    const to: StoredSave = { ...base, sram: sram.slice(), timestamp: now };
    this.known = { id: to.id, rec: to };
    const done = this.io.put(to).catch((e) => { if (this.known?.rec === to) this.known = k; throw e; });
    return { to, done };
  }
}

/** A battery save written this soon after a resume point comes from the same leave (the same RAM, ms apart). */
const SAME_LEAVE_MS = 500;
/**
 * A resume point holds the cartridge RAM of its moment. A battery save written well after it (a link cable session,
 * online play, a sync, an autosave the tab outlived) is newer: loading the state would write its old RAM over that save.
 * ponytail: timestamps only; a save flushed by the timer just after a 30 s resume point with the same RAM also counts
 * as newer (the game then starts from its save, nothing lost). Compare the state's RAM if that ever matters.
 */
export const resumeOlderThan = (stateAt: number, save: { timestamp: number } | undefined) => !!save && save.timestamp > stateAt + SAME_LEAVE_MS;
