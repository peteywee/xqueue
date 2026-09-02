import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertExpectedIdentity,
  probeReadOnlyIdentity,
  readXBindings,
  sanitizeIdentityEvidence,
} from '../probes/cloudflare-x/identity-contract.mjs';

const secrets = {
  X_API_KEY: 'key-secret-value',
  X_API_SECRET: 'api-secret-value',
  X_ACCESS_TOKEN: 'access-token-value',
  X_ACCESS_SECRET: 'access-secret-value',
};

test('complete bindings are accepted without transformation', () => {
  const result = readXBindings(secrets);
  assert.deepEqual({ ...result }, secrets);
});

test('missing bindings fail closed while never leaking supplied secret values', () => {
  let error;
  try {
    readXBindings({ ...secrets, X_ACCESS_SECRET: '' });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.name, 'XIdentityContractError');
  assert.match(error.message, /X_ACCESS_SECRET/);
  for (const value of Object.values(secrets)) {
    assert.equal(error.message.includes(value), false);
  }
});

test('identity evidence is reduced to id and username only', () => {
  const identity = sanitizeIdentityEvidence({
    data: {
      id: 123,
      username: 'PatrickCra94338',
      name: 'ignored',
      token: 'must-not-survive',
    },
  });
  assert.deepEqual(identity, { id: '123', username: 'PatrickCra94338' });
  assert.equal('token' in identity, false);
});

test('malformed identity responses fail closed', () => {
  assert.throws(() => sanitizeIdentityEvidence(null), /no data/);
  assert.throws(() => sanitizeIdentityEvidence({ data: { id: '1' } }), /missing id or username/);
  assert.throws(() => sanitizeIdentityEvidence({ data: { username: 'x' } }), /missing id or username/);
});

test('expected identity can match by id, username, or both', () => {
  const identity = { id: '123', username: 'PatrickCra94338' };
  assert.equal(assertExpectedIdentity(identity, { id: '123' }), identity);
  assert.equal(assertExpectedIdentity(identity, { username: 'patrickcra94338' }), identity);
  assert.equal(assertExpectedIdentity(identity, { id: '123', username: 'PatrickCra94338' }), identity);
});

test('identity mismatch fails closed without echoing observed or expected values', () => {
  const identity = { id: '123', username: 'PatrickCra94338' };
  assert.throws(() => assertExpectedIdentity(identity, { id: '999' }), /^XIdentityContractError: X identity ID mismatch$/);
  assert.throws(() => assertExpectedIdentity(identity, { username: 'other' }), /^XIdentityContractError: X identity username mismatch$/);
});

test('read-only probe accepts only an injected getMe function', async () => {
  let calls = 0;
  const identity = await probeReadOnlyIdentity({
    getMe: async () => {
      calls += 1;
      return { data: { id: '123', username: 'PatrickCra94338' } };
    },
    expected: { username: 'PatrickCra94338' },
  });
  assert.deepEqual(identity, { id: '123', username: 'PatrickCra94338' });
  assert.equal(calls, 1);
});

test('read-only identity contract has no post or media-upload capability', async () => {
  let writes = 0;
  const client = {
    users: { getMe: async () => ({ data: { id: '1', username: 'safe' } }) },
    posts: { create: async () => { writes += 1; } },
    media: { upload: async () => { writes += 1; } },
  };

  await probeReadOnlyIdentity({
    getMe: client.users.getMe,
    expected: { username: 'safe' },
  });

  assert.equal(writes, 0);
});
