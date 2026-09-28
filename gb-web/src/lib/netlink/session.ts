/**
 * The online link cable session: one room, two players, kept across the lobby and the player page
 * (a module-level singleton; React reads it through `useNet`).
 */
import { create } from 'zustand';
import { joinRoom, type P2PRoom } from '../p2p/room';
import { makeCode } from '../p2p/code';
import { isLinkMsg, SerialBridge, type LinkCore, type LinkMsg } from './bridge';

/** What each player tells the other about themselves. */
export type Seat = {
  host: boolean;
  game: { title: string; platform?: string } | null;
  ready: boolean;
  /** In the game (the player page runs with the cable plugged in). */
  playing: boolean;
  /** Paused or in the background: its console isn't running, so the other one may wait. */
  paused: boolean;
};
type Msg = { t: 'hi'; v: 1; seat: Seat } | { t: 'bye' } | { t: 'full' } | LinkMsg;

/** idle: no room · joining · alone: waiting for the other player · linked · lost: the connection dropped, coming back · full */
export type Phase = 'idle' | 'joining' | 'alone' | 'linked' | 'lost' | 'full';

export interface NetState {
  code: string | null;
  phase: Phase;
  /** relays: couldn't reach the matchmaking relays · connect: found the other player, no direct route · password: codes differ */
  error: 'relays' | 'connect' | 'password' | null;
  me: Seat;
  peer: Seat | null;
  /** The other player left on purpose (closed the room). */
  peerLeft: boolean;
  ping: number | null;
}

const APP = 'cartouche-link-v1';
/** The host is Player 1: the other player's number. */
export const other = (host: boolean) => (host ? 2 : 1);
const seat = (host = false): Seat => ({ host, game: null, ready: false, playing: false, paused: false });
const idle = (): NetState => ({ code: null, phase: 'idle', error: null, me: seat(), peer: null, peerLeft: false, ping: null });
export const useNet = create<NetState>(idle);
const set = (s: Partial<NetState>) => useNet.setState(s);

let room: P2PRoom<Msg> | null = null;
let partner: string | null = null;
let bridge: SerialBridge | null = null;
let resume: (() => void) | null = null;
let pinger = 0;
let joining: Promise<void> | null = null;

// Test knob: localStorage 'cartouche.netlink.delay' = ms added to everything this browser sends (round trip +2×).
// The lobby's ping comes from Trystero and ignores it; the in-game bytes/s and wait share don't.
const DELAY = (() => { try { return Math.max(0, +(localStorage.getItem('cartouche.netlink.delay') ?? 0) || 0); } catch { return 0; } })();
const toPartner = (m: Msg) => {
  if (!room || !partner) return;
  const r = room, p = partner;
  if (DELAY) setTimeout(() => r.send(m, p), DELAY); else r.send(m, p);
};
const hello = () => toPartner({ t: 'hi', v: 1, seat: useNet.getState().me });

/** What the other browser says about itself, kept to the fields and types we use (anything else is dropped). */
function seatOf(x: unknown): Seat | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as Record<string, unknown>, g = s.game as Record<string, unknown> | null | undefined;
  if (typeof s.host !== 'boolean') return null;
  return {
    host: s.host,
    game: g && typeof g.title === 'string' ? { title: g.title.slice(0, 100), platform: typeof g.platform === 'string' ? g.platform : undefined } : null,
    ready: s.ready === true, playing: s.playing === true, paused: s.paused === true,
  };
}

// Which room this tab hosts, so a reload keeps the seats (Player 1 stays Player 1). Per tab, never shared by a link.
const SEAT_KEY = 'cartouche.netlink.hosted';
const hosted = (code: string) => { try { return sessionStorage.getItem(SEAT_KEY) === code; } catch { return false; } };
function remember(code: string, host: boolean) {
  try { if (host) sessionStorage.setItem(SEAT_KEY, code); else if (hosted(code)) sessionStorage.removeItem(SEAT_KEY); } catch { /* storage blocked */ }
}
// Closing or reloading the page: say so (best effort), so the other player sees "left" rather than a lost line.
if (typeof window !== 'undefined') addEventListener('pagehide', () => { if (room && partner) room.send({ t: 'bye' }, partner); });

/** Opens a new room (no code: this player hosts it) or joins an existing one. Joining the open room again is a no-op. */
export function openRoom(code?: string): Promise<void> {
  const s = useNet.getState();
  if (code && s.code === code && s.phase !== 'idle') return joining ?? Promise.resolve();
  closeRoom();
  const c = code ?? makeCode();
  const host = !code || hosted(c);
  remember(c, host);
  set({ ...idle(), code: c, phase: 'joining', me: seat(host) });
  joining = joinRoom<Msg>(APP, c).then((r) => {
    if (useNet.getState().code !== c) { r.leave(); return; }
    room = r;
    set({ phase: 'alone' });
    const adopt = (id: string) => {
      partner = id;
      heard.set(id, Date.now());
      set({ phase: 'linked', peerLeft: false, error: null });
      hello();
      measure();
    };
    // A newcomer while ours has missed a heartbeat (a reload, a dead connection WebRTC hasn't noticed yet): the
    // newcomer is ours now, almost always the same player back. While ours is still talking, the newcomer waits
    // out the silence window: then the room is full, unless ours has gone quiet meanwhile.
    r.onJoin = (id) => {
      if (!partner || partner === id || !talking(partner)) { adopt(id); return; }
      setTimeout(() => {
        if (room !== r || partner === id || !r.peers.includes(id)) return;
        if (partner && alive(partner)) r.send({ t: 'full' }, id);
        else adopt(id);
      }, SILENT_MS);
    };
    r.onLeave = (id) => { if (id === partner) drop(); };
    const drop = () => {
      const gone = partner;
      const next = r.peers.find((p) => p !== gone); // someone else on the line: most likely ours, back from a reload
      partner = null;
      if (next) { adopt(next); return; }
      // WebRTC still lists the silent one: start over, or Trystero would ignore it coming back. Otherwise the room
      // keeps announcing itself, and a returning player (a reload: a new peer) is found as it is.
      if (gone && r.peers.includes(gone)) r.rejoin();
      const left = useNet.getState().peerLeft;
      set({ phase: left ? 'alone' : 'lost', ping: null, ...(left ? { peer: null } : {}) });
    };
    let unreached = 0;
    heartbeat = () => {
      if (partner && !alive(partner)) drop();
      // No relay reachable (a firewall, a network that blocks them): nobody can find the room. Said after a few
      // tries rather than "waiting" forever, and taken back once one answers.
      if (!partner) {
        unreached = r.relays() ? 0 : unreached + 1;
        const { error } = useNet.getState();
        if (unreached >= RELAY_TRIES && !error) set({ error: 'relays' });
        else if (!unreached && error === 'relays') set({ error: null });
      }
      hello(); // doubles as the heartbeat
      measure();
    };
    r.onError = (error) => set({ error });
    r.onMessage = (raw, from) => {
      const m = valid(raw);
      if (!m) return;
      heard.set(from, Date.now());
      if (m.t === 'full') { if (!partner || from === partner) set({ phase: 'full' }); return; }
      if (!partner && m.t !== 'bye' && r.peers.includes(from)) adopt(from); // a connection that came back to life
      if (from !== partner) return;
      if (m.t === 'hi') {
        set({ peer: m.seat });
        // Both think they host (or both joined, after reloads): the lower peer id is Player 1.
        const me = useNet.getState().me;
        if (m.seat.host === me.host && (r.selfId < from) !== me.host) setSeat({ host: r.selfId < from });
        // Its console may have been waiting on us across a reconnection or a reload: ask again.
        if (m.seat.playing) bridge?.resend();
      } else if (m.t === 'bye') {
        // Gone on purpose (or reloading: then it comes back as a new peer, and is adopted).
        heard.delete(from);
        partner = null;
        set({ phase: 'alone', peer: null, peerLeft: true, ping: null });
      }
      else {
        bridge?.receive(m);
        if (m.t === 'r') resume?.();
      }
    };
    pinger = window.setInterval(() => heartbeat(), 2000);
  }).catch(() => set({ phase: 'idle', error: 'relays' }))
    .finally(() => { joining = null; });
  return joining;
}

/** A message from the other browser, checked (and its seat cleaned up), or null. */
function valid(raw: unknown): Msg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { t?: unknown; seat?: unknown };
  if (m.t === 'bye' || m.t === 'full') return m as Msg;
  if (m.t === 'hi') { const seat = seatOf(m.seat); return seat && { t: 'hi', v: 1, seat }; }
  return isLinkMsg(m) ? m : null;
}

/** Last message from each peer (the heartbeat keeps it fresh); silent this long, a peer counts as gone. */
const heard = new Map<string, number>();
const SILENT_MS = 6000;
const alive = (id: string) => Date.now() - (heard.get(id) ?? 0) < SILENT_MS;
/** Heard within the last heartbeat (every 2 s) and a half. */
const talking = (id: string) => Date.now() - (heard.get(id) ?? 0) < 3000;
let heartbeat = () => {};
/** Heartbeats (2 s apart) without a single relay connected before the lobby says so. */
const RELAY_TRIES = 4;

function measure() {
  if (!room || !partner) return;
  const p = partner;
  room.ping(p).then((ms) => { if (p === partner) set({ ping: ms === null ? null : Math.round(ms) }); });
}

/** Leaves the room, telling the other player (who then sees the room closed rather than a lost connection). */
export function closeRoom() {
  clearTimeout(release.timer);
  if (room) { toPartner({ t: 'bye' }); const r = room; setTimeout(() => r.leave(), 300); }
  clearInterval(pinger);
  heartbeat = () => {};
  heard.clear();
  room = null;
  partner = null;
  set(idle());
}

/** Changes what we tell the other player. */
export function setSeat(s: Partial<Seat>) {
  const { me: was, code } = useNet.getState();
  const me = { ...was, ...s };
  if (code && s.host !== undefined) remember(code, s.host);
  set({ me });
  hello();
}

/** Keeps the room open while a page uses it; the last page to let go closes it (a few seconds later, so the lobby can hand it to the player page). */
let holders = 0;
export function hold() {
  holders++;
  clearTimeout(release.timer);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holders === 0) release.timer = window.setTimeout(closeRoom, 5000);
  };
}
const release = { timer: 0 };

/**
 * Plugs a console into the cable. Call `pump` after every frame; `unplug` when the page closes. `onReply` runs when
 * the answer to our stalled transfer arrives: finishing the frame right then (instead of at the next display
 * refresh) lets several bytes cross within one frame when the line is fast.
 */
export function plug(core: LinkCore, onReply: () => void) {
  const b = new SerialBridge(core, toPartner);
  bridge = b;
  resume = onReply;
  return {
    bridge: b,
    pump: () => b.pump(),
    unplug: () => { if (bridge === b) { bridge = null; resume = null; } },
  };
}
