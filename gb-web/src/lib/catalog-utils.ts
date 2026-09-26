import type { RegionFilter } from '../types/game';

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
