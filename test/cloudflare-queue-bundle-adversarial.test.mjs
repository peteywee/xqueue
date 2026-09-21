// Adversarial / negative tests for the Cloudflare queue integrity gate.
//
// Everything here is written from the attacker's side: the question is never
// "does the happy path work" but "can ok:true be produced by anything other
// than the real canonical queue plus an agreeing D1 mirror".
//
// The companion suite (cloudflare-queue-bundle.test.mjs) covers the intended
// behaviour. This file covers the edges, the type confusion, the prototype
// chain, and the emission step of the generator.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CANONICAL_QUEUE_JSON,
  DECLARED_DEFERRED_TAIL,
} from '../cloudflare/generated/queue-bundle.mjs';

import {
  EXPECTED_DEFERRED_TAIL,
  EXPECTED_QUEUE_COUNT,
  EXPECTED_QUEUE_SHA256,
  computeBundleIntegrity,
  decodeBundledQueue,
  readD1QueueMetadata,
  sha256Hex,
  verifyQueueIntegrity,
} from '../cloudflare/src/queue-integrity.mjs';

import worker from '../cloudflare/src/worker.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL_SHA256 =
  '1f663cfada29a86ae861adc9f46918e8876b251c0d522517e67e3fdbed45ed7d';

function fakeEnv(rows) {
  return {
    DB: {
      prepare(sql) {
        assert.match(sql, /^\s*SELECT\b/, 'D1 access must be read-only SELECT');
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: rows };
          },
        };
      },
    },
  };
}

function healthyEnv() {
  return fakeEnv([
    { key: 'queue.sha256', value: CANONICAL_SHA256 },
    { key: 'queue.count', value: '180' },
  ]);
}

function canonicalize(queue) {
  return `${JSON.stringify(queue, null, 2)}\n`;
}

/** A bundle override whose declared sha matches its own text. */
async function selfConsistent(canonicalText, extra = {}) {
  return {
    canonicalText,
    declaredSha256: await sha256Hex(canonicalText),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. The queue content itself must be pinned, not merely self-consistent.
// ---------------------------------------------------------------------------

test('the gate pins the canonical sha independently of the bundle', () => {
  assert.equal(EXPECTED_QUEUE_SHA256, CANONICAL_SHA256);

  const source = readFileSync(
    join(ROOT, 'cloudflare', 'src', 'queue-integrity.mjs'),
    'utf8',
  );

  assert.ok(
    source.includes(CANONICAL_SHA256),
    'the expected sha must be hardcoded in the gate, not read from the bundle',
  );
});

test('attack: a forged bundle that is internally consistent and mirrored in D1', async () => {
  // 173 of 180 posts rewritten. Count, unique IDs and the deferred tail are all
  // still correct, the declared sha matches the forged text, and the D1 mirror
  // echoes the forged sha. Only an independently pinned sha can catch this.
  const real = decodeBundledQueue();
  const forged = real.map((post, index) =>
    index < real.length - EXPECTED_DEFERRED_TAIL.length
      ? { ...post, title: 'ATTACKER CONTENT', body: 'attacker body', figure: 999 }
      : post,
  );

  const text = canonicalize(forged);
  const forgedSha = await sha256Hex(text);

  assert.equal(forged.length, 180);
  assert.equal(new Set(forged.map((post) => post.id)).size, 180);
  assert.notEqual(forgedSha, CANONICAL_SHA256);

  const verdict = await verifyQueueIntegrity(
    fakeEnv([
      { key: 'queue.sha256', value: forgedSha },
      { key: 'queue.count', value: '180' },
    ]),
    { canonicalText: text, declaredSha256: forgedSha },
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_canonical_sha_mismatch');
  assert.equal(verdict.computedSha256, forgedSha);
  assert.equal(verdict.expectedSha256, CANONICAL_SHA256);
});

test('attack: a single altered post body cannot be laundered by a matching mirror', async () => {
  const real = decodeBundledQueue();
  const altered = real.map((post, index) =>
    index === 5 ? { ...post, body: `${post.body} (tampered)` } : post,
  );

  const text = canonicalize(altered);
  const sha = await sha256Hex(text);

  const verdict = await verifyQueueIntegrity(
    fakeEnv([{ key: 'queue.sha256', value: sha }]),
    { canonicalText: text, declaredSha256: sha },
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_canonical_sha_mismatch');
});

// ---------------------------------------------------------------------------
// 2. DECLARED_DEFERRED_TAIL must actually be verified.
// ---------------------------------------------------------------------------

test('the bundle-declared deferred tail is verified, not decorative', async () => {
  const forgeries = [
    [],
    null,
    undefined,
    'garbage',
    [{ id: 'ZZ', scheduledDate: '1999-01-01', scheduledTime: '00:00', timezone: 'UTC' }],
    EXPECTED_DEFERRED_TAIL.slice(0, 2),
    EXPECTED_DEFERRED_TAIL.map((row) =>
      row.id === 'C1' ? { ...row, timezone: 'America/New_York' } : row,
    ),
    [...EXPECTED_DEFERRED_TAIL].reverse(),
  ];

  for (const declaredDeferredTail of forgeries) {
    const verdict = await verifyQueueIntegrity(healthyEnv(), {
      declaredDeferredTail,
    });

    assert.equal(
      verdict.ok,
      false,
      `declared tail ${JSON.stringify(declaredDeferredTail)} must not pass`,
    );
    assert.equal(verdict.reason, 'bundle_declared_tail_mismatch');
  }
});

test('the shipped bundle declares the real deferred tail', async () => {
  assert.deepEqual(DECLARED_DEFERRED_TAIL, EXPECTED_DEFERRED_TAIL);

  const verdict = await verifyQueueIntegrity(healthyEnv());
  assert.equal(verdict.ok, true);
});

// ---------------------------------------------------------------------------
// 3. Prototype chain: inherited values are not evidence.
// ---------------------------------------------------------------------------

test('a __proto__ row cannot forge an inherited queue.sha256', async () => {
  const rows = [
    {
      key: '__proto__',
      value: { 'queue.sha256': CANONICAL_SHA256, 'queue.count': '180' },
    },
  ];

  const metadata = await readD1QueueMetadata(fakeEnv(rows));

  assert.equal(
    Object.getPrototypeOf(metadata),
    null,
    'the metadata map must not inherit from Object.prototype',
  );

  const verdict = await verifyQueueIntegrity(fakeEnv(rows));

  assert.equal(verdict.ok, false, 'no real queue.sha256 row existed');
  assert.equal(verdict.reason, 'd1_queue_sha256_missing');
  assert.equal(Object.prototype['queue.sha256'], undefined);
});

test('Object.prototype pollution elsewhere cannot satisfy the D1 read', async () => {
  Object.prototype['queue.sha256'] = CANONICAL_SHA256;
  Object.prototype['queue.count'] = '180';

  try {
    const verdict = await verifyQueueIntegrity(fakeEnv([]));

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'd1_queue_sha256_missing');
    assert.equal(verdict.d1Sha256, null);
  } finally {
    delete Object.prototype['queue.sha256'];
    delete Object.prototype['queue.count'];
  }
});

test('constructor and toString rows do not disturb the real lookup', async () => {
  const verdict = await verifyQueueIntegrity(
    fakeEnv([
      { key: 'constructor', value: 'x' },
      { key: 'toString', value: 'y' },
      { key: 'valueOf', value: 'z' },
      { key: 'queue.sha256', value: CANONICAL_SHA256 },
      { key: 'queue.count', value: '180' },
    ]),
  );

  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
});

// ---------------------------------------------------------------------------
// 4. D1 count type confusion.
// ---------------------------------------------------------------------------

test('only a well-formed D1 count of 180 satisfies the count check', async () => {
  const accepted = ['180', 180];
  const rejected = [
    ' 180',
    '180 ',
    '\n180\t',
    '0180',
    '1.8e2',
    '180.0',
    '+180',
    '0xB4',
    '0xb4',
    '180abc',
    '  ',
    true,
    false,
    [],
    [180],
    ['180'],
    180.5,
    179,
    '179',
    'Infinity',
    { valueOf: () => 180 },
    new String('180'),
  ];

  for (const value of accepted) {
    const verdict = await verifyQueueIntegrity(
      fakeEnv([
        { key: 'queue.sha256', value: CANONICAL_SHA256 },
        { key: 'queue.count', value },
      ]),
    );
    assert.equal(verdict.ok, true, `${JSON.stringify(value)} should be accepted`);
  }

  for (const value of rejected) {
    const verdict = await verifyQueueIntegrity(
      fakeEnv([
        { key: 'queue.sha256', value: CANONICAL_SHA256 },
        { key: 'queue.count', value },
      ]),
    );
    assert.equal(
      verdict.ok,
      false,
      `${String(value)} must not satisfy the D1 count check`,
    );
    assert.equal(verdict.reason, 'd1_queue_count_mismatch');
  }
});

test('the documented tolerance for an absent count row is preserved', async () => {
  for (const rows of [
    [{ key: 'queue.sha256', value: CANONICAL_SHA256 }],
    [
      { key: 'queue.sha256', value: CANONICAL_SHA256 },
      { key: 'queue.count', value: null },
    ],
    [
      { key: 'queue.sha256', value: CANONICAL_SHA256 },
      { key: 'queue.count', value: '' },
    ],
  ]) {
    const verdict = await verifyQueueIntegrity(fakeEnv(rows));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, null);
  }
});

// ---------------------------------------------------------------------------
// 5. D1 sha comparison is exact.
// ---------------------------------------------------------------------------

test('the D1 sha comparison is case sensitive and whitespace sensitive', async () => {
  const variants = [
    CANONICAL_SHA256.toUpperCase(),
    `${CANONICAL_SHA256} `,
    ` ${CANONICAL_SHA256}`,
    `${CANONICAL_SHA256}\n`,
    CANONICAL_SHA256.slice(0, 63),
    `0x${CANONICAL_SHA256}`,
  ];

  for (const value of variants) {
    const verdict = await verifyQueueIntegrity(
      fakeEnv([{ key: 'queue.sha256', value }]),
    );

    assert.equal(verdict.ok, false, `${JSON.stringify(value)} must not pass`);
    assert.equal(verdict.reason, 'd1_queue_sha256_mismatch');
  }
});

test('a non-string D1 sha is missing evidence, not a mismatch', async () => {
  for (const value of [null, undefined, 9, {}, [], true, '']) {
    const verdict = await verifyQueueIntegrity(
      fakeEnv([{ key: 'queue.sha256', value }]),
    );

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'd1_queue_sha256_missing');
    assert.equal(verdict.d1Sha256, null);
  }
});

// ---------------------------------------------------------------------------
// 6. Hostile D1 bindings. The gate must fail closed and must never throw.
// ---------------------------------------------------------------------------

test('hostile or malformed D1 bindings all fail closed without throwing', async () => {
  const bindings = {
    'all() rejects': { prepare: () => ({ bind() { return this; }, all: () => Promise.reject(new Error('boom')) }) },
    'all() throws synchronously': { prepare: () => ({ bind() { return this; }, all() { throw new Error('sync'); } }) },
    'all() resolves to null': { prepare: () => ({ bind() { return this; }, all: async () => null }) },
    'all() resolves to a string': { prepare: () => ({ bind() { return this; }, all: async () => 'nope' }) },
    'all() resolves to a number': { prepare: () => ({ bind() { return this; }, all: async () => 7 }) },
    'results is null': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: null }) }) },
    'results is a string': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: 'abc' }) }) },
    'results is a plain object': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: {} }) }) },
    'results is [null, null]': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [null, null] }) }) },
    'row has key but no value': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [{ key: 'queue.sha256' }] }) }) },
    'row key getter throws': { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [{ get key() { throw new Error('x'); } }] }) }) },
    'bind() returns undefined': { prepare: () => ({ bind: () => undefined, all: async () => ({ results: [] }) }) },
    'prepare throws': { prepare() { throw new Error('nope'); } },
    'prepare returns null': { prepare: () => null },
    'prepare is not a function': { prepare: 42 },
    'DB is a string': 'not-a-db',
  };

  for (const [name, DB] of Object.entries(bindings)) {
    const verdict = await verifyQueueIntegrity({ DB });

    assert.equal(verdict.ok, false, `${name} must not pass`);
    assert.ok(
      ['d1_unreachable', 'd1_queue_sha256_missing'].includes(verdict.reason),
      `${name} produced unexpected reason ${verdict.reason}`,
    );
  }
});

test('an env whose property access throws still yields a verdict', async () => {
  const hostile = [
    new Proxy({}, { get() { throw new Error('proxy trap'); } }),
    { get DB() { throw new Error('getter'); } },
    { DB: new Proxy({}, { get() { throw new Error('db trap'); } }) },
  ];

  for (const env of hostile) {
    const verdict = await verifyQueueIntegrity(env);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'd1_unreachable');
  }
});

test('a D1 driver that omits bind() still gets a bound-free read', async () => {
  const verdict = await verifyQueueIntegrity({
    DB: {
      prepare: () => ({
        async all() {
          return {
            results: [
              { key: 'queue.sha256', value: CANONICAL_SHA256 },
              { key: 'queue.count', value: '180' },
            ],
          };
        },
      }),
    },
  });

  assert.equal(verdict.ok, true);
});

test('a top-level array result set is accepted as rows', async () => {
  const verdict = await verifyQueueIntegrity({
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async all() {
          return [
            { key: 'queue.sha256', value: CANONICAL_SHA256 },
            { key: 'queue.count', value: '180' },
          ];
        },
      }),
    },
  });

  assert.equal(verdict.ok, true);
});

// ---------------------------------------------------------------------------
// 7. Boundaries and check ordering.
// ---------------------------------------------------------------------------

test('boundary queue lengths never reach ok:true', async () => {
  const real = decodeBundledQueue();

  const cases = [
    ['179 posts', real.slice(0, 179), {}],
    ['181 posts', [...real, { ...real[0], id: 'ZZ' }], {}],
    ['2 posts, declaredCount 2', real.slice(0, 2), { declaredCount: 2 }],
    ['1 post, declaredCount 1', real.slice(0, 1), { declaredCount: 1 }],
    ['0 posts, declaredCount 0', [], { declaredCount: 0 }],
  ];

  for (const [name, queue, extra] of cases) {
    const verdict = await verifyQueueIntegrity(
      healthyEnv(),
      await selfConsistent(canonicalize(queue), extra),
    );

    assert.equal(verdict.ok, false, `${name} must not pass`);
    assert.equal(verdict.reason, 'bundle_count_mismatch', name);
  }
});

test('a short queue still produces a sane tail slice rather than throwing', async () => {
  const real = decodeBundledQueue();

  for (const length of [0, 1, 2, 3]) {
    const integrity = await computeBundleIntegrity({
      canonicalText: canonicalize(real.slice(0, length)),
    });

    assert.equal(integrity.count, length);
    assert.equal(integrity.deferredTail.length, Math.min(length, 3));
  }
});

test('a tail differing only by timezone is rejected', async () => {
  const real = decodeBundledQueue();
  const mutated = real.map((post, index) =>
    index === real.length - 2 ? { ...post, timezone: 'America/New_York' } : post,
  );

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(mutated)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_deferred_tail_mismatch');
});

test('two swapped tail entries are rejected', async () => {
  const real = decodeBundledQueue();
  const mutated = [...real];
  [mutated[177], mutated[178]] = [mutated[178], mutated[177]];

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(mutated)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_deferred_tail_mismatch');
});

test('check ordering: the earliest violated check wins and nothing is masked', async () => {
  const real = decodeBundledQueue();

  // Short queue AND duplicate IDs -> count is reported.
  const shortAndDuplicated = real.slice(0, 178);
  shortAndDuplicated[1] = { ...shortAndDuplicated[1], id: shortAndDuplicated[0].id };
  assert.equal(
    (
      await verifyQueueIntegrity(
        healthyEnv(),
        await selfConsistent(canonicalize(shortAndDuplicated)),
      )
    ).reason,
    'bundle_count_mismatch',
  );

  // Duplicate IDs AND a broken tail -> duplicates are reported.
  const duplicatedAndBadTail = real.map((post, index) => {
    if (index === 1) return { ...post, id: real[0].id };
    if (index === real.length - 1) return { ...post, scheduledTime: '09:09' };
    return post;
  });
  assert.equal(
    (
      await verifyQueueIntegrity(
        healthyEnv(),
        await selfConsistent(canonicalize(duplicatedAndBadTail)),
      )
    ).reason,
    'bundle_duplicate_post_ids',
  );

  // A broken bundle AND an unreachable D1 -> the bundle failure is reported,
  // so a D1 outage can never hide bundle tampering.
  const badTail = real.map((post, index) =>
    index === real.length - 1 ? { ...post, scheduledTime: '09:09' } : post,
  );
  assert.equal(
    (
      await verifyQueueIntegrity(
        { DB: null },
        await selfConsistent(canonicalize(badTail)),
      )
    ).reason,
    'bundle_deferred_tail_mismatch',
  );

  // Every bundle check failing at once -> the declared sha, the first check.
  assert.equal(
    (
      await verifyQueueIntegrity(fakeEnv([]), {
        canonicalText: canonicalize(real.slice(0, 3)),
      })
    ).reason,
    'bundle_declared_sha_mismatch',
  );
});

test('every failure verdict keeps ok:false and never claims a reason of null', async () => {
  const real = decodeBundledQueue();

  const verdicts = await Promise.all([
    verifyQueueIntegrity(healthyEnv(), { canonicalText: '{' }),
    verifyQueueIntegrity(healthyEnv(), { canonicalText: 'null' }),
    verifyQueueIntegrity(healthyEnv(), { canonicalText: '{}' }),
    verifyQueueIntegrity(healthyEnv(), { canonicalText: '[]' }),
    verifyQueueIntegrity(healthyEnv(), { canonicalText: '' }),
    verifyQueueIntegrity(healthyEnv(), { declaredCount: 179 }),
    verifyQueueIntegrity(healthyEnv(), { declaredSha256: 'nope' }),
    verifyQueueIntegrity(healthyEnv(), { declaredDeferredTail: [] }),
    verifyQueueIntegrity(fakeEnv([])),
    verifyQueueIntegrity(undefined),
    verifyQueueIntegrity(
      healthyEnv(),
      await selfConsistent(canonicalize(real.slice(0, 179))),
    ),
  ]);

  for (const verdict of verdicts) {
    assert.equal(verdict.ok, false);
    assert.equal(typeof verdict.reason, 'string');
    assert.ok(verdict.reason.length > 0);
    assert.equal(verdict.expectedCount, EXPECTED_QUEUE_COUNT);
    assert.equal(verdict.expectedSha256, EXPECTED_QUEUE_SHA256);
  }
});

// ---------------------------------------------------------------------------
// 8. sha256Hex encoding behaviour.
// ---------------------------------------------------------------------------

test('sha256Hex separates normalization forms and is stable on astral planes', async () => {
  const nfc = 'é'.normalize('NFC');
  const nfd = 'é'.normalize('NFD');

  assert.notEqual(nfc, nfd);
  assert.notEqual(await sha256Hex(nfc), await sha256Hex(nfd));

  assert.equal(await sha256Hex('\u{1F600}'), await sha256Hex('😀'));
  assert.equal(
    (await sha256Hex('')).length,
    64,
    'the empty string still hashes to 64 hex characters',
  );
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('lone surrogates collapse to U+FFFD, which the canonical bytes never contain', async () => {
  // Documented consequence of TextEncoder: unpaired surrogates are replaced.
  // Two distinct JS strings therefore hash identically. This is only safe
  // because JSON.stringify escapes lone surrogates, so canonical queue text
  // can never carry one raw. Pin both halves of that argument.
  const high = await sha256Hex('\uD800');
  const low = await sha256Hex('\uDC00');
  const replacement = await sha256Hex('\ufffd');

  assert.equal(high, low);
  assert.equal(high, replacement);

  assert.equal(JSON.stringify('\uD800'), '"\\ud800"');
  assert.ok(
    ![...CANONICAL_QUEUE_JSON].some((ch) => {
      const code = ch.codePointAt(0);
      return code >= 0xd800 && code <= 0xdfff;
    }),
    'the shipped canonical text must contain no unpaired surrogate',
  );
});

// ---------------------------------------------------------------------------
// 9. Generator emission: JSON string escaping vs JS string literal semantics.
// ---------------------------------------------------------------------------

test('JSON.stringify emits U+2028 and U+2029 raw, and the module still parses', async () => {
  // These are legal raw inside a JSON string and, since ES2019, legal raw
  // inside a JS string literal too. JSON.stringify does NOT escape them, so
  // the generator relies on the ES2019 JSON-superset semantics. Prove that the
  // emitted module both parses and round-trips byte for byte.
  assert.equal(JSON.stringify('\u2028'), '"\u2028"');
  assert.equal(JSON.stringify('\u2029'), '"\u2029"');
  assert.ok(JSON.stringify('\u2028').includes('\u2028'), 'U+2028 is emitted raw');

  const hostile = {
    lineSeparator: '[{"id":"A\u2028B"}]\n',
    paragraphSeparator: '[{"id":"A\u2029B"}]\n',
    both: '\u2028\u2029',
    trailingSeparator: 'x\u2028',
    loneHighSurrogate: 'A\uD800B',
    loneLowSurrogate: 'A\uDFFFB',
    nul: 'a\u0000b',
    backtickAndDollarBrace: 'a`b${c}d',
    backslashes: 'a\\b\\\\c\\u0041',
    newlines: 'a\rb\nc\r\nd',
    closeScript: '</script><!--',
    byteOrderMark: '\ufeffabc',
    astral: '\u{1F600}\u{1D7D8}',
    controls: 'a\u007fb\u0085c\u009fd',
    zeroWidth: 'a\u00a0b\u200bc\u2060d',
    rtlOverride: 'a\u202eb',
  };

  const dir = mkdtempSync(join(tmpdir(), 'xqueue-emit-'));

  let index = 0;
  for (const [name, text] of Object.entries(hostile)) {
    // Exactly the generator's emission step.
    const source = [
      'export const BUNDLE_FORMAT = 1;',
      '',
      `export const CANONICAL_QUEUE_JSON = ${JSON.stringify(text)};`,
      '',
    ].join('\n');

    const file = join(dir, `case-${index++}.mjs`);
    writeFileSync(file, source, 'utf8');

    const mod = await import(pathToFileURL(file).href);

    assert.equal(
      mod.CANONICAL_QUEUE_JSON,
      text,
      `${name} did not round-trip through the emitted module`,
    );
  }
});

test('the shipped generated bundle round-trips and carries no raw separators', () => {
  const file = join(ROOT, 'cloudflare', 'generated', 'queue-bundle.mjs');
  const source = readFileSync(file, 'utf8');

  assert.ok(!source.includes('\u2028'));
  assert.ok(!source.includes('\u2029'));
  assert.ok(!source.includes('`'), 'the bundle must not use template literals');

  // The literal in the file re-parses to exactly the imported constant.
  const match = source.match(/export const CANONICAL_QUEUE_JSON = ("(?:[^"\\]|\\.)*");/s);
  assert.ok(match, 'CANONICAL_QUEUE_JSON literal not found');
  assert.equal(JSON.parse(match[1]), CANONICAL_QUEUE_JSON);
});

test('the generator writes a source file that node can parse and re-parse', () => {
  const source = readFileSync(
    join(ROOT, 'scripts', 'build-cloudflare-queue-bundle.mjs'),
    'utf8',
  );

  // Guard the escaping contract itself: template literals or String.raw in the
  // emission step would reintroduce backtick and ${ injection.
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/String\.raw/.test(code));
  assert.ok(
    source.includes('JSON.stringify(canonicalText)'),
    'canonical text must be emitted through JSON.stringify',
  );
});

// ---------------------------------------------------------------------------
// 10. Worker /health never reports health it cannot prove.
// ---------------------------------------------------------------------------

function workerDb(rows, { masterOk = true } = {}) {
  return {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) {
        return {
          async first() {
            if (!masterOk) throw new Error('D1_ERROR: master unavailable');
            return { count: 4 };
          },
        };
      }
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows };
        },
      };
    },
  };
}

const HEALTHY_ROWS = [
  { key: 'queue.sha256', value: CANONICAL_SHA256 },
  { key: 'queue.count', value: '180' },
];

test('/health is 200 and ok only when every check passes', async () => {
  const response = await worker.fetch(new Request('https://x/health'), {
    DB: workerDb(HEALTHY_ROWS),
    MEDIA: { async list() { return { objects: [] }; } },
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.livePublication, false);
  assert.equal(body.schedulerAuthority, false);
  assert.equal(body.queueIntegrity.ok, true);
});

test('/health degrades to 503 error for every broken binding, never claiming authority', async () => {
  const R2_OK = { async list() { return { objects: [] }; } };

  const envs = {
    'D1 mirror sha wrong': {
      DB: workerDb([{ key: 'queue.sha256', value: 'deadbeef' }]),
      MEDIA: R2_OK,
    },
    'D1 mirror empty': { DB: workerDb([]), MEDIA: R2_OK },
    'MEDIA binding missing': { DB: workerDb(HEALTHY_ROWS) },
    'MEDIA is null': { DB: workerDb(HEALTHY_ROWS), MEDIA: null },
    'R2 list throws': {
      DB: workerDb(HEALTHY_ROWS),
      MEDIA: { async list() { throw new Error('R2 down'); } },
    },
    'R2 list has no objects field': {
      DB: workerDb(HEALTHY_ROWS),
      MEDIA: { async list() { return {}; } },
    },
    'DB binding missing': { MEDIA: R2_OK },
    'empty env': {},
    'sqlite_master query fails': {
      DB: workerDb(HEALTHY_ROWS, { masterOk: false }),
      MEDIA: R2_OK,
    },
    'env property access throws': {
      get DB() {
        throw new Error('binding access exploded');
      },
      MEDIA: R2_OK,
    },
  };

  for (const [name, env] of Object.entries(envs)) {
    const response = await worker.fetch(new Request('https://x/health'), env);
    const body = await response.json();

    assert.equal(response.status, 503, name);
    assert.equal(body.status, 'error', name);
    assert.equal(body.livePublication, false, name);
    assert.equal(body.schedulerAuthority, false, name);
    assert.notEqual(body.queueIntegrity?.ok, true, name);
  }
});

test('the worker exposes no route other than /health and never publishes', async () => {
  const env = {
    DB: workerDb(HEALTHY_ROWS),
    MEDIA: { async list() { return { objects: [] }; } },
  };

  for (const path of ['/', '/post', '/publish', '/health/', '/HEALTH']) {
    const response = await worker.fetch(new Request(`https://x${path}`), env);

    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' }, path);
  }

  const source = readFileSync(
    join(ROOT, 'cloudflare', 'src', 'worker.mjs'),
    'utf8',
  );

  assert.ok(!/X_API|X_ACCESS|api\.(x|twitter)\.com|tweet/i.test(source));
});

test('scheduled() refuses to act and logs no authority', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);

  try {
    await worker.scheduled({ scheduledTime: 1 }, {}, {});
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);

  const logged = JSON.parse(lines[0]);
  assert.equal(logged.livePublication, false);
  assert.equal(logged.schedulerAuthority, false);
  assert.match(logged.result, /ignored/);
});

// ---------------------------------------------------------------------------
// 11. The gate reads D1 read-only.
// ---------------------------------------------------------------------------

test('the integrity module contains no D1 write statement', () => {
  const source = readFileSync(
    join(ROOT, 'cloudflare', 'src', 'queue-integrity.mjs'),
    'utf8',
  );

  const statements = source.match(/prepare\(\s*`([^`]*)`/gs) ?? [];

  assert.equal(statements.length, 1, 'exactly one D1 statement is prepared');
  assert.match(statements[0], /SELECT\s+key,\s*value/);
  assert.ok(
    !/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|PRAGMA|ATTACH)\b/i.test(
      statements[0],
    ),
    'only SELECT may appear in the integrity module',
  );
});
