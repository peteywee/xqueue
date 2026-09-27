import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyCloudflareApiToken,
  cloudflareTokenVerifyUrl,
  verifyCloudflareApiToken,
} from '../src/cloudflare-auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_ID = 'a'.repeat(32);
const ACCOUNT_TOKEN = 'cfat_' + 'a'.repeat(48);
const USER_TOKEN = 'cfut_' + 'b'.repeat(48);

function response(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

test('classifies prefixed Cloudflare account and user tokens', () => {
  assert.equal(classifyCloudflareApiToken(ACCOUNT_TOKEN), 'account');
  assert.equal(classifyCloudflareApiToken(USER_TOKEN), 'user');
});

test('account token verification uses the account-scoped endpoint', async () => {
  let seenUrl = null;
  let seenAuth = null;

  const result = await verifyCloudflareApiToken({
    token: ACCOUNT_TOKEN,
    accountId: ACCOUNT_ID,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return response({
        success: true,
        errors: [],
        result: {
          status: 'active',
          expires_on: '2027-09-27T23:59:59Z',
        },
      });
    },
  });

  assert.equal(
    seenUrl,
    'https://api.cloudflare.com/client/v4/accounts/' +
      ACCOUNT_ID +
      '/tokens/verify',
  );
  assert.equal(seenAuth, 'Bearer ' + ACCOUNT_TOKEN);
  assert.equal(result.tokenType, 'account');
  assert.equal(result.status, 'active');
});

test('user token verification uses the user-scoped endpoint', async () => {
  let seenUrl = null;

  const result = await verifyCloudflareApiToken({
    token: USER_TOKEN,
    accountId: ACCOUNT_ID,
    fetchImpl: async (url) => {
      seenUrl = url;
      return response({
        success: true,
        errors: [],
        result: { status: 'active' },
      });
    },
  });

  assert.equal(
    seenUrl,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  );
  assert.equal(result.tokenType, 'user');
});

test('account token requires an exact account ID before network access', () => {
  assert.throws(
    () =>
      cloudflareTokenVerifyUrl({
        token: ACCOUNT_TOKEN,
        accountId: 'wrong',
      }),
    /32-character account ID/i,
  );
});

test('whitespace and unknown token formats fail closed', () => {
  assert.throws(
    () => classifyCloudflareApiToken(ACCOUNT_TOKEN + '\n'),
    /contains whitespace/i,
  );
  assert.throws(
    () => classifyCloudflareApiToken('not-a-cloudflare-token'),
    /unsupported Cloudflare API token format/i,
  );
});

test('inactive or rejected token fails without leaking the credential', async () => {
  const secret = ACCOUNT_TOKEN;

  await assert.rejects(
    () =>
      verifyCloudflareApiToken({
        token: secret,
        accountId: ACCOUNT_ID,
        fetchImpl: async () =>
          response(
            {
              success: false,
              errors: [{ code: 1000, message: 'Invalid API Token' }],
              result: null,
            },
            false,
          ),
      }),
    (error) => {
      assert.match(error.message, /account API token verification failed/i);
      assert.match(error.message, /1000: Invalid API Token/);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});


test('production halt and authority controls gate on typed token verification', () => {
  const haltControl = readFileSync(
    resolve(HERE, '../scripts/publication-halt-owner.mjs'),
    'utf8',
  );
  const authorityControl = readFileSync(
    resolve(HERE, '../scripts/production-authority-control.mjs'),
    'utf8',
  );

  for (const source of [haltControl, authorityControl]) {
    assert.match(
      source,
      /import \{ verifyCloudflareApiToken \} from '\.\.\/src\/cloudflare-auth\.mjs';/,
    );
    assert.match(source, /await verifyCloudflareApiToken\(\);/);
  }
});

test('operator auth preflight proves D1 read capability without mutation SQL', () => {
  const source = readFileSync(
    resolve(HERE, '../scripts/cloudflare-auth-preflight.mjs'),
    'utf8',
  );

  assert.match(source, /'SELECT 1 AS ok;'/);
  assert.doesNotMatch(source, /'\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  assert.match(source, /verifyCloudflareApiToken/);
});
