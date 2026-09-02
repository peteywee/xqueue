import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquirePublicationLease,
  releasePublicationLease,
} from '../cloudflare/src/publication-lease.mjs';

function prepared(db, sql, params = []) {
  return {
    bind(...next) {
      return prepared(db, sql, next);
    },
    sql,
    params,
  };
}

function fakeD1ForAcquire({ directChanges = 1 } = {}) {
  const lease = {
    lease_name: 'publisher',
    owner_token: 'alpha-owner-token',
    acquisition_id: 'alpha-acquisition-id',
    generation: 1,
    acquired_at_ms: 1000,
    expires_at_ms: 6000,
    updated_at_ms: 1000,
  };

  return {
    prepare(sql) {
      return prepared(this, sql);
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      return [
        {
          success: true,
          results: [],
          // Real preview D1 showed audit-trigger-inclusive metadata here.
          meta: { changes: directChanges === 1 ? 2 : 0 },
        },
        {
          success: true,
          results: [{ direct_changes: directChanges }],
          meta: { changes: 0 },
        },
        {
          success: true,
          results: [lease],
          meta: { changes: 0 },
        },
      ];
    },
  };
}

test('acquisition trusts SQL changes() + exact readback, not trigger-inclusive meta.changes', async () => {
  const result = await acquirePublicationLease(fakeD1ForAcquire(), {
    ownerToken: 'alpha-owner-token',
    acquisitionId: 'alpha-acquisition-id',
    nowMs: 1000,
    ttlMs: 5000,
  });

  assert.equal(result.acquired, true);
  assert.equal(result.lease.generation, 1);
});

test('blocked/replayed acquisition stays false even if current row matches the requested identity', async () => {
  const result = await acquirePublicationLease(fakeD1ForAcquire({ directChanges: 0 }), {
    ownerToken: 'alpha-owner-token',
    acquisitionId: 'alpha-acquisition-id',
    nowMs: 1000,
    ttlMs: 5000,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.current.generation, 1);
});

test('release also ignores trigger-inclusive write metadata', async () => {
  const db = {
    prepare(sql) {
      return prepared(this, sql);
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      return [
        { success: true, results: [], meta: { changes: 2 } },
        { success: true, results: [{ direct_changes: 1 }], meta: { changes: 0 } },
        {
          success: true,
          results: [{
            lease_name: 'publisher',
            owner_token: null,
            acquisition_id: null,
            generation: 1,
            acquired_at_ms: 1000,
            expires_at_ms: 1500,
            updated_at_ms: 1500,
          }],
          meta: { changes: 0 },
        },
      ];
    },
  };

  const result = await releasePublicationLease(db, {
    leaseName: 'publisher',
    ownerToken: 'alpha-owner-token',
    acquisitionId: 'alpha-acquisition-id',
    generation: 1,
    acquiredAtMs: 1000,
    expiresAtMs: 6000,
    updatedAtMs: 1000,
  }, { nowMs: 1500 });

  assert.equal(result.released, true);
  assert.equal(result.current, null);
});
