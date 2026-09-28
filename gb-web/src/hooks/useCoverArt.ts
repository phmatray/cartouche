import { useState, useEffect } from 'react';
import { boxArtAllowed, getCoverArtUrl, peekCoverArt } from '../lib/cover-art';
import { assetUrl } from '../lib/ui';
import { useSettingsStore } from '../store/settingsStore';
import type { GameEntry } from '../types/game';

/**
 * Box art for a game. A bundled game with its own freely licensed cover (coverArt) shows it right
 * away: it is a file of this app, so no consent is needed and no other site is contacted. Otherwise
 * only games with a known libretro-thumbnails name, or a GB Studio game's itch.io cover (remoteCover),
 * have any; `enabled` lets a card wait until it is on screen before requesting anything, and the
 * "Show box art" setting turns every request off.
 */
export function useCoverArt(game: Pick<GameEntry, 'libretroName' | 'platform' | 'coverArt' | 'remoteCover'>, enabled = true) {
  const { libretroName, platform, coverArt, remoteCover } = game;
  const allowed = useSettingsStore(boxArtAllowed);
  const show = allowed && !!libretroName && !coverArt;
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

  if (coverArt) return { coverUrl: assetUrl(coverArt), loading: false };
  // ponytail: loaded by the <img> itself (img.itch.zone sends no CORS headers, so it can't go through Cache Storage);
  // the browser's HTTP cache keeps it. Not until the card is on screen.
  if (remoteCover && !libretroName) return { coverUrl: allowed && enabled ? remoteCover : null, loading: false };
  if (!show) return { coverUrl: null, loading: false };
  if (cached !== undefined) return { coverUrl: cached, loading: false };
  const done = result?.key === key;
  return { coverUrl: done ? result.url : null, loading: !done };
}
