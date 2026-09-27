import type { CreditField, GameEntry, RegionFilter } from '../types/game';
import { getLang, regionName, t } from '../i18n/core';

/** Extract region tags from libretroName parenthetical, e.g. "(USA, Europe)" -> ["US","EU"] */
export function parseRegion(libretroName?: string): RegionFilter[] {
  if (!libretroName) return [];
  const match = libretroName.match(/\(([^)]+)\)/);
  if (!match) return [];
  const raw = match[1];
  if (/\bWorld\b/i.test(raw)) return ['US', 'EU', 'JP'];
  const regions: RegionFilter[] = [];
  if (/\bUSA\b/i.test(raw)) regions.push('US');
  if (/\bEurope\b/i.test(raw) || /\bAustralia\b/i.test(raw)) regions.push('EU');
  if (/\bJapan\b/i.test(raw)) regions.push('JP');
  return regions;
}

/**
 * A catalog game's description in the active language (English when it has none), or the user ROM's line: its GameDB
 * 'developer · region', stored in English at import, so the region is translated here.
 */
export function descOf(g: GameEntry): string {
  const d = g.descriptions?.[getLang() as 'fr'] ?? (g.description || (g.isLocal ? t('game.userRom') : ''));
  return g.isLocal && g.region && d.endsWith(` · ${g.region}`) ? d.slice(0, -g.region.length) + regionName(g.region) : d;
}
/** A credit line (license, changes, box art) in the active language (English when it has none). */
export const creditOf = (g: GameEntry, f: CreditField) => g.credits?.[getLang() as 'fr']?.[f] ?? g[f];
/** A test cartridge's pass hint in the active language. */
export const hintOf = (g: GameEntry) => g.hints?.[getLang() as 'fr'] ?? g.hint;
