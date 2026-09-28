import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLang, setLang } from '../../i18n/core.ts';
import { deviceName, guessName, migrateName, nameToStore } from './status.ts';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

test('the default device name follows the language; a chosen one never changes', async () => {
  await loadLang('fr');
  setLang('fr');
  try {
    assert.equal(guessName(ANDROID), 'Téléphone Android');
    assert.equal(guessName(WINDOWS), 'PC Windows · Chrome');
    // No name chosen: the default, in the language shown now (and so, sent to the other devices).
    assert.equal(deviceName({ name: '' }), guessName());
    assert.equal(deviceName({ name: 'Léa' }), 'Léa');
    // Typing the default back means "no name of my own".
    assert.equal(nameToStore(guessName()), '');
    assert.equal(nameToStore('Léa'), 'Léa');
    // A default stored in English by an earlier version becomes "no name chosen"; anything else is kept.
    assert.equal(migrateName('Android phone', ANDROID), '');
    assert.equal(migrateName('Windows PC · Chrome', WINDOWS), '');
    assert.equal(migrateName('Mon PC', WINDOWS), 'Mon PC');
  } finally {
    setLang('en');
  }
  assert.equal(guessName(ANDROID), 'Android phone');
});
