// node --test: reading Claude's reply (no network: the request itself is exercised in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, parseResult } from './providers.ts';

test("Claude's JSON reply, with or without a fence or prose around it", () => {
  assert.deepEqual(parseResult('{"source": "むらの ためにも", "translation": "For the village"}'), { source: 'むらの ためにも', translation: 'For the village' });
  assert.deepEqual(parseResult('```json\n{"source":"はい","translation":"Oui"}\n```'), { source: 'はい', translation: 'Oui' });
  assert.deepEqual(parseResult('Here: {"translation": " Sí "}'), { source: undefined, translation: 'Sí' });
});

test('a reply that is not JSON is the translation itself', () => {
  assert.deepEqual(parseResult('Yes'), { translation: 'Yes' });
  assert.deepEqual(parseResult('{broken'), { translation: '{broken' });
});

test('HTTP errors in plain words: a refused key, a rate limit, no credit, else the API message', () => {
  assert.equal(errorText(401, 'invalid x-api-key'), 'The API key was refused');
  assert.equal(errorText(429), 'Too many requests: wait a moment');
  assert.equal(errorText(400, 'Your credit balance is too low to access the Anthropic API.'), 'No credit left on this key');
  assert.equal(errorText(400, 'max_tokens: too large'), 'max_tokens: too large');
  assert.equal(errorText(529), 'Error 529');
});
