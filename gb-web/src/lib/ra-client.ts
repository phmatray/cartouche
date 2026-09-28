// RetroAchievements unlocking: rcheevos' rc_client (src/vendor/rcheevos.js, built by rcheevos/build.sh) watches the
// game's memory every frame and reports unlocks to retroachievements.org, through Cartouche's relay
// (relay/retroachievements), since RetroAchievements' emulator API answers no web page. Softcore only: Cartouche is not
// yet a validated emulator (see docs/RETROACHIEVEMENTS.md). Sign-in is with the password once; only the session token
// the server gives back stays in this browser (localStorage).
import pkg from '../../package.json' with { type: 'json' };

export const RELAY: string = import.meta.env?.VITE_RA_RELAY || 'https://cartouche-ra.phmatray.workers.dev';
/** The emulator's identity, which the relay passes to RetroAchievements as the User-Agent. */
export const CLIENT = `Cartouche/${pkg.version} (Web) gb-core/${pkg.version}`;
const PLAY = 'cartouche-ra-play';

export interface RaPlay { user: string; token: string }
const store = () => { try { return localStorage; } catch { return null; } };
export function getPlay(): RaPlay | null {
  try { const p = JSON.parse(store()?.getItem(PLAY) ?? 'null'); return p?.user && p?.token ? p : null; } catch { return null; }
}
function setPlay(p: RaPlay | null) {
  try { if (p) store()?.setItem(PLAY, JSON.stringify(p)); else store()?.removeItem(PLAY); } catch { /* blocked: this session only */ }
  signedIn = null;
}

/** What rc_client reports while a game runs (rc_client.h, RC_CLIENT_EVENT_*). */
export interface RaEvent { type: number; id: number; title: string; description: string; points: number; badge: string; error: string }
export const EV = { UNLOCKED: 1, COMPLETED: 15, SERVER_ERROR: 16, DISCONNECTED: 17, RECONNECTED: 18 } as const;

interface Rc {
  _ra_init(hardcore: number): void; _ra_login_password(u: number, p: number): void; _ra_login_token(u: number, t: number): void;
  _ra_user_name(): number; _ra_user_token(): number; _ra_load(hash: number): void; _ra_game_id(): number; _ra_summary(out: number): void;
  _ra_frame(): void; _ra_idle(): void; _ra_reset(): void; _ra_jumped(): void; _ra_unload(): void;
  _ra_respond(id: number, body: number, len: number, status: number): void;
  _malloc(n: number): number; _free(p: number): void; UTF8ToString(p: number): string; stringToNewUTF8(s: string): number; HEAPU32: Uint32Array;
}

let read: (addr: number) => number = () => 0;
let onEvent: (e: RaEvent) => void = () => {};
const waiting: Record<number, (r: { ok: boolean; error: string }) => void> = {};
let rc: Promise<Rc> | null = null;
const enc = new TextEncoder();

function module(): Promise<Rc> {
  rc ??= import('../vendor/rcheevos.js').then(async ({ default: create }) => {
    const m: Rc = await create({
      raRead: (a: number) => read(a),
      raCall: (_url: string, post: string, id: number) => {
        fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-RA-Client': CLIENT }, body: post })
          .then(async (r) => ({ status: r.status, body: await r.text() }))
          .catch(() => ({ status: -2, body: '' })) // RC_API_SERVER_RESPONSE_RETRYABLE_CLIENT_ERROR: unlocks wait and retry
          .then(({ status, body }) => {
            const p = m.stringToNewUTF8(body);
            m._ra_respond(id, p, enc.encode(body).length, status);
            m._free(p);
          });
      },
      raEvent: (type: number, id: number, title: string, description: string, points: number, badge: string, error: string) =>
        onEvent({ type, id, title, description, points, badge, error }),
      raDone: (what: number, result: number, error: string) => { waiting[what]?.({ ok: result === 0, error }); delete waiting[what]; },
    });
    m._ra_init(0);
    return m;
  });
  return rc;
}

/** Calls an rc_client async function (1 login, 2 game load) with C strings, freed once it answers. */
async function run(what: 1 | 2, fn: (m: Rc, ...ptrs: number[]) => void, ...args: string[]): Promise<{ ok: boolean; error: string }> {
  const m = await module();
  const ptrs = args.map((s) => m.stringToNewUTF8(s));
  const done = new Promise<{ ok: boolean; error: string }>((r) => { waiting[what] = r; });
  fn(m, ...ptrs);
  const r = await done;
  ptrs.forEach((p) => m._free(p));
  return r;
}

/** Sign in with the password (never kept): the token RetroAchievements returns is. Throws with the server's reason. */
export async function signIn(user: string, password: string): Promise<RaPlay> {
  const r = await run(1, (m, u, p) => m._ra_login_password(u, p), user, password);
  if (!r.ok) throw new Error(r.error);
  const m = await module();
  const play = { user: m.UTF8ToString(m._ra_user_name()), token: m.UTF8ToString(m._ra_user_token()) };
  setPlay(play);
  signedIn = Promise.resolve(true);
  return play;
}
export const signOut = () => setPlay(null);

let signedIn: Promise<boolean> | null = null;
/** Signs in with the stored token, once per page. False when there is none, or it was refused (then forgotten). */
function session(): Promise<boolean> {
  if (signedIn) return signedIn;
  const p = getPlay();
  if (!p) return Promise.resolve(false);
  signedIn = run(1, (m, u, t) => m._ra_login_token(u, t), p.user, p.token).then((r) => {
    if (!r.ok && /token|credential|password|expired/i.test(r.error)) setPlay(null);
    if (!r.ok) signedIn = null;
    return r.ok;
  });
  return signedIn;
}

export interface RaSession { gameId: number; earned: number; total: number; frame(): void; jumped(): void; reset(): void; end(): void }
/**
 * Starts watching the game with this RetroAchievements hash (the ROM's MD5): null when not signed in, or the game
 * has no achievements there. `peek` reads a byte at a RetroAchievements address; `events` hears unlocks and errors.
 */
export async function play(hash: string, peek: (addr: number) => number, events: (e: RaEvent) => void): Promise<RaSession | null> {
  if (!(await session())) return null;
  const m = await module();
  read = peek; onEvent = events;
  const r = await run(2, (m, h) => m._ra_load(h), hash);
  const gameId = r.ok ? m._ra_game_id() : 0;
  if (!gameId) return null;
  const out = m._malloc(16);
  m._ra_summary(out);
  const [total, earned] = m.HEAPU32.subarray(out >> 2, (out >> 2) + 2);
  m._free(out);
  let on = true;
  return {
    gameId, earned, total,
    frame: () => { if (on) m._ra_frame(); },
    jumped: () => { if (on) m._ra_jumped(); },
    reset: () => { if (on) m._ra_reset(); },
    end: () => { if (on) { on = false; m._ra_unload(); read = () => 0; onEvent = () => {}; } },
  };
}
