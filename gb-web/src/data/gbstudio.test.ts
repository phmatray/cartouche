// node --test: the GB Studio collection. A hosted ROM needs its license, a license link, its SHA-1 and an allowlisted,
// tracked file with exactly that content; every entry is a well-formed, translated catalog entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameEntry } from '../types/game';
import { normValue } from '../lib/search.ts';
import en from '../i18n/en/index.ts';
import gbstudio from './gbstudio.json' with { type: 'json' };
import catalog from './catalog.json' with { type: 'json' };

const ROOT = join(import.meta.dirname, '../../..');
const games = gbstudio as GameEntry[];
const allowlist = new Set(readFileSync(join(ROOT, 'scripts/rom-allowlist.sha1'), 'utf8').split('\n').filter(Boolean));
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');

test('every hosted ROM has a license, a license link, its SHA-1 and an allowlisted file with that content', () => {
  const hosted = games.filter((g) => g.romUrl);
  assert.ok(hosted.length > 0);
  for (const g of hosted) {
    assert.ok(g.license && g.licenseUrl && g.copyright && g.source && g.changes, `${g.id}: credits`);
    assert.match(g.sha1 ?? '', /^[0-9a-f]{40}$/, `${g.id}: sha1`);
    assert.match(g.romUrl!, /^roms\/gbstudio\/[a-z0-9-]+\.gbc?$/, `${g.id}: romUrl`);
    const path = `gb-web/public/${g.romUrl}`;
    assert.ok(allowlist.has(`${g.sha1}  ${path}`), `${g.id}: not in scripts/rom-allowlist.sha1`);
    assert.ok(gitignore.includes(`!${path}`), `${g.id}: no .gitignore line`);
    assert.ok(existsSync(join(ROOT, path)), `${g.id}: file missing`);
    const data = readFileSync(join(ROOT, path));
    assert.equal(createHash('sha1').update(data).digest('hex'), g.sha1, `${g.id}: file differs from its SHA-1`);
    assert.equal(data.length, g.size, `${g.id}: size`);
  }
  // Nothing allowlisted that the catalog doesn't host.
  assert.equal(allowlist.size, hosted.length);
});

test('every entry is a translated, well-formed GB Studio entry', () => {
  const genres = Object.keys(en.search.genre);
  const ids = new Set((catalog as GameEntry[]).map((g) => g.id));
  for (const g of games) {
    assert.ok(!ids.has(g.id), `${g.id}: id used twice`);
    ids.add(g.id);
    assert.equal(g.madeWith, 'GB Studio');
    assert.equal(g.category, 'GB Studio');
    assert.ok(g.descriptions?.fr && g.descriptions?.es && g.description, `${g.id}: descriptions`);
    assert.ok(genres.includes(normValue('genre', g.genre)), `${g.id}: genre ${g.genre} not in the fixed vocabulary`);
    assert.ok(g.platform === 'gb' || g.platform === 'gbc', `${g.id}: platform`);
    assert.match(g.homepage ?? '', /^https:\/\//, `${g.id}: homepage`);
    assert.ok(g.license && g.developer, `${g.id}: license and developer`);
    if (!g.romUrl) assert.ok(g.price && !g.sha1, `${g.id}: a link-out entry has a price and no file`);
  }
});
