import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feed, paperRgba, parseJob, PAPER_W, INK } from './paper.ts';

const job = (margins: number, rows: number, shade = 1) => {
  const raw = new Uint8Array(2 + rows * PAPER_W).fill(shade);
  raw[0] = margins; raw[1] = 0x40;
  return parseJob(raw)!;
};

test('parseJob reads margins and refuses ragged data', () => {
  const j = job(0x13, 16);
  assert.equal(j.marginBefore, 1);
  assert.equal(j.marginAfter, 3);
  assert.equal(j.shades.length, 16 * PAPER_W);
  assert.equal(parseJob(new Uint8Array(2)), null);
  assert.equal(parseJob(new Uint8Array(2 + 100)), null);
});

test('jobs without a feed after them join one strip; a feed finishes it', () => {
  let p = feed(null, job(0x10, 16, 1));
  assert.equal(p.done, false);
  p = feed(p, job(0x00, 16, 2));
  p = feed(p, job(0x03, 8, 3));
  assert.equal(p.rows, 40);
  assert.equal(p.done, true);
  assert.deepEqual([p.shades[0], p.shades[16 * PAPER_W], p.shades[39 * PAPER_W]], [1, 2, 3]);
  const next = feed(p, job(0x03, 8, 0));
  assert.equal(next.rows, 8, 'a finished strip is never extended');
});

test('paperRgba scales by whole pixels with the paper inks', () => {
  const shades = new Uint8Array(PAPER_W * 2);
  shades[0] = 3;
  const px = paperRgba(shades, 2);
  assert.equal(px.length, PAPER_W * 2 * 2 * 2 * 4);
  const at = (x: number, y: number) => Array.from(px.subarray((y * PAPER_W * 2 + x) * 4, (y * PAPER_W * 2 + x) * 4 + 3));
  assert.deepEqual(at(1, 1), INK[3]);
  assert.deepEqual(at(2, 0), INK[0]);
});
