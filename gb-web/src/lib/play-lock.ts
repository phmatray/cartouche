/**
 * What is running in any tab of this browser: an open player holds a shared Web Lock named after its game, the local
 * link cable page one of its own (any game may run there). Sync reads them (engine.ts) and leaves those saves alone,
 * whichever tab it runs in. No Web Locks (old browsers): nothing is held, sync only knows its own tab, as before.
 */
const GAME = 'cartouche-play:';
const LINK = 'cartouche-link';

function hold(name: string): () => void {
  let release: (() => void) | undefined, gone = false;
  navigator.locks?.request(name, { mode: 'shared' }, () => (gone ? undefined : new Promise<void>((r) => { release = r; }))).catch(() => {});
  return () => { gone = true; release?.(); };
}
/** Held while the player of `gameId` is open. Returns the release. */
export const holdGame = (gameId: string) => hold(GAME + gameId);
/** Held while the local link cable page is open. Returns the release. */
export const holdLinkCable = () => hold(LINK);

/** The games open in a player and whether a link cable page is open, across this browser's tabs. */
export async function inUse(): Promise<{ games: string[]; link: boolean }> {
  const held = await navigator.locks?.query().then((q) => q.held, () => undefined);
  const names = (held ?? []).map((l) => l.name ?? '');
  return { games: names.filter((n) => n.startsWith(GAME)).map((n) => n.slice(GAME.length)), link: names.includes(LINK) };
}
