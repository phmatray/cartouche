/**
 * Device sync: pairing, and syncing with each paired device whenever both have the app open.
 * One WebRTC room per paired device (lib/p2p/room), named after its secret; every message is sealed with
 * AES-GCM (crypto.ts) and nothing is trusted before the other device has answered our challenge.
 *
 * A sync ("round"): one device sends its manifest, the other answers with its own; each works out what it needs
 * (manifest.ts), copies aside its older side of any conflict, writes the small records, then asks for the big ones
 * with the offset it already has of each (so an interrupted transfer resumes), and says "done" when all landed.
 * When both said so, both remember the hashes they now share: the next sync tells what changed where.
 *
 * Loaded on first use (the Sync settings, or the app starting with auto-sync on).
 */
import { joinRoom, type DataPayload, type P2PRoom } from '../p2p/room';
import { codeToSecret, concat, deriveKeys, open, prove, randomBytes, rekey, seal, secretToCode, verify, type Keys, type Msg } from './crypto';
import { agreed, gameOfKey, plan, total, type Conflict, type Games, type Manifest, type Plan, type Pull } from './manifest';
import { addPart, currentHash, dropParts, dropRecord, loadRecord, localGames, moveAside, partKey, partsOf, readLocal, rememberAlias, rememberGone, storeRecord, writeSmall, type Snapshot } from './local';
import { IDLE, linkOf, setDevice, setLink, useSync, type Device, type LinkState, type Note, type SyncReport } from './status';
import { refreshSavedIds, reloadLibrary } from '../../hooks/useGameLibrary';
import { toast } from '../../components/shell/actions';
import { t } from '../../i18n';
import { inUse } from '../play-lock';

const APP = 'cartouche-sync-v1';
const CHUNK = 192 * 1024;
/** Auto-sync: again every few minutes while both stay open. */
const AGAIN_MS = 3 * 60_000;
// Test knob: localStorage 'cartouche.sync.throttle' = ms to wait between the chunks this browser sends.
const THROTTLE = (() => { try { return Math.max(0, +(localStorage.getItem('cartouche.sync.throttle') ?? 0) || 0); } catch { return 0; } })();

const bytesOf = (m: DataPayload): Uint8Array | null =>
  m instanceof Uint8Array ? m : m instanceof ArrayBuffer ? new Uint8Array(m) : ArrayBuffer.isView(m) ? new Uint8Array(m.buffer, m.byteOffset, m.byteLength) : null;
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const running = () => { const m = /\/game\/([^/]+)\/play/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; };
/** On the link cable pages (same screen or online), any game may be running: no save is touched there. */
const onLinkCable = () => /\/link-cable(\/|$)/.test(location.pathname);
interface Busy { games: string[]; link: boolean }
/** What runs in this tab or any other of this browser (lib/play-lock). */
async function busyNow(): Promise<Busy> {
  const all = await inUse();
  const here = running();
  return { games: here ? [here, ...all.games] : all.games, link: all.link || onLinkCable() };
}
/** A save or state a running emulator would write over (checked when planning, and again when it lands). */
const inPlay = (k: string, games: Games, busy: Busy) => /^(sram|state):/.test(k) && (busy.link || busy.games.some((id) => gameOfKey(k) === games.key(id)));
/** A round that ended with items missing is tried again this soon (a few times), auto-sync or not. */
const RETRY_MS = 15_000;
/** Alone this long with the room open: rejoin it. */
const REJOIN_MS = 16_000;

interface Peer { nonce: Uint8Array; theirs?: Uint8Array; dev?: string; name?: string; verified?: boolean; ok?: boolean }

interface Round {
  r: string;
  snap: Snapshot;
  theirs?: Manifest;
  plan?: Plan;
  /** Big records still to arrive, by key. */
  pending: Map<string, Pull & { t: number; prefix: string; got: Uint8Array[]; size: number }>;
  failed: string[];
  theirPulls?: Pull[];
  theirFailed?: string[];
  iDone: boolean;
  theyDone: boolean;
  got: number;
  sent: number;
  notes: SyncReport['notes'];
  changed: boolean;
}

/** One room: a paired device (sync), or a pairing in progress. */
class Link {
  room: P2PRoom<Uint8Array> | null = null;
  keys!: Keys;
  peers = new Map<string, Peer>();
  /** The Trystero peer that proved it holds the secret. */
  active: string | null = null;
  round: Round | null = null;
  queue: Promise<void> = Promise.resolve();
  closed = false;
  timer = 0;
  retry = 0;
  watch = 0;
  /** When a peer last arrived. */
  joined = 0;
  starting = false;
  /** This device starts the rounds (the smaller id). */
  lead = false;
  retries = 0;
  secret: Uint8Array;
  deviceId: string | null;
  onPaired?: (dev: string, name: string, secret: Uint8Array) => void;

  constructor(secret: Uint8Array, deviceId: string | null) {
    this.secret = secret;
    this.deviceId = deviceId;
  }

  get device(): Device | undefined { return useSync.getState().devices.find((d) => d.id === this.deviceId); }
  get pairing() { return this.deviceId === null; }

  async start() {
    this.keys = await deriveKeys(this.secret);
    if (this.closed) return;
    const room = await joinRoom<Uint8Array>(APP, this.keys.room);
    if (this.closed) { room.leave(); return; }
    this.room = room;
    room.onJoin = (id) => this.hello(id);
    room.onLeave = (id) => this.gone(id);
    // 'password' can't happen here (the room's password comes from the same secret): any error is "no route".
    room.onError = () => { if (this.deviceId) setLink(this.deviceId, { error: 'connect' }); else pairState({ error: 'connect' }); };
    // Nobody proved themselves for a while (the other device reloaded and its new connection never came up):
    // join again from scratch. Not while a handshake is under way.
    this.watch = window.setInterval(() => { if (!this.active && Date.now() - this.joined > REJOIN_MS) this.room?.rejoin(); }, REJOIN_MS);
    room.onMessage = (m, from) => {
      const b = bytesOf(m);
      if (b) this.queue = this.queue.then(() => this.receive(b, from)).catch((e) => console.warn('sync:', e));
    };
    for (const id of room.peers) this.hello(id);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    clearInterval(this.watch);
    this.room?.leave();
    this.room = null;
    if (this.deviceId && this.round) this.interrupt();
  }

  send(msg: Msg, to = this.active): Promise<void> {
    const room = this.room;
    if (!room || !to) return Promise.resolve();
    return seal(this.keys, msg).then((b) => room.send(b, to));
  }

  hello(id: string) {
    this.joined = Date.now();
    const p: Peer = { nonce: randomBytes(16) };
    this.peers.set(id, p);
    const me = useSync.getState().me;
    this.send({ t: 'hello', v: 1, dev: me.id, name: me.name, nonce: p.nonce }, id);
  }

  gone(id: string) {
    this.peers.delete(id);
    if (id !== this.active) return;
    this.active = null;
    clearInterval(this.timer);
    if (this.deviceId) {
      if (this.round) this.interrupt();
      else setLink(this.deviceId, { phase: 'offline' });
    }
  }

  interrupt() {
    this.round = null;
    if (this.deviceId) setLink(this.deviceId, { phase: 'interrupted' });
  }

  async receive(bytes: Uint8Array, from: string) {
    const m = await open(this.keys, bytes);
    const p = this.peers.get(from);
    if (!m || !p) return; // not sealed with our secret: ignored
    const me = useSync.getState().me;
    if (m.t === 'hello' && m.nonce instanceof Uint8Array && typeof m.dev === 'string') {
      if (m.dev === me.id) return; // this browser's own other tab
      p.theirs = m.nonce; p.dev = m.dev; p.name = str(m.name).slice(0, 40) || t('sync.otherDevice');
      if (this.pairing && !this.active) pairState({ phase: 'found', peer: p.name });
      await this.send({ t: 'proof', mac: await prove(this.keys, m.nonce, p.nonce, me.id) }, from);
      return;
    }
    if (m.t === 'proof' && m.mac instanceof Uint8Array && p.theirs && p.dev) {
      if (this.deviceId && p.dev !== this.deviceId) return; // the secret is this device's; another one holding it isn't welcome
      p.verified = await verify(this.keys, m.mac, p.nonce, p.theirs, p.dev);
      if (p.verified) await this.send({ t: 'ok' }, from);
      if (p.verified && p.ok) await this.authed(from, p);
      return;
    }
    if (m.t === 'ok') { p.ok = true; if (p.verified) await this.authed(from, p); return; }
    if (from !== this.active) return; // everything else only from the device that proved itself
    await this.handle(m);
  }

  /** Both proved they hold the secret. */
  async authed(id: string, p: Peer) {
    if (this.pairing) {
      if (this.active) return; // first come
      this.active = id;
      const next = await rekey(this.secret, p.nonce, p.theirs!);
      this.onPaired?.(p.dev!, p.name!, next);
      return;
    }
    this.active = id;
    if (p.name && p.name !== this.device?.name) setDevice(this.deviceId!, { name: p.name });
    setLink(this.deviceId!, { phase: 'online', error: undefined });
    clearInterval(this.timer);
    // The device with the smaller id starts, on arrival and then now and then (auto-sync only).
    const lead = this.lead = useSync.getState().me.id < p.dev!;
    this.retries = 0;
    if (lead) this.begin();
    this.timer = window.setInterval(() => { if (lead && useSync.getState().auto && !this.round) this.begin(); }, AGAIN_MS);
  }

  /* ---------- a sync round ---------- */

  snapshot(): Promise<Snapshot> {
    const s = useSync.getState();
    return readLocal(s.me, s.roms);
  }

  async begin() {
    if (!this.active || !this.deviceId || this.round || this.starting) return;
    this.starting = true;
    const r = Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, '0')).join('');
    const snap = await this.snapshot().finally(() => { this.starting = false; });
    if (this.round || !this.active) return;
    this.round = this.newRound(r, snap);
    setLink(this.deviceId, { phase: 'syncing', got: 0, want: 0, sent: 0, give: 0, error: undefined });
    await this.send({ t: 'man', r, reply: true, m: this.round.snap.manifest as unknown as Msg });
  }

  newRound(r: string, snap: Snapshot): Round {
    return { r, snap, pending: new Map(), failed: [], iDone: false, theyDone: false, got: 0, sent: 0, notes: [], changed: false };
  }

  async handle(m: Msg) {
    const id = this.deviceId!;
    if (m.t === 'unpair') { const name = this.device?.name ?? t('sync.otherDevice'); removeDevice(id, false); toast(t('sync.toast.unpairedBy', { name }), 'm'); return; }
    if (m.t === 'man' && m.m && typeof m.r === 'string') {
      const theirs = m.m as unknown as Manifest;
      if (!Array.isArray(theirs.entries)) return;
      if (m.reply) {
        // Both started at once: the smaller round id goes on, the other gives way.
        if (this.round && (this.round.theirs || this.round.r < m.r)) return;
        this.round = this.newRound(m.r, await this.snapshot());
        setLink(id, { phase: 'syncing', got: 0, want: 0, sent: 0, give: 0, error: undefined });
        await this.send({ t: 'man', r: m.r, reply: false, m: this.round.snap.manifest as unknown as Msg });
      }
      if (!this.round || this.round.r !== m.r) return;
      await this.planRound(this.round, theirs);
      return;
    }
    const round = this.round;
    if (!round || m.r !== round.r) return;
    if (m.t === 'want' && Array.isArray(m.items)) {
      round.theirPulls = m.items as Pull[];
      setLink(id, { give: total(round.theirPulls) });
      this.serve(round, m.items as (Pull & { off: number })[]);
    } else if (m.t === 'chunk' && m.data instanceof Uint8Array && typeof m.k === 'string') {
      await this.chunk(round, m.k, Number(m.off), Number(m.total), m.data);
    } else if (m.t === 'missing' && typeof m.k === 'string') {
      const p = round.pending.get(m.k);
      if (p) { round.pending.delete(m.k); round.failed.push(p.k); await this.maybeDone(round); } // p.k: what maybeFinish leaves out of the base
    } else if (m.t === 'done') {
      round.theyDone = true;
      round.theirFailed = Array.isArray(m.failed) ? m.failed.map(String) : [];
      await this.maybeFinish(round);
    }
  }

  async planRound(round: Round, theirs: Manifest) {
    const dev = this.device;
    if (!dev) return;
    round.theirs = theirs;
    // Their game ids for the ROMs this device lacks: a save of one is stored under it, and keyed by the ROM's SHA-1 from then on.
    if (theirs.games && typeof theirs.games === 'object') rememberAlias(theirs.games);
    const mine = round.snap.manifest;
    const p = plan(mine, theirs, dev.base ?? {});
    // A game being played keeps its saves as they are: the running emulator would write over them.
    const games = round.snap.games;
    const busy = await busyNow();
    const keep = (k: string) => !inPlay(k, games, busy);
    const keepDrop = (k: string) => keep(k.startsWith('rom:') ? `sram:${k.slice(4)}` : k); // a ROM goes with its game's saves
    const blocked = [...p.pull.map((x) => x.k), ...p.moves.map((x) => x.from)].filter((k) => !keep(k)).concat(p.drop.filter((k) => !keepDrop(k)));
    if (blocked.length) {
      const playing = busy.link ? undefined : busy.games.find((id) => blocked.some((k) => gameOfKey(k) === games.key(id)));
      round.notes.push(playing ? { game: playing, key: 'running' } : { key: 'linkBusy' });
    }
    p.pull = p.pull.filter((x) => keep(x.k));
    p.moves = p.moves.filter((x) => keep(x.from));
    p.conflicts = p.conflicts.filter((x) => keep(x.k));
    p.drop = p.drop.filter(keepDrop);
    round.plan = p;
    for (const c of p.conflicts) round.notes.push(conflictNote(c, games));
    for (const mv of p.moves) {
      const c = p.conflicts.find((x) => x.k === mv.from)!;
      // Changed since the snapshot (a game saved meanwhile): not moved; its pull fails the same check when it lands.
      if ((await currentHash(mv.from, games)) !== this.planned(round, mv.from)) continue;
      await moveAside(mv.from, mv.to, games, { from: c.olderFrom, at: c.olderAt, profile: c.profile });
      round.changed = true;
    }
    // Deleted over there after it last changed here: deleted here too (unless it changed since the snapshot).
    for (const k of p.drop) {
      if ((await currentHash(k, games)) !== this.planned(round, k) && !k.startsWith('rom:')) continue;
      await dropRecord(k, games);
      round.got++; round.changed = true;
    }
    rememberGone(p.gone, games);
    for (const w of p.write) { await writeSmall(w.k, w.v, w.t, await localGames()); round.got++; round.changed = true; }
    // What already arrived of each (an interrupted transfer picks up from there).
    const theirT = new Map(theirs.entries.map((e) => [e.k, e.t]));
    const items: (Pull & { off: number })[] = [];
    let resumed = 0;
    for (const x of p.pull.sort((a, b) => (a.k.startsWith('rom:') ? 0 : 1) - (b.k.startsWith('rom:') ? 0 : 1))) { // ROMs first: saves then find their game
      const t = theirT.get(x.k) ?? 0;
      const prefix = partKey(theirs.dev, x.k, x.from, t);
      const got = await partsOf(prefix).catch(() => []);
      const off = got.reduce((a, b) => a + b.length, 0);
      resumed += off;
      round.pending.set(x.k + '>' + x.dest, { ...x, t, prefix, got, size: off });
      items.push({ ...x, off });
    }
    const theirRoms = theirs.entries.filter((e) => e.k.startsWith('rom:') && !mine.games[e.h]);
    setLink(this.deviceId!, { want: total(p.pull), got: resumed, theirRoms: { count: theirRoms.length, bytes: theirRoms.reduce((a, e) => a + (e.n ?? 0), 0) } });
    await this.send({ t: 'want', r: round.r, items: items as unknown as Msg[] });
    await this.maybeDone(round);
  }

  /** Sends what the other device asked for, one record after the other, paced by the data channel. */
  async serve(round: Round, items: (Pull & { off: number })[]) {
    const games = round.snap.games;
    for (const it of items) {
      if (this.round !== round || this.closed) return;
      const bytes = await loadRecord(it.k, games);
      if (!bytes) { await this.send({ t: 'missing', r: round.r, k: it.k + '>' + it.dest }); continue; }
      for (let off = Math.min(Math.max(0, it.off | 0), bytes.length); ; off += CHUNK) {
        if (this.round !== round || this.closed || !this.active) return;
        const data = bytes.subarray(off, off + CHUNK);
        await this.send({ t: 'chunk', r: round.r, k: it.k + '>' + it.dest, off, total: bytes.length, data });
        round.sent += data.length;
        setLink(this.deviceId!, { sent: round.sent });
        if (THROTTLE) await new Promise((r) => setTimeout(r, THROTTLE));
        if (off + CHUNK >= bytes.length) break;
      }
    }
  }

  async chunk(round: Round, key: string, off: number, size: number, data: Uint8Array) {
    const p = round.pending.get(key);
    if (!p || off !== p.size) return; // a repeat, or out of order after a resume: the round will ask again
    p.got.push(data);
    p.size += data.length;
    await addPart(p.prefix, off, data).catch(() => {}); // storage full: resumes from the start instead
    setLink(this.deviceId!, { got: linkOf(this.deviceId!).got + data.length });
    if (p.size < size) return;
    round.pending.delete(key);
    const conflict = p.dest !== p.k ? round.plan!.conflicts.find((c) => c.k === p.k) : undefined;
    // Only over what the plan saw: a save written here since (the game played meanwhile) is never overwritten.
    // The pull fails instead and the base stays put, so the next sync sees both sides changed and keeps both.
    const g = await localGames();
    const still = !/^(sram|state):/.test(p.dest) || (!inPlay(p.dest, g, await busyNow()) &&(await currentHash(p.dest, g)) === this.planned(round, p.dest));
    const ok = still && await storeRecord(p.k, p.dest, p.from, concat(p.got), async () => g, conflict ? { from: conflict.olderFrom, at: conflict.olderAt, profile: conflict.profile } : undefined).catch(() => false);
    await dropParts(p.prefix);
    if (ok) { round.got++; round.changed = true; } else round.failed.push(p.k);
    await this.maybeDone(round);
  }

  /** The hash `k` had here when the round started ('' when absent). */
  planned(round: Round, k: string) { return round.snap.manifest.entries.find((e) => e.k === k)?.h ?? ''; }

  async maybeDone(round: Round) {
    if (round.iDone || round.pending.size) return;
    round.iDone = true;
    await this.send({ t: 'done', r: round.r, failed: round.failed });
    await this.maybeFinish(round);
  }

  async maybeFinish(round: Round) {
    if (!round.iDone || !round.theyDone || this.round !== round) return;
    this.round = null;
    const dev = this.device;
    if (!dev || !round.theirs || !round.plan) return;
    const ok = (list: Pull[], failed: string[]) => list.filter((x) => !failed.includes(x.k));
    const shared = agreed(round.snap.manifest, round.theirs, { ...round.plan, pull: ok(round.plan.pull, round.failed) }, ok(round.theirPulls ?? [], round.theirFailed ?? []));
    const sent = (round.theirPulls?.length ?? 0) - (round.theirFailed?.length ?? 0);
    const failures = round.failed.length + (round.theirFailed?.length ?? 0);
    if (failures) round.notes.push({ key: 'failed', count: failures });
    const report: SyncReport = { at: Date.now(), got: round.got, sent, failed: failures, notes: round.notes };
    // Kept with the device: its notes (and the header's dot) survive a reload.
    setDevice(dev.id, { base: { ...dev.base, ...shared }, lastSync: report.at, report });
    setLink(dev.id, { phase: 'done' });
    // Every pull landed or failed: what's left of this device's transfers is stale.
    dropParts(`${round.theirs.dev}|`);
    if (round.changed) { await reloadLibrary(); await refreshSavedIds(); }
    if (round.notes.length) toast(t('sync.toast.notes', { name: dev.name, count: round.notes.length }), 'm');
    navigator.vibrate?.(20);
    // Items that didn't make it: the leader tries again soon, a few times (a game that was busy, a peer that just reloaded).
    this.retries = failures ? this.retries + 1 : 0;
    clearTimeout(this.retry);
    if (failures && this.lead && this.retries <= 3) this.retry = window.setTimeout(() => this.begin(), RETRY_MS);
  }
}

function conflictNote(c: Conflict, games: Games): Note {
  const game = games.id(gameOfKey(c.k)) ?? undefined;
  if (c.k.startsWith('sram:')) return { game, key: 'bothSave', from: c.olderFrom };
  const slot = c.k.endsWith('#auto') ? 0 : +c.k.slice(c.k.lastIndexOf('-') + 1) + 1; // 0: the resume point
  if (!c.copy) return { game, key: 'noSlot', slot };
  return { game, key: 'bothState', slot, from: c.olderFrom, to: +c.copy.slice(c.copy.lastIndexOf('-') + 1) + 1 };
}

/* ---------- the engine: one link per paired device, while wanted ---------- */

const links = new Map<string, Link>();
let pairLink: Link | null = null;
let holds = 0;
let unsub: (() => void) | null = null;

const wanted = () => holds > 0 || useSync.getState().auto;

/*
 * One tab per browser runs the links: every tab has the same device id, and the other device only talks to the last
 * one that proved itself (a second tab's round would wait forever). The others wait for the lock, show what the one
 * running does (its link states, over a BroadcastChannel) and hand it their "Sync now" and unpairing.
 * No Web Locks (old browsers): every tab runs its own, as before.
 */
const ENGINE = 'cartouche-sync-engine';
let owner = !navigator.locks;
let waiting: AbortController | null = null;
let letGo: (() => void) | null = null;
type Relay = { links?: Record<string, LinkState>; ask?: true; now?: string; unpair?: string };
const relay = typeof BroadcastChannel === 'function' ? new BroadcastChannel(ENGINE) : null;
const post = (m: Relay) => relay?.postMessage(m);
const leading = () => owner && !!letGo;
if (relay) relay.onmessage = ({ data: m }: MessageEvent<Relay>) => {
  if (waiting && m.links) useSync.setState({ links: m.links });
  if (!leading()) return;
  if (m.ask) post({ links: useSync.getState().links });
  if (m.now) syncNow(m.now);
  if (m.unpair) removeDevice(m.unpair);
};

function lockEngine(on: boolean) {
  if (on && !owner && !waiting) {
    const w = waiting = new AbortController();
    navigator.locks.request(ENGINE, { signal: w.signal }, () => {
      if (waiting !== w) return; // no longer wanted
      waiting = null;
      owner = true;
      return new Promise<void>((r) => { letGo = r; reconcile(); });
    }).catch(() => {});
    post({ ask: true });
  }
  if (!on && waiting) { waiting.abort(); waiting = null; }
  if (!on && letGo) { letGo(); letGo = null; owner = false; }
}

function reconcile() {
  const { devices } = useSync.getState();
  lockEngine(wanted());
  const on = wanted() && owner;
  for (const [id, l] of links) if (!on || !devices.some((d) => d.id === id)) { l.close(); links.delete(id); setLink(id, { phase: 'offline' }); }
  if (!on) return;
  for (const d of devices) {
    if (links.has(d.id)) continue;
    const l = new Link(new Uint8Array(0), d.id);
    links.set(d.id, l);
    setLink(d.id, IDLE); // what another tab showed until now
    codeToSecret(d.code).then((s) => { if (!s || l.closed) return; l.secret = s; return l.start(); }).catch((e) => { console.warn('sync:', e); setLink(d.id, { phase: 'error', error: 'failed' }); });
  }
}

function ensure() {
  if (unsub) return;
  let last = useSync.getState();
  unsub = useSync.subscribe((s) => {
    const prev = last;
    last = s;
    if (s.links !== prev.links && leading()) post({ links: s.links });
    if (s.devices !== prev.devices || s.auto !== prev.auto) reconcile();
  });
}

/** Keep the links up while a screen needs them (Settings › Sync). Returns the release. */
export function hold(): () => void {
  ensure();
  holds++;
  reconcile();
  return () => { holds--; setTimeout(reconcile, 0); };
}
/** With auto-sync on: start at launch. */
export function startAuto() { ensure(); reconcile(); }

/** false: the other device isn't here (its app closed, or not on this page with auto-sync off). */
export function syncNow(id: string): boolean {
  if (waiting) { // another tab runs the links
    if (!['online', 'done', 'interrupted'].includes(linkOf(id).phase)) return false;
    post({ now: id });
    return true;
  }
  const l = links.get(id);
  if (!l?.active) return false;
  l.begin();
  return true;
}

/** Drops what arrived of every unfinished transfer (turning ROMs off: up to a ROM's worth of pieces). */
export const forgetTransfers = () => dropParts('');

export function removeDevice(id: string, tell = true) {
  if (waiting && tell) { post({ unpair: id }); return; } // the tab running the links tells the other device and forgets it
  const l = links.get(id);
  const done = () => { l?.close(); links.delete(id); dropParts(`${id}|`); useSync.setState((s) => ({ devices: s.devices.filter((d) => d.id !== id) })); setLink(id, { phase: 'offline' }); };
  if (tell && l?.active) l.send({ t: 'unpair' }).finally(() => setTimeout(done, 300)); else done();
}

const pairState = (p: Partial<NonNullable<ReturnType<typeof useSync.getState>['pairing']>>) =>
  useSync.setState((s) => ({ pairing: s.pairing ? { ...s.pairing, ...p } : null }));

function pairWith(secret: Uint8Array) {
  pairLink?.close();
  const l = new Link(secret, null);
  pairLink = l;
  l.onPaired = async (dev, name, next) => {
    const code = await secretToCode(next);
    useSync.setState((s) => ({
      devices: [...s.devices.filter((d) => d.id !== dev), { id: dev, name, code, pairedAt: Date.now(), base: s.devices.find((d) => d.id === dev)?.base ?? {} }],
      pairing: { phase: 'paired', peer: name },
    }));
    navigator.vibrate?.([30, 60, 30]);
    // A beat for the other device's last message, then the pairing room closes; the device's own room takes over.
    setTimeout(() => { if (pairLink === l) pairLink = null; l.close(); }, 600);
  };
  l.start().catch((e) => { console.warn('sync:', e); pairState({ phase: 'failed', error: 'failed' }); });
}

/** This device shows a code; the other scans or types it. */
export async function showCode(): Promise<void> {
  const secret = randomBytes(32);
  useSync.setState({ pairing: { phase: 'showing', code: await secretToCode(secret) } });
  pairWith(secret);
}
/** The code shown on the other device. false: not a code (or a typo). */
export async function enterCode(text: string): Promise<boolean> {
  const secret = await codeToSecret(text);
  if (!secret) return false;
  useSync.setState({ pairing: { phase: 'joining' } });
  pairWith(secret);
  return true;
}
export function cancelPairing() {
  pairLink?.close();
  pairLink = null;
  useSync.setState({ pairing: null });
}
