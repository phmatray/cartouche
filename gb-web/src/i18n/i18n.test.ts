// node --test: the three dictionaries stay in step, and the plural and format helpers follow the language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, detectLang, DICTS, dur, headerSize, isPlural, LANGS, langName, loadLang, num, pct, regionName, setLang, size, translate } from './core.ts';
import { LEGAL_SECTIONS } from '../content/legal.ts';
import { LEGAL_FR } from '../content/legal.fr.ts';
import { LEGAL_ES } from '../content/legal.es.ts';
import catalog from '../data/catalog.json' with { type: 'json' };
import gbstudio from '../data/gbstudio.json' with { type: 'json' };

await loadLang('fr');
await loadLang('es');

/** Every message as [key, text], a plural's forms joined (so their placeholders count together). */
function flat(o: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + k;
    if (typeof v === 'string') out.set(key, v);
    else if (isPlural(v)) out.set(key, Object.values(v).join(' '));
    else for (const [kk, vv] of flat(v, `${key}.`)) out.set(kk, vv);
  }
  return out;
}
/** `{name}` placeholders and `<tag>` markup of a message. */
const marks = (s: string) => [...new Set(s.match(/\{\w+\}|<\/?\w+>/g) ?? [])].sort();

test('French and Spanish have exactly the English keys, placeholders and markup', () => {
  const en = flat(DICTS.en);
  for (const lang of ['fr', 'es'] as const) {
    const other = flat(DICTS[lang]!);
    assert.deepEqual([...other.keys()].sort(), [...en.keys()].sort(), `${lang}: keys`);
    for (const [k, v] of en) assert.deepEqual(marks(other.get(k)!), marks(v), `${lang}: ${k}`);
    for (const [k, v] of other) assert.ok(v.trim(), `${lang}: ${k} is empty`);
  }
});

test('French puts a no-break space before : ; ? ! (never a lone sign at the start of a line)', () => {
  const bad = [...flat(DICTS.fr!)].filter(([, v]) => / [:;?!](\s|$)/.test(v)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('every plural has each form its language uses (“many” falls back to “other”)', () => {
  const walk = (o: object, lang: string, path = ''): void => {
    for (const [k, v] of Object.entries(o)) {
      if (isPlural(v)) {
        for (const c of new Intl.PluralRules(lang).resolvedOptions().pluralCategories) if (c !== 'many') assert.ok(c in v, `${lang}: ${path}${k}.${c}`);
      } else if (typeof v === 'object') walk(v, lang, `${path}${k}.`);
    }
  };
  for (const lang of LANGS) walk(DICTS[lang]!, lang);
});

test('plurals follow each language’s rules', () => {
  assert.equal(translate('en', 'common.games', { count: 0 }), '0 games');
  assert.equal(translate('en', 'common.games', { count: 1 }), '1 game');
  assert.equal(translate('fr', 'common.games', { count: 0 }), '0 jeu'); // French: 0 and 1 are singular
  assert.equal(translate('fr', 'common.games', { count: 2 }), '2 jeux');
  assert.equal(translate('es', 'common.games', { count: 1 }), '1 juego');
  assert.equal(translate('es', 'common.games', { count: 1000000 }), '1.000.000 juegos'); // "many" falls back to other
  assert.equal(translate('fr', 'common.games', { count: 12345 }), '12 345 jeux'); // numbers formatted for the language
  assert.equal(translate('en', 'library.jumpTo', { letter: 'B' }), 'Jump to B');
  assert.equal(translate('en', 'library.jumpTo'), 'Jump to {letter}'); // a missing value stays visible, never "undefined"
});

test('sizes, times and names use the active language', () => {
  const now = Date.UTC(2026, 8, 27, 12);
  setLang('en');
  assert.equal(size(1536 * 1024), '1.5 MB');
  assert.equal(size(512), '512 bytes');
  assert.equal(ago(now - 26 * 3600e3, now), 'yesterday');
  assert.equal(dur(3900), '1 h 05');
  assert.equal(num(12345), '12,345');
  setLang('fr');
  assert.match(size(1536 * 1024), /^1,5\sMo$/); // \s: Intl puts a (narrow) no-break space before the unit
  assert.match(headerSize('1 MB'), /^1\sMo$/);
  assert.equal(ago(now - 26 * 3600e3, now), 'hier');
  assert.match(ago(now - 5 * 60e3, now), /^il y a 5\smin$/);
  assert.equal(ago(Date.UTC(2026, 7, 18), now), 'le 18 août'); // after a month: a date that reads inside a sentence
  assert.equal(ago(Date.UTC(2025, 7, 18), now), 'le 18 août 2025');
  assert.equal(langName('ja'), 'Japonais');
  setLang('es');
  assert.match(size(32 * 1024), /^32\skB$/);
  assert.match(headerSize('512 KB'), /^512\skB$/); // a ROM header's size, as on the game page and in the Manual
  assert.equal(headerSize('None'), 'Ninguna');
  assert.equal(ago(now - 3 * 86400e3, now), 'hace 3 días');
  assert.equal(ago(Date.UTC(2026, 7, 18), now), 'el 18 de agosto');
  assert.equal(langName('en'), 'Inglés');
  setLang('en');
});

test('percentages and GameDB regions follow the language', () => {
  setLang('en');
  assert.equal(pct(80), '80%');
  assert.equal(regionName('USA/Europe'), 'USA/Europe');
  setLang('fr');
  assert.match(pct(80), /^80\s%$/); // a no-break space before %
  assert.match(pct(20, true), /^\+20\s%$/);
  assert.match(pct(0, true), /^0\s%$/);
  assert.equal(regionName('Japan'), 'Japon');
  assert.equal(regionName('USA/Europe'), 'États-Unis/Europe');
  assert.equal(regionName('World'), 'Monde');
  assert.equal(regionName('Scandinavia'), 'Scandinavia'); // no region code: as the GameDB has it
  setLang('es');
  assert.equal(regionName('Japan'), 'Japón');
  assert.equal(regionName('South Korea'), 'Corea del Sur');
  setLang('en');
});

test('the browser’s first known language wins, else English', () => {
  assert.equal(detectLang(['de-DE', 'fr-CA', 'en']), 'fr');
  assert.equal(detectLang(['es-419']), 'es');
  assert.equal(detectLang(['de', 'ja']), 'en');
  assert.equal(detectLang([]), 'en');
  assert.deepEqual(LANGS, ['en', 'fr', 'es']);
});

test('the legal translations keep every section, link and URL of the English text', () => {
  const urls = (s: string) => (s.match(/https?:\/\/[^\s)]*[^\s).,;]/g) ?? []).sort();
  for (const [lang, t] of [['fr', LEGAL_FR], ['es', LEGAL_ES]] as const) {
    assert.equal(t.length, LEGAL_SECTIONS.length, `${lang}: sections`);
    LEGAL_SECTIONS.forEach((s, i) => {
      assert.deepEqual(urls(t[i].body), urls(s.body), `${lang}: URLs of “${s.title}”`);
      assert.deepEqual(t[i].links?.map((l) => l.file), s.links?.map((l) => l.file), `${lang}: files of “${s.title}”`);
    });
  }
});

test('every catalog description, hint and credit line is translated', () => {
  for (const g of [...catalog, ...gbstudio] as { id: string; hint?: string; license?: string; changes?: string; coverCredit?: string; descriptions?: Record<string, string>; hints?: Record<string, string>; credits?: Record<string, Record<string, string>> }[]) {
    for (const l of ['fr', 'es']) {
      assert.ok(g.descriptions?.[l], `${g.id}: description ${l}`);
      if (g.hint) assert.ok(g.hints?.[l], `${g.id}: hint ${l}`);
      for (const f of ['license', 'changes', 'coverCredit'] as const) if (g[f]) assert.ok(g.credits?.[l]?.[f], `${g.id}: ${f} ${l}`);
    }
  }
});
