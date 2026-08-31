import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validate, summarize, LIMIT_FREE } from '../src/validate.mjs';
import { renderPost } from '../src/parse.mjs';

/** Minimal post object; body is the only thing most rules look at. */
const post = (over = {}) => ({
  id: 'A1', pillar: 'A', seq: 1, title: 'Test', figure: null, pinned: false,
  sourceFile: 'test', sourceLine: 1,
  body: 'A perfectly ordinary post body that says something about margins and covers.',
  ...over,
});

const rules = (findings, level = null) =>
  findings.filter((f) => !level || f.level === level).map((f) => f.rule);

test('a clean post produces no findings', () => {
  assert.deepEqual(validate([post()]), []);
});

// --- §9 rule: never name your employer ------------------------------------

test('a blocked employer name is an error', () => {
  const f = validate([post({ body: 'Back when I worked at Uncle Julio\'s the fryer was the bottleneck.' })]);
  assert.ok(rules(f, 'error').includes('employer-name'));
});

test('employer matching is case-insensitive', () => {
  const f = validate([post({ body: 'A story about SUN HOLDINGS and their scheduling.' })]);
  assert.ok(rules(f, 'error').includes('employer-name'));
});

test('an unrelated kitchen anecdote is not flagged', () => {
  const f = validate([post({ body: 'A kitchen I worked in had a walk-in that died every August.' })]);
  assert.equal(rules(f, 'error').length, 0);
});

// --- §9 rule: no unauthorized customer or pilot claims ---------------------

test('claiming customers is an error', () => {
  const f = validate([post({ body: 'The thing my customers pay me for is the content, not the code.' })]);
  assert.ok(rules(f, 'error').includes('unauthorized-claim'));
});

test('claiming a pilot at a named place is an error', () => {
  const f = validate([post({ body: 'Running a pilot with a regional group starting Monday.' })]);
  assert.ok(rules(f, 'error').includes('unauthorized-claim'));
});

test('claiming adoption counts is an error', () => {
  const f = validate([post({ body: 'Now 14 restaurants use it every day.' })]);
  assert.ok(rules(f, 'error').includes('unauthorized-claim'));
});

test('regression: commentary about vendor case studies is not a claim', () => {
  const f = validate([post({ body: 'Which is a good description of why most vendor case studies read the way they do.' })]);
  assert.equal(rules(f, 'error').length, 0);
});

// --- §9 rule: law posts carry the disclaimer -------------------------------

// The disclaimer is a STRUCTURAL guarantee, not a validation result: renderPost
// appends it to every pillar B post, and validate() checks the rendered text.
// So a B post can never reach the wire without it. The validator rule is
// defense-in-depth against renderPost regressing, which is why it cannot be
// made to fire from a well-formed post — that is the point.

test('a pillar B post carries the disclaimer automatically', () => {
  const b = post({ id: 'B1', pillar: 'B', body: 'Tip pools exclude supervisors under the FLSA.' });
  assert.match(renderPost(b), /not legal advice/i);
  assert.equal(rules(validate([b]), 'error').length, 0);
});

test('the disclaimer survives whatever the author wrote in the body', () => {
  for (const body of [
    'Tip pools exclude supervisors under the FLSA and that is not negotiable.',
    'A body that happens to end with a question about overtime exposure?',
    'A body\n\nwith\n\nmany\n\nstanzas about wage and hour recordkeeping duties.',
  ]) {
    assert.match(renderPost(post({ id: 'B1', pillar: 'B', body })), /not legal advice/i);
  }
});

test('validate reads rendered text, not the raw body', () => {
  // This is the mechanism the whole guarantee rests on. If validate() ever
  // switched to checking p.body, a B post would validate clean while the
  // disclaimer check silently stopped meaning anything. The stray-disclaimer
  // rule on an A post proves which text is being inspected.
  const inBody = validate([post({ body: 'Margin talk. General information, not legal advice, obviously.' })]);
  assert.ok(rules(inBody, 'warn').includes('stray-disclaimer'));

  const bPost = post({ id: 'B1', pillar: 'B', body: 'Wage and hour talk with nothing appended by the author.' });
  assert.doesNotMatch(bPost.body, /not legal advice/i, 'the raw body must NOT contain it');
  assert.match(renderPost(bPost), /not legal advice/i, 'the rendered text MUST contain it');
  assert.equal(rules(validate([bPost]), 'error').length, 0, 'so validate sees it and passes');
});

test('a stray disclaimer on a non-B post is a warning', () => {
  const f = validate([post({ body: 'Some margin talk. General information, not legal advice.' })]);
  assert.ok(rules(f, 'warn').includes('stray-disclaimer'));
});

// --- Platform constraints --------------------------------------------------

test('a long post is an error without a subscription', () => {
  const f = validate([post({ body: 'x'.repeat(LIMIT_FREE + 1) })], { premium: false });
  assert.ok(rules(f, 'error').includes('length'));
});

test('the same post is only informational with a subscription', () => {
  const f = validate([post({ body: 'x'.repeat(LIMIT_FREE + 1) })], { premium: true });
  assert.equal(rules(f, 'error').length, 0);
  assert.ok(rules(f, 'info').includes('length'));
});

test('a URL in the body is a warning', () => {
  const f = validate([post({ body: 'Read the whole thing at https://example.com/post right now.' })]);
  assert.ok(rules(f, 'warn').includes('url-in-body'));
});

test('a bare domain in the body is caught too', () => {
  const f = validate([post({ body: 'Everything is documented over on t34ch.com for anyone curious.' })]);
  assert.ok(rules(f, 'warn').includes('url-in-body'));
});

test('emoji are flagged as off-voice', () => {
  const f = validate([post({ body: 'Margins are up 🔥 and the fryer is the constraint.' })]);
  assert.ok(rules(f, 'warn').includes('emoji'));
});

test('hashtags are flagged as off-voice', () => {
  const f = validate([post({ body: 'A thought about margin #restaurantlife and covers.' })]);
  assert.ok(rules(f, 'warn').includes('hashtag'));
});

test('regression: "#3" as a list reference is not a hashtag', () => {
  const f = validate([post({ body: 'Station training fails #3 by definition. That is the whole point of it.' })]);
  assert.equal(rules(f, 'warn').length, 0);
});

// --- Structural ------------------------------------------------------------

test('duplicate ids are an error', () => {
  const f = validate([post(), post({ body: 'A different body entirely, about vendors and terms.' })]);
  assert.ok(rules(f, 'error').includes('unique-id'));
});

test('an implausibly short body is an error', () => {
  const f = validate([post({ body: 'Too short.' })]);
  assert.ok(rules(f, 'error').includes('body'));
});

test('substantially similar posts are warned about', () => {
  const body = 'Your rent and insurance do not care how many covers you did tonight, and that is the whole idea behind fixed cost behavior in a restaurant.';
  const f = validate([post({ id: 'A1', body }), post({ id: 'A2', body: body + ' One more clause.' })]);
  assert.ok(rules(f, 'warn').includes('near-duplicate'));
});

test('genuinely different posts are not flagged as duplicates', () => {
  const f = validate([
    post({ id: 'A1', body: 'The walk-in is full of product you over-ordered and that money is already gone.' }),
    post({ id: 'A2', body: 'Teams go through forming, storming, norming and performing on the way to working.' }),
  ]);
  assert.ok(!rules(f).includes('near-duplicate'));
});

// --- Figures ---------------------------------------------------------------

test('a missing figure is an error when the media directory is populated', () => {
  const f = validate([post({ figure: 14 })], { figuresAvailable: new Set([1, 9]) });
  assert.ok(rules(f, 'error').includes('missing-figure'));
});

test('a present figure is clean', () => {
  const f = validate([post({ figure: 9 })], { figuresAvailable: new Set([1, 9]) });
  assert.equal(rules(f, 'error').length, 0);
});

test('an empty media directory does not block the build', () => {
  const f = validate([post({ figure: 14 })], { figuresAvailable: new Set() });
  assert.equal(rules(f, 'error').length, 0);
  assert.ok(rules(f, 'info').includes('figure-unchecked'));
});

test('summarize counts by level', () => {
  const counts = summarize(validate([post({ body: 'See https://example.com for more on this topic and others.' })]));
  assert.equal(counts.warn, 1);
  assert.equal(counts.error, 0);
});
