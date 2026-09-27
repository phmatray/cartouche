// node --test (Node strips the types): no test framework needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameEntry } from '../types/game';
import { loadLang, setLang } from '../i18n/core.ts';
import { byName, letterOf } from './ui.ts';
import { buildIndex, facetCounts, formatQuery, normValue, parseQuery, search, suggest, valueLabel, withoutEach } from './search.ts';

const game = (id: string, o: Partial<GameEntry>): GameEntry => ({ id, title: id, description: '', genre: 'Unknown', category: 'My Collection', coverArt: '', screenshots: [], isLocal: true, ...o });
const GAMES = [
  game('Zephyr Keep', { genre: 'Action RPG', developer: 'Nintendo', year: '1993', region: 'USA', players: 1, platform: 'gb', libretroName: 'Zephyr Keep (USA)', isFavorite: true }),
  game('Pixel Garden', { genre: 'Rpg', developer: 'Game Freak/Creatures', publisher: 'Nintendo', year: '2000', region: 'Japan', players: 2, platform: 'gbc', compatibility: 'dual', saveType: 'battery' }),
  game('Kobo Quest', { genre: 'Action', developer: 'HAL Laboratory, Inc.', year: '1992', region: 'Europe', players: 1, platform: 'gb' }),
  game('Tile Tumble', { genre: 'Puzzle', developer: 'Nintendo', year: '1989', region: 'World', players: 2, platform: 'gb', lastPlayed: 1000 }),
  game('Homebrew', { genre: 'Platformer', category: 'Homebrew Highlights', license: 'MIT', year: '2017', isLocal: false, romUrl: 'roms/x.gb' }),
  game('Unknown dump', { isLocal: false }),
];
await loadLang('fr'); // French values typed in the search count too
const index = buildIndex(GAMES, { saved: new Set(['Pixel Garden']), art: false, now: 2000 });
const titles = (q: string) => search(index, parseQuery(q)).map((g) => g.title);

test('normalizes synonyms, accents and case', () => {
  assert.equal(normValue('genre', 'Role-playing'), 'rpg');
  assert.equal(normValue('genre', 'RPG'), 'rpg');
  assert.equal(normValue('region', 'Japan'), 'jp');
  assert.equal(normValue('region', 'mars'), '');
  assert.equal(normValue('region', 'japon'), 'jp');
  assert.equal(normValue('region', 'Japón'), 'jp');
  assert.equal(normValue('region', 'europa'), 'eu');
  assert.equal(normValue('region', 'États-Unis'), 'us');
  assert.equal(normValue('region', 'estados unidos'), 'us');
  assert.equal(normValue('players', '2 players'), '2');
  assert.equal(normValue('players', 'link'), '2+');
  assert.equal(normValue('decade', '90s'), '1990s');
  assert.equal(normValue('decade', '1994'), '1990s');
  assert.equal(normValue('year', '1998..2001'), '1998..2001');
  assert.equal(normValue('year', '..1995'), '..1995');
  assert.equal(normValue('developer', 'HAL Laboratory, Inc.'), 'hal laboratory');
  assert.equal(normValue('developer', 'HAL'), 'hal laboratory');
  assert.equal(normValue('is', 'fav'), 'favorite');
  assert.equal(normValue('platform', 'Game Boy Color'), 'gbc');
  assert.equal(normValue('language', 'Klingon'), '');
  assert.equal(normValue('language', 'Français'), 'fr'); // a value typed in French or Spanish counts too
  assert.equal(normValue('genre', 'plateformes'), 'platformer');
  assert.equal(normValue('is', 'favoris'), 'favorite');
  assert.equal(normValue('made', 'GB Studio'), 'gbstudio');
  assert.equal(normValue('made', 'gb-studio'), 'gbstudio');
  assert.equal(valueLabel('genre', 'rpg'), 'RPG');
});

test('parses the syntax; bad tokens stay free text, never throw', () => {
  const q = parseQuery('genre:rpg players:2 region:jp year:1998..2001 dev:"hal laboratory" is:favorite -genre:puzzle zephyr');
  assert.deepEqual(q.filters, [
    { key: 'genre', value: 'rpg' }, { key: 'players', value: '2' }, { key: 'region', value: 'jp' }, { key: 'year', value: '1998..2001' },
    { key: 'developer', value: 'hal laboratory' }, { key: 'is', value: 'favorite' }, { key: 'genre', value: 'puzzle', neg: true },
  ]);
  assert.equal(q.text, 'zephyr');
  assert.deepEqual(parseQuery('foo:bar region:mars'), { text: 'foo:bar region:mars', filters: [] });
  assert.deepEqual(parseQuery('genre: tile'), { text: 'tile', filters: [] }); // value still being typed
  assert.deepEqual(parseQuery('g:rpg,puzzle').filters, [{ key: 'genre', value: 'rpg' }, { key: 'genre', value: 'puzzle' }]);
  for (const s of ['"', '-', ':', '-:', 'year:abc', 'dev:"', '"unclosed', '::::']) assert.doesNotThrow(() => parseQuery(s));
  const round = 'genre:rpg -region:jp developer:"hal laboratory" year:..1995 hopper';
  assert.equal(formatQuery(parseQuery(round)), round);
});

test('AND across facets, OR within a facet, negation', () => {
  assert.deepEqual(titles('genre:rpg'), ['Pixel Garden', 'Zephyr Keep']); // "Action RPG" is an RPG
  assert.deepEqual(titles('genre:role-playing players:1'), ['Zephyr Keep']);
  assert.deepEqual(titles('genre:rpg genre:puzzle'), ['Pixel Garden', 'Tile Tumble', 'Zephyr Keep']);
  assert.deepEqual(titles('-genre:rpg is:mine'), ['Kobo Quest', 'Tile Tumble']);
  assert.deepEqual(titles('region:jp'), ['Pixel Garden', 'Tile Tumble']); // World counts everywhere
  assert.deepEqual(titles('region:eu'), ['Kobo Quest', 'Tile Tumble']);
  assert.deepEqual(titles('players:2+'), ['Pixel Garden', 'Tile Tumble']);
  assert.deepEqual(titles('year:1990..1995'), ['Kobo Quest', 'Zephyr Keep']);
  assert.deepEqual(titles('decade:80s'), ['Tile Tumble']);
  assert.deepEqual(titles('dev:hal'), ['Kobo Quest']);
  assert.deepEqual(titles('publisher:nintendo'), ['Pixel Garden']);
  assert.deepEqual(titles('platform:dual'), ['Pixel Garden']);
  assert.deepEqual(titles('save:battery'), ['Pixel Garden']);
  assert.deepEqual(titles('lang:ja'), ['Pixel Garden']);
  assert.deepEqual(titles('is:saved'), ['Pixel Garden']);
  assert.deepEqual(titles('is:need'), ['Unknown dump']);
  assert.deepEqual(titles('is:recent'), ['Tile Tumble']);
  assert.deepEqual(titles('is:homebrew'), ['Homebrew']);
  assert.deepEqual(titles('is:fav'), ['Zephyr Keep']);
  assert.deepEqual(titles('nintendo -genre:puzzle'), ['Pixel Garden', 'Zephyr Keep']); // free text: developer and publisher
});

test('faceted counts ignore the facet’s own filters', () => {
  const q = parseQuery('genre:rpg');
  assert.deepEqual(facetCounts(index, q, 'players').map((v) => [v.value, v.count]), [['1', 1], ['2', 1], ['2+', 1]]);
  const genres = Object.fromEntries(facetCounts(index, q, 'genre').map((v) => [v.value, v.count]));
  assert.equal(genres.rpg, 2);
  assert.equal(genres.puzzle, 1);
  assert.equal(facetCounts(index, q, 'genre'), facetCounts(index, parseQuery('genre:rpg'), 'genre')); // memoized
  assert.deepEqual(withoutEach(index, parseQuery('genre:rpg region:eu')).map((x) => x.count), [2, 2]);
});

test('a value’s count is what picking it gives; shared credits split', () => {
  for (const key of ['developer', 'publisher', 'genre', 'region', 'players', 'is'] as const) {
    for (const v of facetCounts(index, parseQuery(''), key)) assert.equal(search(index, { text: '', filters: [{ key, value: v.value }] }).length, v.count, `${key}:${v.value}`);
  }
  assert.deepEqual(titles('dev:creatures'), ['Pixel Garden']);
  assert.deepEqual(titles('dev:nintendo'), ['Tile Tumble', 'Zephyr Keep']);
});

test('invalid values stay text; ranges swap; the later of include/exclude wins', () => {
  assert.deepEqual(parseQuery('genre:xyz zephyr', index), { text: 'genre:xyz zephyr', filters: [] });
  assert.deepEqual(parseQuery('genre:rpg', index).filters, [{ key: 'genre', value: 'rpg' }]);
  assert.deepEqual(parseQuery('year:2001..1998').filters, [{ key: 'year', value: '1998..2001' }]);
  assert.deepEqual(parseQuery('genre:rpg -genre:rpg').filters, [{ key: 'genre', value: 'rpg', neg: true }]);
  const shmup = buildIndex([game('S', { genre: "Shoot'em up" })], { saved: new Set(), art: false });
  assert.deepEqual(shmup.items[0].v.genre, ['shmup']);
});

test('suggests keys and values with counts', () => {
  assert.deepEqual(suggest(index, parseQuery(''), 'gen').map((s) => s.insert), ['genre:']);
  const rp = suggest(index, parseQuery(''), 'genre:r');
  assert.equal(rp[0].insert, 'genre:rpg ');
  assert.equal(rp[0].count, 2);
  assert.ok(suggest(index, parseQuery(''), 'rpg').some((s) => s.insert === 'genre:rpg '));
  assert.equal(suggest(index, parseQuery(''), '-reg')[0].insert, '-region:');
  assert.deepEqual(suggest(index, parseQuery(''), 'nope:x'), []);
});

test('a genre typed as the cards show it in French finds its games and suggests it', () => {
  setLang('fr');
  try {
    assert.deepEqual(titles('reflexion'), ['Tile Tumble']); // 'Puzzle' reads 'Réflexion'
    assert.ok(suggest(index, parseQuery('réflexion'), 'réflexion').some((s) => s.insert === 'genre:puzzle '));
  } finally { setLang('en'); }
  assert.deepEqual(titles('puzzle'), ['Tile Tumble']);
});

test('A–Z letters: an accented initial files under its letter, where it sorts', () => {
  const l = (title: string) => letterOf(game(title, {}));
  assert.deepEqual(['Ōkami Tale', 'Élan', 'The Zone', 'zap', '1942', '"Quoted"'].map(l), ['O', 'E', 'Z', 'Z', '#', '#']);
});

test('A–Z order: every # title comes first, in one run (µ sorts after Z otherwise)', () => {
  const sorted = ['Zeta', 'µTown', 'Alpha', '3 Stars', 'The Yard', 'Élan'].map((t) => game(t, {})).sort(byName);
  assert.deepEqual(sorted.map((g) => g.title), ['3 Stars', 'µTown', 'Alpha', 'Élan', 'The Yard', 'Zeta']);
});

test('indexes 3,000 games and answers a query well within a frame', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ ...GAMES[i % 4], id: `g${i}`, title: `Game ${i} ${GAMES[i % 4].title}` }));
  const t0 = performance.now();
  const big = buildIndex(many, { saved: new Set(), art: true });
  const t1 = performance.now();
  for (const s of ['z', 'ze', 'zep', 'zeph', 'zephyr']) { search(big, parseQuery(`genre:rpg ${s}`)); facetCounts(big, parseQuery(`genre:rpg ${s}`), 'players'); }
  const t2 = performance.now();
  assert.ok(t1 - t0 < 1000, `index ${t1 - t0} ms`);
  assert.ok((t2 - t1) / 5 < 16, `per keystroke ${(t2 - t1) / 5} ms`);
});
