#!/usr/bin/env node
/**
 * Refreshes `remoteCover` in gb-web/src/data/gbstudio.json: for every GB Studio game Cartouche doesn't host, the
 * og:image URL (the cover image) of its author's itch.io page. Only the URL is stored: no image is downloaded or
 * written anywhere. The app loads it from img.itch.zone at runtime, only when the player agreed to box art.
 * A page without an og:image on img.itch.zone (or that fails to load) leaves the game without one.
 *
 *   node scripts/gbstudio-covers.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../gb-web/src/data/gbstudio.json', import.meta.url);
const ITCH_IMAGE = /^https:\/\/img\.itch\.zone\/[\w%+=./-]+$/;

/** The page's og:image, if it is an itch.io image. */
async function ogImage(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // the attributes come in either order
  const tag = (await res.text()).match(/<meta\b[^>]*\bproperty="og:image"[^>]*>/)?.[0];
  const img = tag?.match(/\bcontent="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
  return img && ITCH_IMAGE.test(img) ? img : undefined;
}

/** The file's own layout: one entry per line, ", " and ": " separators, UTF-8 as is. */
const out = (v) => Array.isArray(v) ? `[${v.map(out).join(', ')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${out(x)}`).join(', ')}}`
  : JSON.stringify(v);

const games = JSON.parse(readFileSync(FILE, 'utf8'));
let found = 0;
for (const g of games) {
  if (g.romUrl) { delete g.remoteCover; continue; } // hosted: its committed title screen (coverArt)
  let cover;
  try { cover = await ogImage(g.homepage); } catch (e) { console.warn(`${g.id}: ${e.message}`); }
  const { remoteCover: _, ...rest } = g;
  // keep the key right after coverArt
  const next = {};
  for (const [k, v] of Object.entries(rest)) { next[k] = v; if (k === 'coverArt' && cover) next.remoteCover = cover; }
  Object.keys(g).forEach((k) => delete g[k]);
  Object.assign(g, next);
  if (cover) found++; else console.warn(`${g.id}: no itch.io cover image`);
}
writeFileSync(FILE, `[\n${games.map((g) => `  ${out(g)}`).join(',\n')}\n]\n`);
console.log(`${found} of ${games.filter((g) => !g.romUrl).length} link-out games have a cover URL`);
