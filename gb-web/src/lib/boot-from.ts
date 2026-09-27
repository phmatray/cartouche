// Where the player starts a game: a slot it was asked for, the resume point, or a fresh power-on.

/**
 * `?slot=N` loads that slot and `?resume` the resume point. Otherwise the resume point is the default while one exists
 * (Save slots, Edit layout, a reload of the tab, iOS bringing back an evicted one): a fresh power-on would write over
 * it on leaving. The online link page (`?online`, `?save`) makes its own choice, "the battery save alone" included.
 */
export function bootFrom(q: URLSearchParams, resumePoints: boolean, hasResume: boolean): 'auto' | number | null {
  const slot = q.get('slot');
  if (slot !== null) return +slot;
  if (q.get('resume')) return 'auto';
  if (q.has('online') || q.has('save')) return null;
  return resumePoints && hasResume ? 'auto' : null;
}

/**
 * A game moved to the Game Boy because it plays its music on the SNES chip (not emulated) starts again there rather than
 * resume on the Super Game Boy, silent: a game picks its sound path when it boots, so only a fresh start has the sound.
 */
export function skipSilentResume(from: 'auto' | number | null, madeOn: string | undefined, chosen: string, snesMusic: boolean): boolean {
  return from === 'auto' && snesMusic && madeOn === 'sgb' && chosen !== 'sgb';
}
