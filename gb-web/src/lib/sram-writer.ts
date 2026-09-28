import type { StoredSave } from './db';

export interface SramIO {
  read(id: string): Promise<StoredSave | undefined>;
  put(save: StoredSave): Promise<void>;
  /** A new, empty profile of the same game to go on in (not stored yet), named after `of`. */
  fork(of: StoredSave | undefined, id: string): Promise<StoredSave>;
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
/** MBC3+TIMER exports end with a 48-byte clock footer (gb-core export_sram); cartridge RAM sizes are multiples of 512. */
const FOOTER = 48;
const footerOf = (s: Uint8Array) => (s.length % 512 === FOOTER ? s.subarray(s.length - FOOTER) : null);
/** The clock in wall time: when it started (running) or what it reads (halted). A clock that only ran on reads the same. */
function clockOf(f: Uint8Array): [halted: boolean, at: number] {
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const w = (i: number) => v.getUint32(i * 4, true);
  const dh = w(4);
  const days = (w(3) & 0xff) | ((dh & 1) << 8) | (dh & 0x80 ? 512 : 0);
  const total = (w(0) % 60) + (w(1) % 60) * 60 + (w(2) % 24) * 3600 + days * 86400;
  return dh & 0x40 ? [true, total] : [false, Number(v.getBigUint64(40, true)) - total];
}
/**
 * The same save: the same RAM and, with a clock, the same clock. Every export stamps the clock with the time it was
 * taken, so a clock that only ran on (a game opened and left, a paused tab) is no change; one the game set is.
 */
const same = (a: Uint8Array, b: Uint8Array) => {
  const [fa, fb] = [footerOf(a), footerOf(b)];
  if (!fa || !fb) return equal(a, b);
  const [ca, cb] = [clockOf(fa), clockOf(fb)];
  // Seconds, both rounded down: the same clock can read up to 2 s apart.
  return equal(a.subarray(0, -FOOTER), b.subarray(0, -FOOTER)) && ca[0] === cb[0] && Math.abs(ca[1] - cb[1]) <= 2;
};

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
  private known: { id: string; rec?: StoredSave; fork?: StoredSave; mine?: boolean; lost?: boolean } | null = null;
  private io: SramIO;
  constructor(io: SramIO) { this.io = io; }

  /** The record the player just loaded into the game (undefined: none yet): what a change is measured against. */
  adopt(id: string, rec: StoredSave | undefined) { this.known = { id, rec }; }

  async check(id: string): Promise<void> {
    const k = this.known;
    const rec = await this.io.read(id);
    if (this.known !== k) return; // written meanwhile: the next check looks again
    if (k?.id !== id) { this.known = { id, rec }; return; }
    if (k.fork) return;
    // The same write: only its name may have changed (a rename keeps the time); the next write keeps that name.
    if (rec?.timestamp === k.rec?.timestamp) { if (rec) k.rec = rec; return; }
    const fork = await this.io.fork(rec ?? k.rec, id);
    if (this.known !== k) return;
    k.fork = fork;
    // What this player wrote was written over: its RAM goes to the new profile at the next write, even unchanged.
    k.lost = !!(k.mine && rec && k.rec && !same(rec.sram, k.rec.sram));
  }

  /** The profile written to (a new one after a change elsewhere), null when nothing changed. */
  write(id: string, sram: Uint8Array, name: string, now = Date.now()): { to: StoredSave; done: Promise<void> } | null | 'unknown' {
    const k = this.known;
    if (k?.id !== id) return 'unknown';
    // Nothing new since it was loaded or written; or no save yet and the RAM still blank (the core powers it on zeroed).
    // A clock cartridge without RAM keeps only its clock: that is its save, never blank.
    const ram = footerOf(sram) ? sram.subarray(0, -FOOTER) : sram;
    if (!k.lost && (k.rec ? same(k.rec.sram, sram) : ram.length > 0 && ram.every((x) => x === 0))) return null;
    const base = k.fork ?? k.rec ?? { id, gameId: id.split('~')[0], name, created: now };
    const to: StoredSave = { ...base, sram: sram.slice(), timestamp: now };
    this.known = { id: to.id, rec: to, mine: true };
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
