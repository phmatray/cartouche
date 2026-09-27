// node --test: the default save's name, stored in whatever language was active, shows in the current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LANGS, loadLang, setLang, translate } from '../i18n/core.ts';
import { asProfile, mainName, neutralName } from './db.ts';

await loadLang('fr');
await loadLang('es');

test('a default save named in any language shows in the current one; other names stay', () => {
  for (const shown of LANGS) {
    setLang(shown);
    const main = translate(shown, 'player.saves.main');
    for (const stored of LANGS) {
      const n = translate(stored, 'player.saves.main');
      assert.equal(mainName(n), main, `${stored} → ${shown}`);
      assert.equal(mainName(`${n} 2`), `${main} 2`);
      assert.equal(asProfile({ id: 'g', name: n, sram: new Uint8Array(), timestamp: 0 }).name, main);
      // Sync hashes this: the name as stored, as shown (and sent) and as another device stores it must agree.
      assert.equal(neutralName(mainName(n)), neutralName(n));
      assert.equal(neutralName(`${n} 2`), 'Main 2');
    }
    assert.equal(mainName('Mainly'), 'Mainly');
    assert.equal(mainName('Léa'), 'Léa');
    assert.equal(neutralName('Léa'), 'Léa');
  }
  setLang('en');
  assert.ok(DICTS.fr && DICTS.es);
});
