import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFile, renderPost, DISCLAIMER, DISCLAIMER_SHORT } from '../src/parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures/pillar-x.md');

test('parses every post and ignores surrounding prose', () => {
  const posts = parseFile(FIXTURE);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map((p) => p.id), ['A1', 'A2', 'B1']);
});

test('splits id into pillar and sequence', () => {
  const [a1] = parseFile(FIXTURE);
  assert.equal(a1.pillar, 'A');
  assert.equal(a1.seq, 1);
  assert.equal(a1.title, 'Pinned example');
});

test('extracts the figure number from an annotation', () => {
  const posts = parseFile(FIXTURE);
  assert.equal(posts[0].figure, 14);
  assert.equal(posts[2].figure, 9);
});

test('a post with no annotation has no figure and is not pinned', () => {
  const [, a2] = parseFile(FIXTURE);
  assert.equal(a2.figure, null);
  assert.equal(a2.pinned, false);
  assert.equal(a2.note, null);
});

test('detects the pinned post', () => {
  const posts = parseFile(FIXTURE);
  assert.equal(posts[0].pinned, true);
  assert.equal(posts.filter((p) => p.pinned).length, 1);
});

test('preserves internal blank lines in the body', () => {
  const [a1] = parseFile(FIXTURE);
  assert.equal(a1.body, 'First line of the body.\n\nSecond stanza after a blank line.');
});

test('records source file and line for every post', () => {
  for (const p of parseFile(FIXTURE)) {
    assert.equal(p.sourceFile, FIXTURE);
    assert.ok(p.sourceLine > 0, `${p.id} has no source line`);
  }
});

test('renderPost appends the disclaimer to pillar B only', () => {
  const posts = parseFile(FIXTURE);
  const [a1, , b1] = posts;
  assert.ok(renderPost(b1).endsWith(DISCLAIMER), 'B post should carry the disclaimer');
  assert.equal(renderPost(a1), a1.body, 'A post should be unchanged');
  assert.ok(!renderPost(a1).includes('legal advice'));
});

test('renderPost can use the short disclaimer', () => {
  const b1 = parseFile(FIXTURE)[2];
  assert.ok(renderPost(b1, { shortDisclaimer: true }).endsWith(DISCLAIMER_SHORT));
});

test('the disclaimer is separated from the body by a blank line', () => {
  const b1 = parseFile(FIXTURE)[2];
  assert.ok(renderPost(b1).includes(`${b1.body}\n\n`));
});
