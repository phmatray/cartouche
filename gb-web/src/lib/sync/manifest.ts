/**
 * What each device has, and what one needs from the other. Pure: the planner sees two manifests and the
 * hashes both devices agreed on at their last sync ("base"), never the storage itself.
 *
 * Keys are the same on both devices: a game is its ROM's SHA-1 when there is one (the same cartridge can have
 * another id on the other device), else "@" + its id (bundled games).
 *   rom:<sha1>                 the ROM itself (only when both devices share ROMs)
 *   sram:<game>[~<profile>]    a battery save            } big: transferred in chunks,
 *   state:<game>#auto|#slot-N  a save state (+ picture)  } both edits kept on a conflict
 *   set:<setting>, set:gameDisplay/<game>, fav:<game>    small: value inline, last writer wins
 *   play:<game>                play time, sessions, last played: merged (the larger of each)
 */
export interface Entry {
  k: string;
  /** Content hash; '' for a deletion (small records only). */
  h: string;
  /** Last change, ms. */
  t: number;
  /** Bytes to transfer (big records). */
  n?: number;
  /** The value (small records). */
  v?: unknown;
  /** The battery save a save state belongs to, as `<game>[~<profile>]` (states only). */
  p?: string;
}
export interface Manifest {
  dev: string;
  name: string;
  /** This device shares its ROMs and takes the other's. */
  roms: boolean;
  /** SHA-1 → this device's game id, for games stored here under a ROM. */
  games: Record<string, string>;
  entries: Entry[];
}

/** A device's games ↔ the keys both devices share. */
export interface Games {
  /** local game id → shared game key */
  key: (id: string) => string;
  /** shared game key → local game id (null: a ROM this device doesn't know) */
  id: (g: string) => string | null;
}
/**
 * `alias`: SHA-1 → local id for games kept here without their ROM (a save that came from a device that has it).
 * They're keyed by the SHA-1 like there, never "@id": one record, one key on both devices.
 * A ROM stored twice here ("Add anyway": a second copy for separate saves): the first id (in sort order) takes the
 * SHA-1, every other copy is "@id", so each copy's records keep a key of their own.
 */
export function gamesOf(metas: { id: string; rom?: { sha1?: string } }[], alias: Record<string, string> = {}): Games {
  const sha = new Map<string, string>(), byId = new Map<string, string>();
  const withRom = metas.filter((m) => m.rom?.sha1).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of withRom) if (!byId.has(m.rom!.sha1!)) { sha.set(m.id, m.rom!.sha1!); byId.set(m.rom!.sha1!, m.id); }
  // A ROM that arrives by sync lands under its alias's id (importRom), so the saves kept there stay its own.
  // ponytail: one imported by hand under another id leaves the alias's saves keyed "@id"; re-key them if that shows up.
  for (const [s, id] of Object.entries(alias)) if (!byId.has(s) && !sha.has(id)) { sha.set(id, s); byId.set(s, id); }
  return {
    key: (id) => sha.get(id) ?? `@${id}`,
    id: (g) => (g.startsWith('@') ? g.slice(1) : byId.get(g) ?? null),
  };
}

export type Kind = 'rom' | 'sram' | 'state' | 'set' | 'fav' | 'play';
export const kindOf = (k: string) => k.slice(0, k.indexOf(':')) as Kind;
export const BIG: Kind[] = ['rom', 'sram', 'state'];
export const isBig = (k: string) => BIG.includes(kindOf(k));
/** The game a key belongs to ('' for global settings). */
export function gameOfKey(k: string): string {
  const rest = k.slice(k.indexOf(':') + 1);
  if (k.startsWith('set:')) return rest.startsWith('gameDisplay/') ? rest.slice(12) : '';
  return rest.replace(/[~#].*$/, '');
}

export interface Pull { k: string; dest: string; n: number; from: string }
export interface Conflict {
  k: string; copy: string | null; kept: 'local' | 'remote'; olderFrom: string; olderAt: number;
  /** A state's copy: the save it now belongs to (`<game>~s<hash>`), when its own save was the older side of a conflict too. */
  profile?: string;
}
export interface Play { time?: number; sessions?: number; last?: number }
export interface Plan {
  /** Fetch the other device's `k`, store it as `dest` here (`dest` ≠ `k`: it's the older side of a conflict). */
  pull: Pull[];
  /** Local records to copy aside first (`to` gets a renamed copy): the local side of a conflict was the older one. */
  moves: { from: string; to: string }[];
  /** Small values to write here (null: delete). */
  write: { k: string; v: unknown; t: number; h: string }[];
  conflicts: Conflict[];
}

const newer = (a: Entry, b: Entry) => a.t > b.t || (a.t === b.t && a.h > b.h);

/**
 * What `local` needs from `remote`. Deterministic: run on the other device with the two swapped, it makes the
 * same choices (the same copy keys and names), so both end up with the same records.
 */
export function plan(local: Manifest, remote: Manifest, base: Record<string, string>): Plan {
  const mine = new Map(local.entries.map((e) => [e.k, e]));
  const theirs = new Map(remote.entries.map((e) => [e.k, e]));
  const out: Plan = { pull: [], moves: [], write: [], conflicts: [] };
  const taken = new Set([...mine.keys(), ...theirs.keys()]);
  const keys = [...theirs.keys()].sort(); // 'sram:' before 'state:': a state's save conflict is known before the state's
  const olderSaves = new Map<string, { copy: string; remoteWins: boolean }>();
  for (const k of keys) {
    const r = theirs.get(k)!;
    const l = mine.get(k);
    const kind = kindOf(k);
    if (l && l.h === r.h) continue;
    if (kind === 'play') {
      const v = mergePlay(l?.v as Play | undefined, r.v as Play | undefined);
      if (JSON.stringify(v) !== JSON.stringify(l?.v ?? null)) out.write.push({ k, v, t: Math.max(l?.t ?? 0, r.t), h: '' });
      continue;
    }
    if (kind === 'set' || kind === 'fav') {
      if (!l || newer(r, l)) out.write.push({ k, v: r.h ? r.v : null, t: r.t, h: r.h });
      continue;
    }
    if (kind === 'rom') {
      if (!l && local.roms && remote.roms) out.pull.push({ k, dest: k, n: r.n ?? 0, from: r.h });
      continue;
    }
    // A battery save or a save state.
    if (!l || base[k] === l.h) { out.pull.push({ k, dest: k, n: r.n ?? 0, from: r.h }); continue; } // only theirs changed
    if (base[k] === r.h) continue; // only ours changed: they take it from us
    // Both changed since the last sync (or never synced): keep both. The newer keeps the name, the older becomes a copy.
    const remoteWins = newer(r, l);
    const older = remoteWins ? l : r;
    const copy = copyKey(k, older, taken);
    const olderFrom = remoteWins ? local.name : remote.name;
    const c: Conflict = { k, copy, kept: remoteWins ? 'remote' : 'local', olderFrom, olderAt: older.t };
    if (kind === 'sram' && copy) olderSaves.set(k.slice(5), { copy: copy.slice(5), remoteWins });
    // The older state goes with the older save of the same device: loading it never touches the newer one.
    const save = kind === 'state' && older.p ? olderSaves.get(older.p) : undefined;
    if (save && save.remoteWins === remoteWins) c.profile = save.copy;
    out.conflicts.push(c);
    if (!copy) continue; // no free slot: both left as they are, the player is told
    taken.add(copy);
    if (remoteWins) {
      out.moves.push({ from: k, to: copy });
      out.pull.push({ k, dest: k, n: r.n ?? 0, from: r.h });
    } else {
      out.pull.push({ k, dest: copy, n: r.n ?? 0, from: r.h });
    }
  }
  return out;
}

export const SLOTS = 5;
/** Where the older side of a conflict goes: a new save of the game (named after its hash), or the first slot free on both devices. */
function copyKey(k: string, older: Entry, taken: Set<string>): string | null {
  const game = gameOfKey(k);
  if (kindOf(k) === 'sram') return `sram:${game}~s${older.h.slice(0, 8)}`;
  for (let i = 0; i < SLOTS; i++) if (!taken.has(`state:${game}#slot-${i}`)) return `state:${game}#slot-${i}`;
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The name of a save kept aside: "Main (iPhone, 27 Sep)", 40 characters at most. The same on both devices (UTC). */
export function copyName(name: string, from: string, at: number): string {
  const d = new Date(at);
  const tail = ` (${from.slice(0, 14)}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]})`;
  return name.slice(0, 40 - tail.length).trimEnd() + tail;
}

export function mergePlay(a: Play | undefined, b: Play | undefined): Play {
  const max = (x?: number, y?: number) => (x == null ? y : y == null ? x : Math.max(x, y));
  const out: Play = {};
  for (const f of ['time', 'sessions', 'last'] as const) { const v = max(a?.[f], b?.[f]); if (v != null) out[f] = v; }
  return out;
}

/**
 * Hashes both devices hold for each key once a sync went through: what `local` pulled, what the other device
 * pulled from us (`theirPulls`), and what was already the same. The next sync compares against these.
 */
export function agreed(local: Manifest, remote: Manifest, mine: Plan, theirPulls: Pull[]): Record<string, string> {
  const l = new Map(local.entries.map((e) => [e.k, e.h]));
  const r = new Map(remote.entries.map((e) => [e.k, e.h]));
  const out: Record<string, string> = {};
  for (const [k, h] of l) if (r.get(k) === h && isBig(k)) out[k] = h;
  for (const p of mine.pull) if (p.dest === p.k) out[p.k] = p.from;
  for (const p of theirPulls) if (p.dest === p.k) out[p.k] = l.get(p.k) ?? p.from;
  return out;
}

/** Sizes, for the progress bar and the ROM estimate. */
export const total = (pulls: Pull[]) => pulls.reduce((a, p) => a + p.n, 0);
