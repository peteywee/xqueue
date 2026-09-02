import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_PUBLICATION_LEASE_TTL_MS,
  MIN_PUBLICATION_LEASE_TTL_MS,
  acquirePublicationLease,
  inspectPublicationLease,
  releasePublicationLease,
} from '../cloudflare/src/publication-lease.mjs';

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  execute() {
    const statement = this.db.prepare(this.sql);

    if (/^\s*SELECT\b/i.test(this.sql)) {
      return {
        success: true,
        results: statement.all(...this.params).map((row) => ({ ...row })),
        meta: { changes: 0 },
      };
    }

    const result = statement.run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }
}

class SqliteD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');

  for (const path of [
    'cloudflare/migrations/0001_xqueue_runtime.sql',
    'cloudflare/migrations/0002_runtime_evidence.sql',
    'cloudflare/migrations/0003_publication_lease.sql',
  ]) {
    sqlite.exec(readFileSync(path, 'utf8'));
  }

  return { sqlite, db: new SqliteD1(sqlite) };
}

function identity(name) {
  return {
    ownerToken: `${name}-owner-token`,
    acquisitionId: `${name}-acquisition-id`,
  };
}

function events(sqlite) {
  return sqlite.prepare(`
    SELECT generation, owner_token, acquisition_id,
           event_type, event_at_ms, detail
    FROM publication_lease_events
    ORDER BY id
  `).all().map((row) => ({ ...row }));
}

function leaseRow(sqlite) {
  const row = sqlite.prepare(`
    SELECT lease_name, owner_token, acquisition_id, generation,
           acquired_at_ms, expires_at_ms, updated_at_ms
    FROM publication_leases
    WHERE lease_name = 'publisher'
  `).get();

  return row ? { ...row } : null;
}

test('first contender acquires and is audited exactly once', async () => {
  const { sqlite, db } = fixture();
  const id = identity('first');

  const result = await acquirePublicationLease(db, {
    ...id,
    nowMs: 1000,
    ttlMs: 5000,
  });

  assert.equal(result.acquired, true);
  assert.deepEqual(result.lease, {
    leaseName: 'publisher',
    ownerToken: id.ownerToken,
    acquisitionId: id.acquisitionId,
    generation: 1,
    acquiredAtMs: 1000,
    expiresAtMs: 6000,
    updatedAtMs: 1000,
  });

  assert.deepEqual(events(sqlite), [{
    generation: 1,
    owner_token: id.ownerToken,
    acquisition_id: id.acquisitionId,
    event_type: 'acquired',
    event_at_ms: 1000,
    detail: 'initial-acquisition',
  }]);
});

test('same-instant contenders produce one winner and one audit grant', async () => {
  const { sqlite, db } = fixture();

  const results = await Promise.all([
    acquirePublicationLease(db, {
      ...identity('alpha'),
      nowMs: 10_000,
      ttlMs: 5000,
    }),
    acquirePublicationLease(db, {
      ...identity('bravo'),
      nowMs: 10_000,
      ttlMs: 5000,
    }),
  ]);

  assert.equal(results.filter((r) => r.acquired).length, 1);
  assert.equal(results.filter((r) => !r.acquired).length, 1);
  assert.equal(events(sqlite).length, 1);
  assert.equal(leaseRow(sqlite).generation, 1);
});

test('active lease cannot be stolen before expiry', async () => {
  const { db } = fixture();

  await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  const blocked = await acquirePublicationLease(db, {
    ...identity('bravo'),
    nowMs: 5999,
    ttlMs: 5000,
  });

  assert.equal(blocked.acquired, false);
  assert.deepEqual(blocked.current, {
    leaseName: 'publisher',
    generation: 1,
    acquiredAtMs: 1000,
    expiresAtMs: 6000,
    expired: false,
  });
});

test('stale takeover is allowed exactly at expiry and fences the old handle', async () => {
  const { sqlite, db } = fixture();

  const first = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  const second = await acquirePublicationLease(db, {
    ...identity('bravo'),
    nowMs: 6000,
    ttlMs: 5000,
  });

  assert.equal(second.acquired, true);
  assert.equal(second.lease.generation, 2);

  const staleRelease = await releasePublicationLease(db, first.lease, {
    nowMs: 6001,
  });

  assert.equal(staleRelease.released, false);
  assert.equal(leaseRow(sqlite).owner_token, 'bravo-owner-token');
  assert.equal(leaseRow(sqlite).generation, 2);

  assert.deepEqual(
    events(sqlite).map(({ generation, event_type, detail }) => ({
      generation,
      event_type,
      detail,
    })),
    [
      { generation: 1, event_type: 'acquired', detail: 'initial-acquisition' },
      { generation: 2, event_type: 'acquired', detail: 'expired-lease-takeover' },
    ],
  );
});

test('inspection reports an expired lease without silently clearing it', async () => {
  const { sqlite, db } = fixture();

  await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 1000,
  });

  assert.deepEqual(await inspectPublicationLease(db, { nowMs: 2001 }), {
    leaseName: 'publisher',
    generation: 1,
    acquiredAtMs: 1000,
    expiresAtMs: 2000,
    expired: true,
  });

  assert.equal(leaseRow(sqlite).owner_token, 'alpha-owner-token');
  assert.equal(events(sqlite).length, 1);
});

test('wrong owner and wrong acquisition handle cannot release a lease', async () => {
  const { sqlite, db } = fixture();

  const acquired = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  for (const forged of [
    { ...acquired.lease, ownerToken: 'bravo-owner-token' },
    { ...acquired.lease, acquisitionId: 'forged-acquisition-id' },
    { ...acquired.lease, generation: 2 },
  ]) {
    const result = await releasePublicationLease(db, forged, { nowMs: 2000 });
    assert.equal(result.released, false);
  }

  assert.equal(leaseRow(sqlite).owner_token, 'alpha-owner-token');
  assert.equal(events(sqlite).length, 1);
});

test('owner release is audited and next acquisition advances generation', async () => {
  const { sqlite, db } = fixture();

  const first = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  const released = await releasePublicationLease(db, first.lease, {
    nowMs: 1500,
  });

  assert.equal(released.released, true);
  assert.equal(await inspectPublicationLease(db, { nowMs: 1500 }), null);
  assert.equal(leaseRow(sqlite).owner_token, null);

  const second = await acquirePublicationLease(db, {
    ...identity('bravo'),
    nowMs: 1500,
    ttlMs: 5000,
  });

  assert.equal(second.acquired, true);
  assert.equal(second.lease.generation, 2);

  assert.deepEqual(
    events(sqlite).map(({ event_type, detail }) => ({ event_type, detail })),
    [
      { event_type: 'acquired', detail: 'initial-acquisition' },
      { event_type: 'released', detail: 'owner-release' },
      { event_type: 'acquired', detail: 'released-lease-acquisition' },
    ],
  );
});

test('same active acquisition replay is not a second grant', async () => {
  const { sqlite, db } = fixture();
  const id = identity('alpha');

  const first = await acquirePublicationLease(db, {
    ...id,
    nowMs: 1000,
    ttlMs: 5000,
  });

  const replay = await acquirePublicationLease(db, {
    ...id,
    nowMs: 1000,
    ttlMs: 5000,
  });

  assert.equal(first.acquired, true);
  assert.equal(replay.acquired, false);
  assert.equal(events(sqlite).length, 1);
  assert.equal(leaseRow(sqlite).generation, 1);
});

test('an acquisition ID can never be granted again across generations', async () => {
  const { sqlite, db } = fixture();
  const original = identity('alpha');

  const first = await acquirePublicationLease(db, {
    ...original,
    nowMs: 1000,
    ttlMs: 5000,
  });

  await releasePublicationLease(db, first.lease, { nowMs: 1500 });

  await assert.rejects(
    acquirePublicationLease(db, {
      ownerToken: 'bravo-owner-token',
      acquisitionId: original.acquisitionId,
      nowMs: 1600,
      ttlMs: 5000,
    }),
    /UNIQUE|constraint/i,
  );

  const row = leaseRow(sqlite);
  assert.equal(row.owner_token, null);
  assert.equal(row.generation, 1);
  assert.deepEqual(events(sqlite).map((event) => event.event_type), [
    'acquired',
    'released',
  ]);
});

test('TTL is explicit, bounded, and release time cannot precede acquisition', async () => {
  const { db } = fixture();
  const id = identity('alpha');

  await assert.rejects(
    acquirePublicationLease(db, {
      ...id,
      nowMs: 1000,
      ttlMs: MIN_PUBLICATION_LEASE_TTL_MS - 1,
    }),
    /ttlMs must be at least/,
  );

  await assert.rejects(
    acquirePublicationLease(db, {
      ...id,
      nowMs: 1000,
      ttlMs: MAX_PUBLICATION_LEASE_TTL_MS + 1,
    }),
    /ttlMs must not exceed/,
  );

  const acquired = await acquirePublicationLease(db, {
    ...id,
    nowMs: 5000,
    ttlMs: MAX_PUBLICATION_LEASE_TTL_MS,
  });

  assert.equal(acquired.acquired, true);

  await assert.rejects(
    releasePublicationLease(db, acquired.lease, { nowMs: 4999 }),
    /release time cannot precede lease acquisition/,
  );
});
