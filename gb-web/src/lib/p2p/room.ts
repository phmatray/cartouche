/**
 * Browser-to-browser rooms over WebRTC, with no server of ours (used by the online link cable; meant for
 * device sync too). Trystero finds the other browsers through public Nostr relays: they only carry the
 * connection handshake, encrypted with the room code. Then every message goes straight from one browser to
 * the other on WebRTC's ordered, reliable data channel.
 *
 * NAT traversal uses public STUN servers only. Without a TURN relay some pairs of networks (strict NATs,
 * many mobile carriers and office networks) can't connect at all: the player can add their own TURN server.
 *
 * Trystero is loaded on first use, so the library never pays for it.
 */
import { useSyncExternalStore } from 'react';
import type { DataPayload, JsonValue, Room } from 'trystero';

export type { DataPayload, JsonValue };

export interface TurnServer { urls: string; username: string; credential: string }
const TURN_KEY = 'cartouche.p2p.turn';

/** The player's own TURN server (Play online › Connection settings), if any. */
export function loadTurn(): TurnServer | null {
  try {
    const t = JSON.parse(localStorage.getItem(TURN_KEY) ?? 'null') as TurnServer | null;
    return t?.urls ? t : null;
  } catch { return null; }
}
export function saveTurn(t: TurnServer | null) {
  try {
    if (t?.urls.trim()) localStorage.setItem(TURN_KEY, JSON.stringify({ ...t, urls: t.urls.trim() }));
    else localStorage.removeItem(TURN_KEY);
  } catch { /* storage blocked: kept for this visit only */ }
}
/**
 * The Nostr relays that introduce the players: the ones Trystero picks for our app id, minus one that turns every
 * connection away (a redirect, retried all session long in the console) and one that doesn't answer.
 */
// ponytail: a fixed list (probed 2026-09); if relays die, re-probe Trystero's defaultRelayUrls and swap them here.
const RELAYS = ['relay02.lnfi.network', 'staging.yabu.me', 'top.testrelay.top', 'yabu.me/v2', 'relay.mostro.network'].map((h) => `wss://${h}`);
/** Alone this long, the room is joined again from scratch: three announces, time for a returning player's handshake. */
const ALONE_MS = 16000;

/** turn:/turns: URLs, comma or space separated. */
export const validTurn = (urls: string) => urls.split(/[\s,]+/).filter(Boolean).every((u) => /^turns?:[^\s]+$/.test(u));

const onNet = (cb: () => void) => {
  addEventListener('online', cb);
  addEventListener('offline', cb);
  return () => { removeEventListener('online', cb); removeEventListener('offline', cb); };
};
/** False while the device has no network: a room then can't reach the relays, nor anyone (rooms rejoin on 'online'). */
export const useOnline = () => useSyncExternalStore(onNet, () => navigator.onLine);

export interface P2PRoom<M extends DataPayload> {
  readonly code: string;
  readonly selfId: string;
  /** The peers connected right now, in the order they arrived. */
  readonly peers: string[];
  /**
   * To every peer, or to one. Dropped while nobody is connected (callers resend what matters on join).
   * Resolves once handed to the data channel, which waits while its buffer is full: awaiting it paces a big transfer.
   */
  send(msg: M, to?: string): Promise<void>;
  onMessage: ((msg: M, from: string) => void) | null;
  onJoin: ((peer: string) => void) | null;
  onLeave: ((peer: string) => void) | null;
  /** The other browser has another password (`password`), or no direct route was found (`connect`: TURN needed). */
  onError: ((kind: 'password' | 'connect') => void) | null;
  /**
   * Starts over with a fresh join: the caller found a peer silent that WebRTC still lists (Trystero would ignore
   * that peer coming back until its dead connection closes).
   */
  rejoin(): void;
  /** Round trip to a peer in ms, null if it doesn't answer. */
  ping(peer: string): Promise<number | null>;
  leave(): void;
}

/**
 * Joins room `code` of app `app` (the code is also the key that encrypts the handshake). Trystero announces
 * the room every 5 s, so a player who reloads is found again by the room as it is: tearing it down right then
 * would drop their handshake halfway. Only after a while alone is the room joined again from scratch (relays
 * drop idle subscriptions, networks change), and whenever the browser comes back online or to the foreground.
 */
export async function joinRoom<M extends DataPayload>(app: string, code: string): Promise<P2PRoom<M>> {
  const trystero = await import('trystero');
  const turn = loadTurn();
  let room: Room | null = null;
  let send: ((m: M, to?: string) => Promise<void>) | null = null;
  let left = false;
  let retry = 0;
  const peers: string[] = [];

  const api: P2PRoom<M> = {
    code,
    selfId: trystero.selfId,
    peers,
    send: (m, to) => (peers.length && send ? send(m, to) : Promise.resolve()),
    onMessage: null, onJoin: null, onLeave: null, onError: null,
    ping: (peer) => (room ? Promise.race([room.ping(peer), new Promise<null>((r) => setTimeout(() => r(null), 4000))]).catch(() => null) : Promise.resolve(null)),
    rejoin: () => { peers.length = 0; schedule(0); },
    leave: () => {
      left = true;
      clearTimeout(retry);
      removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      room?.leave().catch(() => {});
      room = null;
      peers.length = 0;
    },
  };

  const connect = async () => {
    // Trystero hands back the same instance for a room still open: the old one must be gone first.
    const old = room;
    room = null;
    await old?.leave().catch(() => {});
    if (left) return;
    const r = trystero.joinRoom({
      appId: app,
      password: `${app}:${code}`,
      turnConfig: turn ? [{ urls: turn.urls.split(/[\s,]+/).filter(Boolean), username: turn.username, credential: turn.credential }] : undefined,
      relayConfig: { urls: RELAYS, warnOnRelayFailure: false },
    }, code, {
      onJoinError: (e) => api.onError?.(/password/i.test(e.error) ? 'password' : 'connect'),
    });
    const action = r.makeAction<DataPayload>('m');
    action.onMessage = (m, { peerId }) => api.onMessage?.(m as M, peerId);
    send = (m, to) => action.send(m, to ? { target: to } : undefined).then(() => {}, () => {});
    r.onPeerJoin = (id) => {
      clearTimeout(retry);
      if (!peers.includes(id)) peers.push(id);
      api.onJoin?.(id);
    };
    r.onPeerLeave = (id) => {
      const i = peers.indexOf(id);
      if (i < 0) return;
      peers.splice(i, 1);
      api.onLeave?.(id);
      if (!peers.length) schedule(ALONE_MS);
    };
    room = r;
  };
  // Nobody here: announce again from a fresh join now and then (relays drop idle subscriptions, networks change).
  const schedule = (ms: number) => {
    clearTimeout(retry);
    retry = window.setTimeout(() => {
      if (left || peers.length) return;
      connect().catch(() => {});
      schedule(ALONE_MS);
    }, ms);
  };
  const wake = () => { if (!left && !peers.length && document.visibilityState === 'visible') schedule(0); };
  addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  await connect();
  return api;
}
