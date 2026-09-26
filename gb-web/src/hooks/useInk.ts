import { useEffect, useState } from 'react';
import type { GameEntry } from '../types/game';
import { cachedInk, fallbackInk, sampleInk } from '../lib/cover-art';
import { useCoverArt } from './useCoverArt';

/** The game's flood ink, sampled from its box art (deterministic fallback while loading or without art). */
export function useInk(game: GameEntry): string {
  const { coverUrl } = useCoverArt(game);
  const [sample, setSample] = useState<{ url: string; ink: string | null } | null>(null);
  useEffect(() => {
    if (!coverUrl) return;
    let cancelled = false;
    sampleInk(coverUrl).then((ink) => { if (!cancelled) setSample({ url: coverUrl, ink }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [coverUrl]);
  return (sample?.url === coverUrl && sample.ink) || (coverUrl && cachedInk(coverUrl)) || fallbackInk(game.id);
}
