import { useState, useEffect } from 'react';
import { boxArtAllowed, getCoverArtUrl, peekCoverArt } from '../lib/cover-art';
import { useSettingsStore } from '../store/settingsStore';
import type { GameEntry } from '../types/game';

/**
 * Box art for a game (only games with a known libretro-thumbnails name have any). `enabled` lets
 * a card wait until it is on screen before requesting anything; the "Show box art" setting turns
 * every request off.
 */
export function useCoverArt(game: Pick<GameEntry, 'libretroName' | 'platform'>, enabled = true) {
  const { libretroName, platform } = game;
  const show = useSettingsStore(boxArtAllowed) && !!libretroName;
  const key = `${platform}/${libretroName}`;
  const [result, setResult] = useState<{ key: string; url: string | null } | null>(null);
  const cached = peekCoverArt(libretroName, platform);

  useEffect(() => {
    if (!show || !enabled || cached !== undefined) return;
    let cancelled = false;
    getCoverArtUrl(libretroName, platform).then((url) => {
      if (!cancelled) setResult({ key, url });
    });
    return () => { cancelled = true; };
  }, [show, enabled, cached, key, libretroName, platform]);

  if (!show) return { coverUrl: null, loading: false };
  if (cached !== undefined) return { coverUrl: cached, loading: false };
  const done = result?.key === key;
  return { coverUrl: done ? result.url : null, loading: !done };
}
