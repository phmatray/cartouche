import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { GameEntry } from '../../types/game';
import { fetchRom } from '../../hooks/useGameLibrary';
import { computeSha1 } from '../rom-utils';
import { owned } from '../ui';
import { toast } from '../../components/shell/actions';
import { t } from '../../i18n';
import { abortLockstep, endLockstep, lockstepBoot, lockstepLink, offerLockstep, useNet } from './session';
import { GB_FPS } from '../pace';
import { fromB64, Lockstep, rollbackDelay, toB64, WINDOW, type HashMsg, type LockMsg } from './lockstep';

type Emulator = import('gb-core').Emulator;
type Run = (other: Emulator, first: boolean) => Uint8ClampedArray | null;

/** Test knob: localStorage 'cartouche.netlink.desync' = '1' sends wrong hashes, to see the desync notice. */
const FAKE = (() => { try { return localStorage.getItem('cartouche.netlink.desync') === '1' ? 1 : 0; } catch { return 0; } })();
/** Test knob: localStorage 'cartouche.netlink.stats' = '1' keeps rollback counters in `globalThis.__rb`. */
const STATS = (() => { try { return localStorage.getItem('cartouche.netlink.stats') === '1'; } catch { return false; } })();
const HASH_EVERY = 60;
/** Rollback: both consoles' states before each frame run on a guess, with the buttons they held (WINDOW + 2 slots). */
interface Slot { f: number; states: [Uint8Array, Uint8Array]; held: [number, number] }
const RING = WINDOW + 2;
/** FNV-1a, as `state_hash` computes it over `save_state()`. */
function fnv(d: Uint8Array) {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
  return h >>> 0;
}

interface Live {
  seat: 1 | 2;
  lock: Lockstep;
  partner: Emulator;
  send: (m: LockMsg | HashMsg) => void;
  frame: number;
  sent: number;
  buttons: number; // what this player holds now
  held: [number, number]; // what each console holds (by player)
  ours: Map<number, number>;
  theirs: Map<number, number>;
  waitingSince: number;
  t0: number; // when frame 0 was due (performance.now), for the pace
  desync: boolean;
  ring: (Slot | undefined)[];
  wrong: number | null; // the earliest frame that ran on a wrong guess, to run again
  nextHash: number; // the next frame whose hash goes out, once every input before it is known
  rollbacks: number;
  rerun: number; // frames run again
}

/** Compares both browsers' hashes for frame `f` once both are known: false when they differ. */
function agree(l: Live, f: number) {
  const a = l.ours.get(f), b = l.theirs.get(f);
  if (a === undefined || b === undefined) return true;
  l.ours.delete(f);
  l.theirs.delete(f);
  return a === b;
}

/**
 * The player page's lockstep online link (both players hold both games, see lockstep.ts): offers it once the game
 * runs, then runs this player's console and the partner's side by side, with only the buttons crossing the network.
 * `power(save)` switches this player's console on again, from its battery save, the same way on both browsers.
 * While it runs, this player's buttons go to `press`/`release` (delayed and shared) instead of the console.
 */
export function useLockstep(opts: {
  core: RefObject<Emulator | null>; code: string | null; running: boolean; games: GameEntry[];
  rom: () => Uint8Array | null; save: () => Uint8Array | null; power: (save?: Uint8Array) => boolean;
  pressButton: (b: number, player?: number) => void; releaseButton: (b: number, player?: number) => void;
}) {
  const { code, running, pressButton, releaseButton } = opts;
  const o = useRef(opts);
  useEffect(() => { o.current = opts; });
  const mode = useNet((s) => s.mode);
  const live = useRef<Live | null>(null);
  const [active, setActive] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [desync, setDesync] = useState(false);

  // Offered once this player's game runs (its ROM and battery save are known): our game, the games we hold.
  const offered = useRef(false);
  useEffect(() => {
    if (!code || !running || offered.current) return;
    const rom = o.current.rom();
    if (!rom) return;
    offered.current = true;
    const have = o.current.games.filter((g) => owned(g) && g.sha1).map((g) => g.sha1!);
    const save = o.current.save();
    computeSha1(rom.slice()).then((g) => offerLockstep(g, [...new Set([...have, g])], save?.length ? toB64(save) : undefined));
  }, [code, running]);
  useEffect(() => () => endLockstep(), []);

  const stop = useCallback(() => {
    const l = live.current;
    live.current = null;
    lockstepLink(null);
    l?.partner.free();
    setActive(false);
  }, []);

  // Decided: both consoles start from their battery saves and the host's clock seed.
  useEffect(() => {
    if (mode !== 'lockstep') { if (live.current) stop(); return; }
    const boot = lockstepBoot();
    if (!boot || live.current) return;
    let gone = false;
    const seat: 1 | 2 = useNet.getState().me.host ? 1 : 2;
    const theirGame = boot.games[2 - seat];
    (async () => {
      const game = o.current.games.find((g) => owned(g) && g.sha1 === theirGame);
      const data = game && await fetchRom(game).catch(() => null);
      if (!data || await computeSha1(data.slice()) !== theirGame) throw new Error('partner ROM');
      const wasm = await import('gb-core');
      if (gone) return;
      const partner = new wasm.Emulator();
      const mine = boot.saves[seat - 1], theirs = boot.saves[2 - seat];
      if (!partner.load_rom(data) || !o.current.power(mine ? fromB64(mine) : undefined)) { partner.free(); throw new Error('power'); }
      if (theirs) partner.import_sram(fromB64(theirs));
      const core = o.current.core.current!;
      core.set_link_remote(false);
      core.set_cheats(''); // codes change memory on one side only
      core.set_emulated_clock(boot.seed);
      partner.set_emulated_clock(boot.seed);
      const l: Live = {
        seat, lock: new Lockstep(seat, rollbackDelay(boot.delay)), partner, send: () => {}, frame: 0, sent: -1, buttons: 0,
        held: [0, 0], ours: new Map(), theirs: new Map(), waitingSince: 0, t0: 0, desync: false,
        ring: [], wrong: null, nextHash: HASH_EVERY, rollbacks: 0, rerun: 0,
      };
      l.send = lockstepLink((m) => {
        if (m.t === 'i') { const w = l.lock.remote(m); if (w !== null && (l.wrong === null || w < l.wrong)) l.wrong = w; }
        else { l.theirs.set(m.f, m.x); if (!agree(l, m.f)) { l.desync = true; setDesync(true); } }
      });
      live.current = l;
      setActive(true);
      toast(t('online.mode.lockstep'), 'c');
    })().catch(() => { // both back to the byte mode
      if (gone) return;
      abortLockstep();
      toast(t('online.mode.abort', { p: 3 - seat }));
    });
    return () => { gone = true; };
  }, [mode, stop]);
  useEffect(() => stop, [stop]);

  /**
   * Instead of the console's own frame: runs the next frame of both consoles, on a guess of the partner's buttons when
   * they aren't here yet (rollback). A guess that proves wrong sends both consoles back to that frame, and every frame
   * since runs again, silently, before this one. More than WINDOW frames ahead of the partner's buttons, it waits.
   */
  const step = useCallback((run: Run) => {
    const l = live.current;
    if (!l || l.desync) return null;
    if (l.sent < l.frame) { l.send(l.lock.local(l.frame, l.buttons)); l.sent = l.frame; }
    const core = o.current.core.current!;
    const cores = l.seat === 1 ? [core, l.partner] : [l.partner, core];
    const hold = (pair: [number, number]) => {
      for (let p = 0; p < 2; p++) {
        for (let b = 0; b < 8; b++) {
          const bit = 1 << b, was = l.held[p] & bit, is = pair[p] & bit;
          if (!was && is) cores[p].press_button(b);
          else if (was && !is) cores[p].release_button(b);
        }
      }
      l.held = [pair[0], pair[1]];
    };
    const one = (f: number) => {
      const pair = l.lock.predict(f);
      // Kept while it may run again, and for a hash frame (hashed once every input before it is known).
      if (f > l.lock.confirmed() || f % HASH_EVERY === 0) l.ring[f % RING] = { f, states: [cores[0].save_state(), cores[1].save_state()], held: l.held };
      hold(pair);
      const fb = run(l.partner, l.seat === 1);
      l.partner.clear_audio_buffer(); // each browser plays its own console's sound
      return fb;
    };
    const fail = () => { l.desync = true; setDesync(true); return null; };

    if (l.wrong !== null) {
      const from = l.wrong, slot = l.ring[from % RING];
      l.wrong = null;
      if (slot?.f !== from) return fail(); // older than the ring: never within the window
      hold(slot.held); // before the states: a press's interrupt request is the state's to decide
      if (!cores[0].load_state(slot.states[0]) || !cores[1].load_state(slot.states[1])) return fail();
      for (let f = from; f < l.frame; f++) { one(f); core.clear_audio_buffer(); } // its sound was heard already
      l.rollbacks++;
      l.rerun += l.frame - from;
    }
    // Hashes on confirmed frames only: the state before frame f once every input before it is known.
    while (l.nextHash <= l.frame && l.nextHash - 1 <= l.lock.confirmed()) {
      const f = l.nextHash, slot = l.ring[f % RING];
      l.nextHash += HASH_EVERY;
      const x = (f === l.frame ? (cores[0].state_hash() ^ cores[1].state_hash()) >>> 0
        : slot?.f === f ? (fnv(slot.states[0]) ^ fnv(slot.states[1])) >>> 0 : 0) ^ FAKE;
      l.ours.set(f, x);
      l.send({ t: 'h', f, x });
      if (!agree(l, f)) return fail();
    }
    if (STATS) (globalThis as { __rb?: object }).__rb = { frame: l.frame, rollbacks: l.rollbacks, rerun: l.rerun };
    if (l.frame - l.lock.confirmed() > WINDOW) { l.waitingSince ||= performance.now(); return null; }
    l.waitingSince = 0;
    const fb = one(l.frame);
    l.frame++;
    return fb;
  }, []);

  // The wait, for the banner (the other console paused, slow or gone).
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => { const w = live.current?.waitingSince; setWaiting(w ? performance.now() - w : 0); }, 250);
    return () => clearInterval(i);
  }, [active]);

  /** This player's buttons: in step, they reach both consoles `delay` frames later (Super Game Boy players 2-4 aside). */
  const press = useCallback((b: number, p?: number) => { const l = live.current; if (l && !p) l.buttons |= 1 << b; else pressButton(b, p); }, [pressButton]);
  const release = useCallback((b: number, p?: number) => { const l = live.current; if (l && !p) l.buttons &= ~(1 << b); else releaseButton(b, p); }, [releaseButton]);
  /**
   * Frames to run now: the Game Boy's pace since the start, so frames a wait held back are made up (up to 4 a refresh)
   * and both consoles keep the same average speed. Half a second behind (a pause, a long wait), the pace starts over.
   */
  const due = useCallback((now: number) => {
    const l = live.current;
    if (!l) return 0;
    let n = Math.floor(((now - l.t0) / 1000) * GB_FPS) - l.frame;
    if (!l.t0 || n > 30) { l.t0 = now - (l.frame / GB_FPS) * 1000; n = 1; }
    return Math.max(0, Math.min(4, n));
  }, []);
  const frames = useCallback(() => live.current?.frame ?? 0, []);
  return { active, waiting, desync, step, due, press, release, frames };
}
