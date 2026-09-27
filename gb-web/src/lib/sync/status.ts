/**
 * Device sync state the screens read: paired devices, this device's choices, and what each link is doing.
 * Tiny on purpose (no crypto, no WebRTC): the header's indicator imports it on every page. The engine that does
 * the work (engine.ts) loads on first use.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
/** connect: no direct route between the two networks · failed: the connection couldn't start. */
export type LinkError = 'connect' | 'failed';

export type PairPhase = 'showing' | 'joining' | 'found' | 'paired' | 'failed';
export interface Pairing { phase: PairPhase; code?: string; peer?: string; error?: LinkError }

interface SyncState {
  me: { id: string; name: string };
  devices: Device[];
  /** Sync on its own whenever a paired device is around (opt-in). */
  auto: boolean;
  /** Share this device's ROMs with paired devices and take theirs (opt-in). */
  roms: boolean;
  links: Record<string, LinkState>;
  pairing: Pairing | null;
}

export function guessName(ua = navigator.userAgent): string {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  const os = /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux PC' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export const useSync = create<SyncState>()(persist((): SyncState => ({
  me: { id: newId(), name: guessName() },
  devices: [],
  auto: false,
  roms: false,
  links: {},
  pairing: null,
}), {
  name: 'cartouche.sync',
  version: 1,
  partialize: ({ me, devices, auto, roms }) => ({ me, devices, auto, roms }),
}));

export const IDLE: LinkState = { phase: 'offline', got: 0, want: 0, sent: 0, give: 0 };
export const linkOf = (id: string) => useSync.getState().links[id] ?? IDLE;
export function setLink(id: string, patch: Partial<LinkState>) {
  useSync.setState((s) => ({ links: { ...s.links, [id]: { ...(s.links[id] ?? IDLE), ...patch } } }));
}
export function setDevice(id: string, patch: Partial<Device>) {
  useSync.setState((s) => ({ devices: s.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

/** The engine (WebRTC rooms, crypto, the walk through storage) loads on first use, never with the app. */
export const engine = () => import('./engine');
