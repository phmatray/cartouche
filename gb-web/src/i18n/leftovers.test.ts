// node --test: user-facing text in src/components goes through t(). A grep, not a parser: it flags JSX text
// and text attributes (aria-label, title, placeholder, alt, label, sub) written as literals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../components');
// Never translated: key caps and console button names, names of things, units and symbols.
const KEEP = /^(A|B|A \/ B|Start|Select|Start \/ Select|Menu|View|Tab|Enter|Esc|P|R|M|F|F5|F8|F12|GB|GBC|ROM|ROMs|Cartouche|Game Boy|Game Boy Color|Game Boy \+ Color|Super Game Boy|Scale2x|Scale3x|Neural 4×|Link|i|AI|½|×|—|#|\?|\/|[½\d.]+×)$/;

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));

export function leftovers(src: string): string[] {
  const found: string[] = [];
  const add = (s: string) => {
    const v = s.trim();
    // Code caught between a `>` and a `<` (`&&`, spreads, lists), search syntax (`genre:`) and file names are not text.
    if (/[A-Za-z]{2}/.test(v) && !KEEP.test(v) && !/&&|\|\||\.\.\.|^[,[\]:?]|^-?[a-z]+:[\w.]*$|^[\w./-]+\.\w{2,4}$/.test(v)) found.push(v);
  };
  for (const m of src.matchAll(/\s(?:aria-label|title|placeholder|alt|label|sub)="([^"]*)"/g)) add(m[1]);
  // Text between two tags on one line: `>Save<`, `<b>Paused</b>`, `{I.play}Play</Link>`.
  for (const m of src.matchAll(/[>}]([^<>{}()=;`'"\n]+)<\//g)) add(m[1]);
  // After a tag's `>` (not an arrow's `=>` nor a comparison's ` > `).
  for (const m of src.matchAll(/(?<=[\w"'}/])>([^<>{}()=;`'"\n]+)</g)) add(m[1]);
  return [...new Set(found)];
}

test('the leftover check catches literals and lets t() through', () => {
  assert.deepEqual(leftovers('<b>Paused</b> <button aria-label="Close">x</button> <p>{t(\'a.b\')}</p> <kbd>Esc</kbd>'), ['Close', 'Paused']);
});

test('no untranslated text in src/components', () => {
  const report = files(ROOT).flatMap((f) => leftovers(readFileSync(f, 'utf8')).map((s) => `${f.slice(ROOT.length + 1)}: ${s}`));
  assert.deepEqual(report, []);
});
