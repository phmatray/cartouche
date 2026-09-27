// The translations and every locale-aware formatter. Pure (no React, no store): lib code and Node tests use it too.
// The active language is set by ./index.ts (settings store, else the browser's languages).
import en from './en/index.ts';

export const LANGS = ['en', 'fr', 'es'] as const;
export type Lang = (typeof LANGS)[number];
/** Each language's own name (shown in the language pickers). */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', fr: 'Français', es: 'Español' };

/** A plural message: `other` plus any category of Intl.PluralRules (and nothing else); `{count}` is the number. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
type IsPlural<T> = T extends { other: string } ? (keyof T extends Intl.LDMLPluralRule ? true : false) : false;
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : IsPlural<T[K]> extends true ? Plural : Shape<T[K]> };
/** The English dictionary's shape: French and Spanish must have exactly these keys (tsc rejects a missing or extra one). */
export type Messages = Shape<typeof en>;
type Paths<T, P extends string = ''> = { [K in keyof T & string]: T[K] extends string ? `${P}${K}` : IsPlural<T[K]> extends true ? `${P}${K}` : Paths<T[K], `${P}${K}.`> }[keyof T & string];
export type Key = Paths<typeof en>;
export type Vars = Record<string, string | number>;

/** The loaded dictionaries: English always (every missing message falls back to it), the others once used. */
export const DICTS: Partial<Record<Lang, Messages>> = { en };
const LOADERS = { fr: () => import('./fr/index.ts'), es: () => import('./es/index.ts') };
/** Fetch a language's dictionary (its own small chunk: a visit only downloads the language it shows). */
export async function loadLang(l: Lang) {
  if (!DICTS[l]) DICTS[l] = (await LOADERS[l as keyof typeof LOADERS]()).default;
}
// Dates and numbers: British English (day before month), as the app always showed them.
const LOCALE: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR', es: 'es-ES' };

let lang: Lang = 'en';
export const getLang = () => lang;
export const setLang = (l: Lang) => { lang = l; };
export const locale = () => LOCALE[lang];

/** The first of the browser's languages we have (fr*, es*, en*), else English. */
export function detectLang(langs: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): Lang {
  for (const l of langs) {
    const base = l.toLowerCase().split('-')[0];
    if ((LANGS as readonly string[]).includes(base)) return base as Lang;
  }
  return 'en';
}

// Intl objects are costly to build: one per language and options.
const memo = new Map<string, unknown>();
function intl<T>(key: string, make: () => T): T {
  let v = memo.get(key) as T | undefined;
  if (!v) memo.set(key, (v = make()));
  return v;
}

const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
/** A plural message: an object of plural categories only, `other` among them. */
export const isPlural = (v: unknown): v is Plural =>
  !!v && typeof v === 'object' && 'other' in v && Object.keys(v).every((k) => CATEGORIES.includes(k));

function lookup(l: Lang, key: string): string | Plural | undefined {
  let v: unknown = DICTS[l];
  for (const p of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[p];
  return typeof v === 'string' || isPlural(v) ? v : undefined;
}

/** `key` in language `l`: a plural picks its form from `vars.count`; `{name}` takes `vars.name` (numbers formatted for `l`). */
export function translate(l: Lang, key: Key, vars?: Vars): string {
  let v = lookup(l, key) ?? lookup('en', key) ?? key;
  if (typeof v !== 'string') {
    const n = Number(vars?.count ?? 0);
    v = v[intl(`p${l}`, () => new Intl.PluralRules(LOCALE[l])).select(n)] ?? v.other;
  }
  if (!vars) return v;
  return v.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (typeof vars[k] === 'number' ? numIn(l, vars[k]) : vars[k]) : m));
}

/** `key` in the active language. */
export const t = (key: Key, vars?: Vars) => translate(lang, key, vars);
/** A key built from data (a genre, a value): its translation when the dictionary has it, else `fallback`. */
export const tOr = (key: string, fallback: string) => (lookup('en', key) === undefined ? fallback : translate(lang, key as Key));

const numIn = (l: Lang, n: number) => intl(`n${l}`, () => new Intl.NumberFormat(LOCALE[l])).format(n);
/** 12,345 · 12 345 · 12.345 */
export const num = (n: number) => numIn(lang, n);

/** A byte count: bytes, kB, MB or GB with the language's units (anything stored shows at least 1 kB). */
export function size(n: number): string {
  const [v, unit, d] = n >= 1073741824 ? [n / 1073741824, 'gigabyte', 1] : n >= 1048576 ? [n / 1048576, 'megabyte', 1]
    : n >= 1024 || n === 0 ? [Math.max(n ? 1 : 0, Math.round(n / 1024)), 'kilobyte', 0] : [n, 'byte', 0];
  return intl(`u${lang}${unit}`, () => new Intl.NumberFormat(locale(), { style: 'unit', unit, unitDisplay: unit === 'byte' ? 'long' : 'short', maximumFractionDigits: d })).format(v);
}

/** How long ago: "just now", "5 min ago", "yesterday", "3 weeks ago", then the date. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 60) return t('common.time.justNow');
  const rel = (n: number, u: Intl.RelativeTimeFormatUnit, style: 'long' | 'short' = 'long') =>
    intl(`r${lang}${style}`, () => new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style })).format(-n, u);
  const m = Math.round(s / 60); if (m < 60) return rel(m, 'minute', 'short');
  const h = Math.round(m / 60); if (h < 24) return rel(h, 'hour');
  const d = Math.round(h / 24); if (d < 7) return rel(d, 'day');
  if (d < 30) return rel(Math.round(d / 7), 'week');
  return date(ts, { day: 'numeric', month: 'long' });
}

/** A date (and time, with hour/minute options) in the active language. */
export const date = (ts: number, opts: Intl.DateTimeFormatOptions) =>
  intl(`d${lang}${JSON.stringify(opts)}`, () => new Intl.DateTimeFormat(locale(), opts)).format(ts);

/** Play time: "< 1 min", "12 min", "1 h 05". */
export function dur(seconds?: number): string {
  if (!seconds) return '—';
  if (seconds < 60) return t('common.time.underMinute');
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? t('common.time.hours', { h: String(h), m: String(m).padStart(2, '0') }) : t('common.time.minutes', { m: String(m) });
}

/** A language's name in the active language ("ja" → Japanese, japonais, japonés), capitalized for a label. */
export function langName(code: string): string {
  try {
    const s = intl(`l${lang}`, () => new Intl.DisplayNames(locale(), { type: 'language' })).of(code) ?? code;
    return s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);
  } catch { return code; }
}

/** "a, b and c" in the active language. */
export const list = (items: string[]) => intl(`L${lang}`, () => new Intl.ListFormat(locale())).format(items);
