// node --test: the three dictionaries stay in step, and the plural and format helpers follow the language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, detectLang, DICTS, dur, isPlural, LANGS, langName, loadLang, num, setLang, size, translate } from './core.ts';
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
  assert.equal(ago(now - 26 * 3600e3, now), 'hier');
  assert.match(ago(now - 5 * 60e3, now), /^il y a 5\smin$/);
  assert.equal(ago(Date.UTC(2026, 7, 18), now), 'le 18 août'); // after a month: a date that reads inside a sentence
  assert.equal(ago(Date.UTC(2025, 7, 18), now), 'le 18 août 2025');
  assert.equal(langName('ja'), 'Japonais');
  setLang('es');
  assert.match(size(32 * 1024), /^32\skB$/);
  assert.equal(ago(now - 3 * 86400e3, now), 'hace 3 días');
  assert.equal(ago(Date.UTC(2026, 7, 18), now), 'el 18 de agosto');
  assert.equal(langName('en'), 'Inglés');
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

test('every catalog description and hint is translated', () => {
  for (const g of [...catalog, ...gbstudio] as { id: string; hint?: string; descriptions?: Record<string, string>; hints?: Record<string, string> }[]) {
    for (const l of ['fr', 'es']) {
      assert.ok(g.descriptions?.[l], `${g.id}: description ${l}`);
      if (g.hint) assert.ok(g.hints?.[l], `${g.id}: hint ${l}`);
    }
  }
});
