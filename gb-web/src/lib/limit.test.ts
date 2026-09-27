// node --test: box art downloads go through a limiter (an import of hundreds of ROMs asks for every cover at once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiter } from './limit.ts';

test('runs at most n at a time, every task once, failures included', async () => {
  const limited = limiter(4);
  let now = 0, peak = 0;
  const task = (i: number) => limited(async () => {
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 1 + (i % 3)));
    now--;
    if (i % 7 === 0) throw new Error('404');
    return i;
  });
  const out = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => task(i)));
  assert.equal(peak, 4);
  assert.equal(out.filter((r) => r.status === 'fulfilled').length, 50 - 8);
  // Slots were all handed back: the next batch runs 4 at a time again, not fewer.
  peak = 0;
  await Promise.all(Array.from({ length: 8 }, (_, i) => task(i + 1)).map((p) => p.catch(() => {})));
  assert.equal(peak, 4);
});
