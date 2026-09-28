/**
 * Device sync state the screens read: paired devices, this device's choices, and what each link is doing.
 * Tiny on purpose (no crypto, no WebRTC): the header's indicator imports it on every page. The engine that does
 * the work (engine.ts) loads on first use.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { t, translate, type Key } from '../../i18n/core.ts';

export interface Device {
  /** The other device's id (random, made once per browser). */
  id: string;
  name: string;
  /** The pairing secret, as its code. */
  code: string;
  pairedAt: number;
  lastSync?: number;
  /** Hashes both devices held after the last sync, by key: tells "changed here" from "changed there". */
  base: Record<string, string>;
  /** The last sync's report, kept so its notes outlive a reload. */
  report?: SyncReport;
}

/**
 * Something the player should know after a sync, shown in their language (`game`: its id here, shown as its title).
 * running: the game was open · linkBusy: a link cable page was open · bothSave: a save played on both, `from`'s is a copy ·
 * bothState: state `slot` (0: the resume point) on both, `from`'s moved to slot `to` · noSlot: the same, no slot free · failed: `count` items missing.
 */
export interface Note { key: 'running' | 'linkBusy' | 'bothSave' | 'bothState' | 'noSlot' | 'failed'; game?: string; from?: string; slot?: number; to?: number; count?: number }

export interface SyncReport {
  at: number;
  got: number;
  sent: number;
  /** Items that didn't make it, both ways (tried again soon). */
  failed?: number;
  /** Its notes were shown on Settings › Sync (the header's dot goes out). */
  seen?: boolean;
  notes: Note[];
}

export type LinkPhase = 'offline' | 'online' | 'syncing' | 'done' | 'interrupted' | 'error';
export interface LinkState {
  phase: LinkPhase;
  /** Bytes this sync: received / to receive, sent / to send. */
  got: number; want: number; sent: number; give: number;
  /** ROMs the other device has that this one doesn't (known after a manifest exchange), for the estimate. */
  theirRoms?: { count: number; bytes: number };
  error?: LinkError;
}
/** connect: no direct route between the two networks · failed: the connection couldn't start · relays: no matchmaking relay reachable. */
export type LinkError = 'connect' | 'failed' | 'relays';

export type PairPhase = 'showing' | 'joining' | 'found' | 'paired' | 'failed';
export interface Pairing { phase: PairPhase; code?: string; peer?: string; error?: LinkError }

interface SyncState {
  /** `name`: the one the player chose, '' for the default (guessName, in the language shown: use deviceName). */
  me: { id: string; name: string };
  devices: Device[];
  /** Sync on its own whenever a paired device is around (opt-in). */
  auto: boolean;
  /** Share this device's ROMs with paired devices and take theirs (opt-in). */
  roms: boolean;
  links: Record<string, LinkState>;
  pairing: Pairing | null;
}

/** This device's default name, in the language `tr` gives (the one shown by default). */
export function guessName(ua = navigator.userAgent, tr: (k: Key) => string = t): string {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return tr(/Mobile/.test(ua) ? 'sync.device.androidPhone' : 'sync.device.androidTablet');
  const os = /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? tr('sync.device.windows') : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? tr('sync.device.linux') : tr('sync.device.computer');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}
/** This device's name as shown and sent: the one chosen, else the default in the language shown now. */
export const deviceName = (me: { name: string }) => me.name || guessName();
/** A name to store: '' when it's the default (it then follows the language). */
export const nameToStore = (name: string) => (name === guessName() ? '' : name);
/**
 * Names stored before they followed the language: the default was saved in English at the first visit. That one becomes
 * "no name chosen". ponytail: a player who typed exactly that English default gets it translated too.
 */
export const migrateName = (name: string, ua = navigator.userAgent) => (name === guessName(ua, (k) => translate('en', k)) ? '' : name);
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export const useSync = create<SyncState>()(persist((): SyncState => ({
  me: { id: newId(), name: '' },
  devices: [],
  auto: false,
  roms: false,
  links: {},
  pairing: null,
}), {
  name: 'cartouche.sync',
  version: 2,
  migrate: (s, v) => {
    const old = s as SyncState;
    return (v < 2 && old?.me ? { ...old, me: { ...old.me, name: migrateName(old.me.name) } } : old);
  },
  partialize: ({ me, devices, auto, roms }) => ({ me, devices, auto, roms }),
}));

// Another tab paired, unpaired, synced or changed a choice: take its devices and choices (one tab runs the links, engine.ts).
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === 'cartouche.sync') void useSync.persist.rehydrate(); });

export const IDLE: LinkState ={ phase: 'offline', got: 0, want: 0, sent: 0, give: 0 };
export const linkOf = (id: string) => useSync.getState().links[id] ?? IDLE;
export function setLink(id: string, patch: Partial<LinkState>) {
  useSync.setState((s) => ({ links: { ...s.links, [id]: { ...(s.links[id] ?? IDLE), ...patch } } }));
}
export function setDevice(id: string, patch: Partial<Device>) {
  useSync.setState((s) => ({ devices: s.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

/** The engine (WebRTC rooms, crypto, the walk through storage) loads on first use, never with the app. */
export const engine = () => import('./engine');
