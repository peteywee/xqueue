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

class SqliteD1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new SqliteD1Statement(
      this.db,
      this.sql,
      params,
    );
  }

  execute() {
    const statement = this.db.prepare(this.sql);

    if (/^\s*SELECT\b/i.test(this.sql)) {
      return {
        success: true,
        results: statement.all(...this.params),
        meta: {
          changes: 0,
        },
      };
    }

    const result = statement.run(...this.params);

    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
      },
    };
  }

  async first() {
    const statement = this.db.prepare(this.sql);
    return statement.get(...this.params) ?? null;
  }
}

class SqliteD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const results = statements.map(
        (statement) => statement.execute(),
      );

      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function createFixture() {
  const sqlite = new DatabaseSync(':memory:');

  for (const migration of [
    'cloudflare/migrations/0001_xqueue_runtime.sql',
    'cloudflare/migrations/0002_runtime_evidence.sql',
    'cloudflare/migrations/0003_publication_lease.sql',
  ]) {
    sqlite.exec(readFileSync(migration, 'utf8'));
  }

  return {
    sqlite,
    db: new SqliteD1(sqlite),
  };
}

function identity(name) {
  return {
    ownerToken: `${name}-owner-token`,
    acquisitionId: `${name}-acquisition-id`,
  };
}

function events(sqlite) {
  return sqlite
    .prepare(`
      SELECT
        generation,
        owner_token,
        acquisition_id,
        event_type,
        event_at_ms,
        detail
      FROM publication_lease_events
      ORDER BY id
    `)
    .all();
}

function leaseRow(sqlite) {
  return sqlite
    .prepare(`
      SELECT
        lease_name,
        owner_token,
        acquisition_id,
        generation,
        acquired_at_ms,
        expires_at_ms,
        updated_at_ms
      FROM publication_leases
      WHERE lease_name = 'publisher'
    `)
    .get() ?? null;
}

test('first contender acquires the singleton publication lease', async () => {
  const { sqlite, db } = createFixture();
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

  assert.deepEqual(events(sqlite), [
    {
      generation: 1,
      owner_token: id.ownerToken,
      acquisition_id: id.acquisitionId,
      event_type: 'acquired',
      event_at_ms: 1000,
      detail: 'initial-acquisition',
    },
  ]);
});

test('two contenders at the same instant produce exactly one winner', async () => {
  const { sqlite, db } = createFixture();

  const [a, b] = await Promise.all([
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

  assert.equal(
    [a, b].filter((result) => result.acquired).length,
    1,
  );

  assert.equal(
    [a, b].filter((result) => !result.acquired).length,
    1,
  );

  assert.equal(events(sqlite).length, 1);
  assert.equal(leaseRow(sqlite).generation, 1);
});

test('active lease cannot be stolen before its expiry boundary', async () => {
  const { db } = createFixture();

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

test('expired lease can be taken over exactly at expiry with a new generation', async () => {
  const { sqlite, db } = createFixture();

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

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  assert.equal(second.lease.generation, 2);
  assert.equal(second.lease.acquiredAtMs, 6000);
  assert.equal(second.lease.expiresAtMs, 11_000);

  assert.deepEqual(
    events(sqlite).map((event) => ({
      generation: event.generation,
      event_type: event.event_type,
      detail: event.detail,
    })),
    [
      {
        generation: 1,
        event_type: 'acquired',
        detail: 'initial-acquisition',
      },
      {
        generation: 2,
        event_type: 'acquired',
        detail: 'expired-lease-takeover',
      },
    ],
  );
});

test('inspection reports expiry but never clears an expired lease', async () => {
  const { sqlite, db } = createFixture();

  await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 1000,
  });

  const inspected = await inspectPublicationLease(db, {
    nowMs: 2001,
  });

  assert.deepEqual(inspected, {
    leaseName: 'publisher',
    generation: 1,
    acquiredAtMs: 1000,
    expiresAtMs: 2000,
    expired: true,
  });

  assert.equal(leaseRow(sqlite).owner_token, 'alpha-owner-token');
  assert.equal(events(sqlite).length, 1);
});

test('wrong owner cannot release another contender lease', async () => {
  const { sqlite, db } = createFixture();

  const acquired = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  const forged = {
    ...acquired.lease,
    ownerToken: 'bravo-owner-token',
  };

  const release = await releasePublicationLease(
    db,
    forged,
    {
      nowMs: 2000,
    },
  );

  assert.equal(release.released, false);
  assert.equal(leaseRow(sqlite).owner_token, 'alpha-owner-token');
  assert.equal(events(sqlite).length, 1);
});

test('stale lease handle cannot release a newer generation', async () => {
  const { sqlite, db } = createFixture();

  const first = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 1000,
  });

  const second = await acquirePublicationLease(db, {
    ...identity('bravo'),
    nowMs: 2000,
    ttlMs: 5000,
  });

  const staleRelease = await releasePublicationLease(
    db,
    first.lease,
    {
      nowMs: 2001,
    },
  );

  assert.equal(staleRelease.released, false);
  assert.equal(leaseRow(sqlite).owner_token, 'bravo-owner-token');
  assert.equal(leaseRow(sqlite).generation, 2);
  assert.equal(events(sqlite).length, 2);

  const ownerRelease = await releasePublicationLease(
    db,
    second.lease,
    {
      nowMs: 2002,
    },
  );

  assert.equal(ownerRelease.released, true);
  assert.equal(leaseRow(sqlite).owner_token, null);

  assert.deepEqual(
    events(sqlite).map((event) => event.event_type),
    ['acquired', 'acquired', 'released'],
  );
});

test('explicit release makes the singleton inactive and next acquisition advances generation', async () => {
  const { sqlite, db } = createFixture();

  const first = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 1000,
    ttlMs: 5000,
  });

  const released = await releasePublicationLease(
    db,
    first.lease,
    {
      nowMs: 1500,
    },
  );

  assert.equal(released.released, true);
  assert.equal(await inspectPublicationLease(db, { nowMs: 1500 }), null);

  const second = await acquirePublicationLease(db, {
    ...identity('bravo'),
    nowMs: 1500,
    ttlMs: 5000,
  });

  assert.equal(second.acquired, true);
  assert.equal(second.lease.generation, 2);

  assert.deepEqual(
    events(sqlite).map((event) => ({
      event_type: event.event_type,
      detail: event.detail,
    })),
    [
      {
        event_type: 'acquired',
        detail: 'initial-acquisition',
      },
      {
        event_type: 'released',
        detail: 'owner-release',
      },
      {
        event_type: 'acquired',
        detail: 'released-lease-acquisition',
      },
    ],
  );
});

test('replaying the same active acquisition identity does not create a second grant or audit event', async () => {
  const { sqlite, db } = createFixture();
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

test('lease TTL policy is explicit and bounded by the 20 minute stale window', async () => {
  const { db } = createFixture();
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

  const allowed = await acquirePublicationLease(db, {
    ...id,
    nowMs: 1000,
    ttlMs: MAX_PUBLICATION_LEASE_TTL_MS,
  });

  assert.equal(allowed.acquired, true);
});

test('release refuses a clock value earlier than the granted lease', async () => {
  const { db } = createFixture();

  const acquired = await acquirePublicationLease(db, {
    ...identity('alpha'),
    nowMs: 5000,
    ttlMs: 5000,
  });

  await assert.rejects(
    releasePublicationLease(
      db,
      acquired.lease,
      {
        nowMs: 4999,
      },
    ),
    /release time cannot precede lease acquisition/,
  );
});
