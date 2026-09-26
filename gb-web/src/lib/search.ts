import type { GameEntry } from '../types/game';
import { folded, owned, score, searchFields, sortTitle } from './ui.ts';

/**
 * Faceted search: a query is free text plus `key:value` filters (`genre:rpg players:2 -region:jp year:1990..1995`).
 * Filters on the same facet are OR'd, different facets AND'd, `-` excludes. Anything that doesn't parse
 * as a filter is free text, searched with `score` (titles, developer, publisher…). Pure: no React, no DOM.
 */

export type Key = 'genre' | 'players' | 'region' | 'platform' | 'decade' | 'year' | 'developer' | 'publisher' | 'language' | 'save' | 'is';
export interface Filter { key: Key; value: string; neg?: boolean }
export interface Query { text: string; filters: Filter[] }

export const FACETS: { key: Key; label: string; alias: string[] }[] = [
  { key: 'genre', label: 'Genre', alias: ['g'] },
  { key: 'players', label: 'Players', alias: ['player', 'p'] },
  { key: 'region', label: 'Region', alias: ['r'] },
  { key: 'platform', label: 'Platform', alias: ['system', 'sys'] },
  { key: 'decade', label: 'Decade', alias: [] },
  { key: 'year', label: 'Year', alias: ['y'] },
  { key: 'developer', label: 'Developer', alias: ['dev', 'by'] },
  { key: 'publisher', label: 'Publisher', alias: ['pub'] },
  { key: 'language', label: 'Language', alias: ['lang'] },
  { key: 'save', label: 'Save', alias: ['savetype'] },
  { key: 'is', label: 'Your games', alias: ['has', 'status'] },
];
const KEY_OF = new Map(FACETS.flatMap((f) => [f.key, ...f.alias].map((a) => [a, f.key] as const)));
export const facetLabel = (k: Key) => FACETS.find((f) => f.key === k)!.label;
/** The facet a typed key names (`dev` → developer), if any. */
export const facetKey = (raw: string) => KEY_OF.get(raw.toLowerCase());

// Closed facets: a value outside these (after synonyms) isn't a filter, the token stays free text.
const CLOSED: Partial<Record<Key, Record<string, string>>> = {
  players: { 1: '1 player', 2: '2 players', '2+': '2+ players · link', 4: '4 players' },
  region: { us: 'US', eu: 'EU', jp: 'JP', world: 'World', other: 'Other' },
  platform: { gb: 'Game Boy', gbc: 'Game Boy Color', dual: 'Both (dual)' },
  save: { battery: 'Battery save', none: 'No save' },
  language: { en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', zh: 'Chinese', ca: 'Catalan' },
  is: { favorite: 'Favorites', saved: 'Saved', now: 'Playable now', need: 'Needs your ROM', unplayed: 'Never played', recent: 'Recently played', art: 'Has box art', mine: 'My ROMs', homebrew: 'Homebrew' },
};
const SYN: Partial<Record<Key, Record<string, string>>> = {
  genre: {
    'role playing': 'rpg', roleplaying: 'rpg', 'role playing game': 'rpg', rpgs: 'rpg', jrpg: 'rpg',
    'shoot em up': 'shmup', 'shootem up': 'shmup', shootemup: 'shmup', shmups: 'shmup', shooter: 'shooting', simulation: 'sim',
    'beat em up': 'brawler', 'beatem up': 'brawler', beatemup: 'brawler', platform: 'platformer', platforms: 'platformer', music: 'rhythm',
    'not a game': 'notagame', 'mini games': 'minigames', minigame: 'minigames', party: 'minigames',
    race: 'racing', sport: 'sports', fighter: 'fighting', fight: 'fighting', puzzles: 'puzzle', strategy: 'strategy',
  },
  players: { single: '1', solo: '1', '1p': '1', one: '1', '2p': '2', two: '2', link: '2+', multi: '2+', multiplayer: '2+', '4p': '4' },
  region: { usa: 'us', america: 'us', na: 'us', ntsc: 'us', europe: 'eu', eur: 'eu', pal: 'eu', japan: 'jp', jpn: 'jp', ja: 'jp' },
  platform: { dmg: 'gb', gameboy: 'gb', 'game boy': 'gb', mono: 'gb', cgb: 'gbc', color: 'gbc', colour: 'gbc', 'game boy color': 'gbc', both: 'dual' },
  save: { yes: 'battery', sram: 'battery', sav: 'battery', no: 'none' },
  language: { english: 'en', japanese: 'ja', jp: 'ja', french: 'fr', german: 'de', spanish: 'es', italian: 'it', dutch: 'nl', portuguese: 'pt', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', chinese: 'zh' },
  is: {
    fav: 'favorite', favorites: 'favorite', favourite: 'favorite', starred: 'favorite', saves: 'saved', save: 'saved',
    playable: 'now', play: 'now', 'play now': 'now', needrom: 'need', 'needs rom': 'need', 'need rom': 'need', rom: 'need',
    new: 'unplayed', never: 'unplayed', 'never played': 'unplayed', played: 'recent', 'recently played': 'recent',
    boxart: 'art', cover: 'art', local: 'mine', owned: 'mine', free: 'homebrew',
  },
};
// Studio name variants seen across the GameDB and ROM headers.
const NAME_SYN: Record<string, string> = { 'hal labs': 'hal laboratory', hal: 'hal laboratory', ea: 'electronic arts', squaresoft: 'square', 'konami computer entertainment nagoya': 'kcen' };
const GENRE_LABEL: Record<string, string> = { rpg: 'RPG', shmup: 'Shoot ’em up', sim: 'Simulation', notagame: 'Not a game', minigames: 'Minigames', 'action rpg': 'Action RPG' };
const EU = /\b(europe|germany|france|spain|italy|united kingdom|uk|sweden|netherlands|scandinavia|australia|denmark|norway|finland|portugal)\b/i;

const f = (s: string) => folded(s).s;
const nameKey = (s: string) => {
  const k = f(s).replace(/\b(inc|ltd|co|corp|corporation|company|limited|kk|llc|gmbh|sa|the)\b/g, ' ').replace(/ +/g, ' ').trim();
  return NAME_SYN[k] ?? k;
};
/** Each studio of a shared credit ('Game Freak/Creatures', 'HAL Laboratory, Inc.') as [value, label]. */
const credits = (s?: string) => (s ?? '').split(/\s*[/,&]\s*/).map((p) => [nameKey(p), p.trim()] as const).filter(([k]) => k);
/** Catalog homebrew (it carries a license), not the test cartridges. */
const isHomebrew = (g: GameEntry) => !!g.license && !/test/i.test(g.category);

/** Canonical value of `raw` for facet `key`, or '' when it isn't a value of that facet. */
export function normValue(key: Key, raw: string): string {
  if (key === 'developer' || key === 'publisher') return nameKey(raw);
  if (key === 'year') {
    const m = raw.trim().match(/^(\d{4})?\s*(?:(\.\.|-)\s*(\d{4})?)?$/);
    if (!m || (!m[1] && !m[3])) return '';
    if (m[1] && m[3] && m[1] > m[3]) [m[1], m[3]] = [m[3], m[1]];
    return m[2] ? `${m[1] ?? ''}..${m[3] ?? ''}` : m[1];
  }
  let v = raw.trim().toLowerCase();
  if (key === 'players') v = v.replace(/\s*players?$/, '');
  if (key === 'decade') {
    const m = v.match(/^(\d{2}|\d{4})s?$/);
    if (!m) return '';
    const n = Number(m[1]);
    return `${m[1].length === 4 ? n - (n % 10) : n < 50 ? 2000 + n - (n % 10) : 1900 + n - (n % 10)}s`;
  }
  if (key !== 'players') v = f(v);
  v = SYN[key]?.[v] ?? v;
  const closed = CLOSED[key];
  if (closed) return v in closed || (key === 'players' && /^\d$/.test(v)) ? v : '';
  return v;
}

/** How a value reads on a chip or in a list. `labels` has the original spelling of open values (developers…). */
export function valueLabel(key: Key, value: string, labels?: Map<string, string>): string {
  if (key === 'year') return value.includes('..') ? value.replace(/^\.\./, 'up to ').replace(/\.\.$/, ' and later').replace('..', '–') : value;
  if (key === 'players' && !CLOSED.players![value]) return `${value} players`;
  return CLOSED[key]?.[value] ?? labels?.get(`${key}\0${value}`) ?? GENRE_LABEL[value] ?? value.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Index: every value a game has, normalized once.
// ---------------------------------------------------------------------------

export interface Indexed { g: GameEntry; t: string; rest: string; year: number; v: Record<Key, string[]> }
export interface SearchIndex { items: Indexed[]; labels: Map<string, string> }
export interface IndexContext { saved: Set<string>; art: boolean; now?: number }

const RECENT_MS = 30 * 864e5;

function regionsOf(g: GameEntry): string[] {
  const text = `${g.region ?? ''} ${g.libretroName?.match(/\(([^)]+)\)/)?.[1] ?? ''}`;
  const r = new Set<string>(g.regions?.map((x) => x.toLowerCase()));
  if (/\bworld\b/i.test(text) || r.size === 3) ['us', 'eu', 'jp', 'world'].forEach((x) => r.add(x));
  if (/\b(usa|canada)\b/i.test(text)) r.add('us');
  if (EU.test(text)) r.add('eu');
  if (/\bjapan\b/i.test(text)) r.add('jp');
  if (!r.size && text.trim()) r.add('other');
  return [...r];
}

function languagesOf(g: GameEntry, regions: string[]): string[] {
  const tag = g.libretroName?.match(/\(((?:[A-Z][a-z],?)+)\)/)?.[1];
  if (tag) return tag.split(',').map((l) => l.toLowerCase());
  if (g.language) return [normValue('language', g.language)].filter(Boolean);
  // ponytail: no language tag in the dump name: guessed from the region (Japan → Japanese, else English).
  if (regions.includes('jp') && !regions.includes('us') && !regions.includes('eu')) return ['ja'];
  return regions.some((r) => r === 'us' || r === 'eu') ? ['en'] : [];
}

const genreKey = (genre: string) => (!genre || genre === 'Unknown' || genre === 'Test' ? '' : normValue('genre', genre));
/** A game's genre as it reads on a tag ('Rpg' → 'RPG'), '' when unknown. */
export const genreLabel = (g: GameEntry) => { const k = genreKey(g.genre); return k ? valueLabel('genre', k) : ''; };
// Genres a word of a longer one may stand for ('Action RPG' is also Action and RPG; "Shoot'em up" isn't Up).
const GENRES = new Set([...Object.values(SYN.genre!), 'action', 'adventure']);
function genresOf(genre: string, pool: Set<string>): string[] {
  const whole = genreKey(genre);
  return whole ? [...new Set([whole, ...whole.split(' ').map((w) => normValue('genre', w)).filter((w) => pool.has(w))])] : [];
}

export function buildIndex(games: GameEntry[], ctx: IndexContext): SearchIndex {
  const now = ctx.now ?? Date.now();
  const labels = new Map<string, string>();
  const label = (k: Key, v: string, l: string) => { if (v && !labels.has(`${k}\0${v}`)) labels.set(`${k}\0${v}`, l); return v; };
  const genres = new Set([...GENRES, ...games.map((g) => genreKey(g.genre))]);
  const items = games.map((g): Indexed => {
    const year = /^\d{4}$/.test(g.year ?? '') ? Number(g.year) : 0;
    const region = regionsOf(g);
    const p = g.players ?? 0;
    const is: string[] = [];
    if (g.isFavorite) is.push('favorite');
    if (ctx.saved.has(g.id)) is.push('saved');
    is.push(owned(g) ? 'now' : 'need');
    if (!g.lastPlayed) is.push('unplayed');
    else if (now - g.lastPlayed < RECENT_MS) is.push('recent');
    if (g.coverArt || (ctx.art && g.libretroName)) is.push('art'); // ponytail: "has box art" = could show one, not "the download succeeded"
    if (g.isLocal) is.push('mine');
    if (isHomebrew(g)) is.push('homebrew');
    const genre = genresOf(g.genre, genres);
    if (genre[0]) label('genre', genre[0], GENRE_LABEL[genre[0]] ?? g.genre);
    return {
      g, ...searchFields(g), year,
      v: {
        genre,
        players: p ? [String(p), ...(p >= 2 ? ['2+'] : [])] : [],
        region,
        platform: g.platform ? [g.platform, ...(g.compatibility === 'dual' ? ['dual'] : [])] : [],
        decade: year ? [`${year - (year % 10)}s`] : [],
        year: year ? [String(year)] : [],
        developer: credits(g.developer).map(([v, l]) => label('developer', v, l)),
        publisher: credits(g.publisher).map(([v, l]) => label('publisher', v, l)),
        language: languagesOf(g, region),
        save: g.saveType ? [g.saveType] : [],
        is,
      },
    };
  });
  return { items, labels };
}

let lastIndex: { games: GameEntry[]; saved: Set<string>; art: boolean; index: SearchIndex } | null = null;
/** One index per library state, shared by the search overlay and the library page. */
export function indexFor(games: GameEntry[], saved: Set<string>, art: boolean): SearchIndex {
  if (lastIndex?.games !== games || lastIndex.saved !== saved || lastIndex.art !== art) lastIndex = { games, saved, art, index: buildIndex(games, { saved, art }) };
  return lastIndex.index;
}

// ---------------------------------------------------------------------------
// Query syntax
// ---------------------------------------------------------------------------

const TOKEN = /(-?)([a-z]+):("([^"]*)"?|[^\s"]*)|"([^"]*)"?|(\S+)/gi;

/** `base` plus `more`, a later filter on the same value replacing the earlier one (include and exclude are exclusive). */
export const addFilters = (base: Filter[], more: Filter[]) =>
  more.reduce((acc, x) => [...acc.filter((y) => y.key !== x.key || y.value !== x.value), x], base);

const knownMemo = new WeakMap<SearchIndex, Map<Key, Set<string>>>();
function known(index: SearchIndex, key: Key): Set<string> {
  let m = knownMemo.get(index);
  if (!m) knownMemo.set(index, (m = new Map()));
  let s = m.get(key);
  if (!s) m.set(key, (s = new Set(index.items.flatMap((it) => it.v[key]))));
  return s;
}
const OPEN = new Set<Key>(['genre', 'developer', 'publisher']);

/**
 * Parse the typed syntax. Never throws: whatever isn't a valid filter is free text (an empty `genre:` is dropped).
 * With an `index`, an open-facet value no game has (`genre:xyz`) is free text too.
 */
export function parseQuery(input: string, index?: SearchIndex): Query {
  let filters: Filter[] = [];
  const text: string[] = [];
  for (const m of input.matchAll(TOKEN)) {
    const [whole, neg, rawKey, rawVal, quoted, phrase, word] = m;
    if (rawKey !== undefined) {
      const key = KEY_OF.get(rawKey.toLowerCase());
      const raw = quoted ?? rawVal;
      if (key && !raw) continue; // still typing the value
      const values = key ? (key === 'developer' || key === 'publisher' || quoted !== undefined ? [raw] : raw.split(',')).map((v) => normValue(key, v)) : [];
      if (key && values.length && values.every((v) => v && (!index || !OPEN.has(key) || known(index, key).has(v)))) {
        filters = addFilters(filters, values.map((value) => ({ key, value, ...(neg ? { neg: true } : {}) })));
        continue;
      }
      text.push(whole.replace(/["]/g, ''));
    } else text.push(phrase ?? word);
  }
  return { text: text.join(' ').trim(), filters };
}

const quote = (v: string) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);
export const formatFilter = (x: Filter) => `${x.neg ? '-' : ''}${x.key}:${quote(x.value)}`;
/** The query as syntax (what goes in the URL): filters first, then the free text. */
export const formatQuery = (q: Query) => [...q.filters.map(formatFilter), q.text.trim()].filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Matching and counts
// ---------------------------------------------------------------------------

function hit(it: Indexed, x: Filter): boolean {
  if (x.key === 'year') {
    const [a, b = a] = x.value.split('..');
    return !!it.year && it.year >= (Number(a) || 0) && it.year <= (Number(b) || 9999);
  }
  return it.v[x.key].includes(x.value);
}

/** A predicate for the filters: OR within a facet, AND across facets, negated ones excluded. `skip` ignores one facet (for its own counts). */
export function compile(filters: Filter[], skip?: Key): (it: Indexed) => boolean {
  const groups = new Map<Key, Filter[]>();
  const nots: Filter[] = [];
  for (const x of filters) {
    if (x.key === skip) continue;
    if (x.neg) nots.push(x);
    else groups.set(x.key, [...(groups.get(x.key) ?? []), x]);
  }
  const any = [...groups.values()];
  return (it) => any.every((g) => g.some((x) => hit(it, x))) && !nots.some((x) => hit(it, x));
}

// The text pass is the costly one: remembered for the last text of each index.
const textMemo = new WeakMap<SearchIndex, { q: string; hits: Map<Indexed, number> }>();
function textHits(index: SearchIndex, text: string): Map<Indexed, number> | null {
  const q = f(text);
  if (!q) return null;
  const m = textMemo.get(index);
  if (m?.q === q) return m.hits;
  const hits = new Map<Indexed, number>();
  for (const it of index.items) { const n = score(it.g, q, it); if (n) hits.set(it, n); }
  textMemo.set(index, { q, hits });
  return hits;
}

/** The games matching the query: best text match first (then A–Z), or A–Z when there's no text. */
export function search(index: SearchIndex, q: Query): GameEntry[] {
  const hits = textHits(index, q.text);
  const ok = compile(q.filters);
  const byTitle = (a: Indexed, b: Indexed) => sortTitle(a.g.title).localeCompare(sortTitle(b.g.title));
  const pool = hits ? [...hits.keys()] : index.items;
  return pool.filter(ok).sort((a, b) => (hits ? hits.get(b)! - hits.get(a)! : 0) || byTitle(a, b)).map((it) => it.g);
}

export interface FacetValue { value: string; label: string; count: number }
const countMemo = new WeakMap<SearchIndex, Map<string, FacetValue[]>>();
/**
 * The values of one facet with how many games each would give: over the games matching the text and every
 * other facet's filters (so picking a second genre shows what it adds). Most common first.
 */
export function facetCounts(index: SearchIndex, q: Query, key: Key): FacetValue[] {
  const memoKey = `${key}|${f(q.text)}|${q.filters.filter((x) => x.key !== key).map(formatFilter).sort().join(' ')}`;
  let memo = countMemo.get(index);
  if (!memo) countMemo.set(index, (memo = new Map()));
  const cached = memo.get(memoKey);
  if (cached) return cached;
  const hits = textHits(index, q.text);
  const ok = compile(q.filters, key);
  const n = new Map<string, number>();
  for (const it of hits ? hits.keys() : index.items) if (ok(it)) for (const v of it.v[key]) n.set(v, (n.get(v) ?? 0) + 1);
  const out = [...n].map(([value, count]) => ({ value, count, label: valueLabel(key, value, index.labels) }))
    .sort((a, b) => (key === 'decade' || key === 'year' ? a.value.localeCompare(b.value) : b.count - a.count || a.label.localeCompare(b.label)));
  if (memo.size > 200) memo.clear();
  memo.set(memoKey, out);
  return out;
}

/** A game's facts as search filters: the tags on its page and in the list view link into the search. */
export function gameTags(g: GameEntry): { key: Key; label: string; filter: Filter }[] {
  const out: { key: Key; label: string; filter: Filter }[] = [];
  const add = (key: Key, value: string, label: string) => { if (value) out.push({ key, label, filter: { key, value } }); };
  if (/^\d{4}$/.test(g.year ?? '')) add('year', g.year!, g.year!);
  const devs = credits(g.developer);
  for (const [v, l] of devs) add('developer', v, l);
  for (const [v, l] of credits(g.publisher)) if (!devs.some(([d]) => d === v)) add('publisher', v, l);
  const genre = genreKey(g.genre);
  if (genre) add('genre', genre, GENRE_LABEL[genre] ?? g.genre);
  if (g.players) add('players', g.players > 1 ? '2+' : '1', g.players > 1 ? `1–${g.players} players · link cable` : '1 player');
  const regions = regionsOf(g);
  if (regions.includes('world')) add('region', 'world', 'World');
  else for (const r of regions) add('region', r, valueLabel('region', r));
  if (g.platform) add('platform', g.compatibility === 'dual' ? 'dual' : g.platform, g.compatibility === 'dual' ? 'Game Boy & Color' : valueLabel('platform', g.platform));
  if (isHomebrew(g)) add('is', 'homebrew', 'Homebrew');
  return out;
}

/** How many games the query gives without each of its filters: the empty state names the one to remove. */
export function withoutEach(index: SearchIndex, q: Query): { filter: Filter; count: number }[] {
  return q.filters.map((filter) => ({ filter, count: search(index, { ...q, filters: q.filters.filter((x) => x !== filter) }).length }));
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export interface Suggestion { insert: string; label: string; hint: string; count?: number }

/**
 * Completions for the token being typed (`partial`), against the rest of the query `q`:
 * `ge` → `genre:`, `genre:r` → `genre:rpg` (with counts), a plain word → facet values it starts (`rpg` → `genre:rpg`).
 */
export function suggest(index: SearchIndex, q: Query, partial: string, max = 8): Suggestion[] {
  const m = partial.match(/^(-?)([a-z]*)(?::"?([^"]*))?$/i);
  if (!m || !partial.replace('-', '')) return [];
  const [, neg, rawKey, rawVal] = m;
  const values = (key: Key, typed: string, strict: boolean) => {
    const t = f(typed);
    return facetCounts(index, q, key)
      .filter((v) => !q.filters.some((x) => x.key === key && x.value === v.value))
      .filter((v) => !t || f(v.label).startsWith(t) || v.value.startsWith(t) || (!strict && ` ${f(v.label)}`.includes(` ${t}`)))
      .map((v) => ({ insert: `${neg}${key}:${quote(v.value)} `, label: `${neg ? 'not ' : ''}${v.label}`, hint: facetLabel(key), count: v.count }));
  };
  if (rawVal !== undefined) {
    const key = KEY_OF.get(rawKey.toLowerCase());
    return key ? values(key, rawVal, false).slice(0, max) : [];
  }
  const keys = FACETS.filter((x) => [x.key, ...x.alias].some((a) => a.startsWith(rawKey.toLowerCase())) && x.key.length > rawKey.length)
    .map((x) => ({ insert: `${neg}${x.key}:`, label: `${neg}${x.key}:`, hint: x.label }));
  if (rawKey.length < 2) return keys.slice(0, max);
  const vals = FACETS.filter((x) => x.key !== 'developer' && x.key !== 'publisher' && x.key !== 'year')
    .flatMap((x) => values(x.key, rawKey, true)).sort((a, b) => b.count! - a.count!);
  return [...keys, ...vals].slice(0, max);
}
