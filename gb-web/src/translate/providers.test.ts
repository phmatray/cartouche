// node --test: reading Claude's reply (no network: the request itself is exercised in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResult } from './providers.ts';

test("Claude's JSON reply, with or without a fence or prose around it", () => {
  assert.deepEqual(parseResult('{"source": "むらの ためにも", "translation": "For the village"}'), { source: 'むらの ためにも', translation: 'For the village' });
  assert.deepEqual(parseResult('```json\n{"source":"はい","translation":"Oui"}\n```'), { source: 'はい', translation: 'Oui' });
  assert.deepEqual(parseResult('Here: {"translation": " Sí "}'), { source: undefined, translation: 'Sí' });
});

test('a reply that is not JSON is the translation itself', () => {
  assert.deepEqual(parseResult('Yes'), { translation: 'Yes' });
  assert.deepEqual(parseResult('{broken'), { translation: '{broken' });
});
