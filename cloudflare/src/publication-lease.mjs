const LEASE_NAME = 'publisher';

export const MAX_PUBLICATION_LEASE_TTL_MS = 20 * 60 * 1000;
export const MIN_PUBLICATION_LEASE_TTL_MS = 1000;

const ACQUIRE_SQL = `
INSERT INTO publication_leases (
  lease_name,
  owner_token,
  acquisition_id,
  generation,
  acquired_at_ms,
  expires_at_ms,
  updated_at_ms
)
VALUES (
  '${LEASE_NAME}',
  ?1,
  ?2,
  1,
  ?3,
  ?4,
  ?3
)
ON CONFLICT(lease_name)
DO UPDATE SET
  owner_token = excluded.owner_token,
  acquisition_id = excluded.acquisition_id,
  generation = publication_leases.generation + 1,
  acquired_at_ms = excluded.acquired_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  updated_at_ms = excluded.updated_at_ms
WHERE publication_leases.expires_at_ms <= excluded.acquired_at_ms
`;

const AUDIT_ACQUIRE_SQL = `
INSERT INTO publication_lease_events (
  lease_name,
  generation,
  owner_token,
  acquisition_id,
  event_type,
  event_at_ms,
  detail
)
SELECT
  lease_name,
  generation,
  owner_token,
  acquisition_id,
  'acquired',
  ?2,
  CASE
    WHEN generation = 1 THEN 'initial-acquisition'
    ELSE 'expired-lease-takeover'
  END
FROM publication_leases
WHERE lease_name = '${LEASE_NAME}'
  AND acquisition_id = ?1
`;

const READ_SQL = `
SELECT
  lease_name,
  owner_token,
  acquisition_id,
  generation,
  acquired_at_ms,
  expires_at_ms,
  updated_at_ms
FROM publication_leases
WHERE lease_name = '${LEASE_NAME}'
LIMIT 1
`;

const AUDIT_RELEASE_SQL = `
INSERT INTO publication_lease_events (
  lease_name,
  generation,
  owner_token,
  acquisition_id,
  event_type,
  event_at_ms,
  detail
)
SELECT
  lease_name,
  generation,
  owner_token,
  acquisition_id,
  'released',
  ?4,
  'owner-release'
FROM publication_leases
WHERE lease_name = '${LEASE_NAME}'
  AND owner_token = ?1
  AND acquisition_id = ?2
  AND generation = ?3
`;

const RELEASE_SQL = `
DELETE FROM publication_leases
WHERE lease_name = '${LEASE_NAME}'
  AND owner_token = ?1
  AND acquisition_id = ?2
  AND generation = ?3
`;

function assertNonEmptyToken(name, value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw new Error(`${name} must be a string of at least 8 characters`);
  }
}

function assertNowMs(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('nowMs must be a non-negative safe integer');
  }
}

function assertTtlMs(ttlMs) {
  if (!Number.isSafeInteger(ttlMs)) {
    throw new Error('ttlMs must be a safe integer');
  }

  if (ttlMs < MIN_PUBLICATION_LEASE_TTL_MS) {
    throw new Error(
      `ttlMs must be at least ${MIN_PUBLICATION_LEASE_TTL_MS}`,
    );
  }

  if (ttlMs > MAX_PUBLICATION_LEASE_TTL_MS) {
    throw new Error(
      `ttlMs must not exceed ${MAX_PUBLICATION_LEASE_TTL_MS}`,
    );
  }
}

function changes(result) {
  const value = Number(result?.meta?.changes ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function firstResult(result) {
  return result?.results?.[0] ?? null;
}

function decodeLease(row) {
  if (!row) return null;

  return {
    leaseName: String(row.lease_name),
    ownerToken: String(row.owner_token),
    acquisitionId: String(row.acquisition_id),
    generation: Number(row.generation),
    acquiredAtMs: Number(row.acquired_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function redactLease(lease, nowMs) {
  if (!lease) return null;

  return {
    leaseName: lease.leaseName,
    generation: lease.generation,
    acquiredAtMs: lease.acquiredAtMs,
    expiresAtMs: lease.expiresAtMs,
    expired: lease.expiresAtMs <= nowMs,
  };
}

export function createPublicationLeaseIdentity() {
  return {
    ownerToken: crypto.randomUUID(),
    acquisitionId: crypto.randomUUID(),
  };
}

export async function acquirePublicationLease(
  db,
  {
    ownerToken,
    acquisitionId,
    ttlMs,
    nowMs = Date.now(),
  },
) {
  assertNonEmptyToken('ownerToken', ownerToken);
  assertNonEmptyToken('acquisitionId', acquisitionId);
  assertNowMs(nowMs);
  assertTtlMs(ttlMs);

  const expiresAtMs = nowMs + ttlMs;

  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new Error('lease expiry exceeds safe integer range');
  }

  const results = await db.batch([
    db.prepare(ACQUIRE_SQL).bind(
      ownerToken,
      acquisitionId,
      nowMs,
      expiresAtMs,
    ),
    db.prepare(AUDIT_ACQUIRE_SQL).bind(
      acquisitionId,
      nowMs,
    ),
    db.prepare(READ_SQL),
  ]);

  const writeChanges = changes(results?.[0]);
  const auditChanges = changes(results?.[1]);
  const current = decodeLease(firstResult(results?.[2]));

  const acquired =
    current?.ownerToken === ownerToken &&
    current?.acquisitionId === acquisitionId &&
    current?.acquiredAtMs === nowMs &&
    current?.expiresAtMs === expiresAtMs;

  if (acquired) {
    if (writeChanges !== 1 || auditChanges !== 1) {
      throw new Error(
        'D1 lease acquisition changed state without exactly one audit event',
      );
    }

    return {
      acquired: true,
      lease: current,
    };
  }

  if (writeChanges !== 0 || auditChanges !== 0) {
    throw new Error(
      'D1 lease acquisition reported unexpected partial state changes',
    );
  }

  return {
    acquired: false,
    current: redactLease(current, nowMs),
  };
}

export async function releasePublicationLease(
  db,
  lease,
  {
    nowMs = Date.now(),
  } = {},
) {
  if (!lease || typeof lease !== 'object') {
    throw new Error('lease handle is required');
  }

  assertNonEmptyToken('lease.ownerToken', lease.ownerToken);
  assertNonEmptyToken('lease.acquisitionId', lease.acquisitionId);
  assertNowMs(nowMs);

  if (!Number.isSafeInteger(lease.generation) || lease.generation < 1) {
    throw new Error('lease.generation must be a positive safe integer');
  }

  const results = await db.batch([
    db.prepare(AUDIT_RELEASE_SQL).bind(
      lease.ownerToken,
      lease.acquisitionId,
      lease.generation,
      nowMs,
    ),
    db.prepare(RELEASE_SQL).bind(
      lease.ownerToken,
      lease.acquisitionId,
      lease.generation,
    ),
    db.prepare(READ_SQL),
  ]);

  const auditChanges = changes(results?.[0]);
  const deleteChanges = changes(results?.[1]);
  const current = decodeLease(firstResult(results?.[2]));

  if (auditChanges === 1 && deleteChanges === 1) {
    return {
      released: true,
      current: null,
    };
  }

  if (auditChanges === 0 && deleteChanges === 0) {
    return {
      released: false,
      current: redactLease(current, nowMs),
    };
  }

  throw new Error(
    'D1 lease release produced inconsistent audit/delete results',
  );
}

export async function inspectPublicationLease(
  db,
  {
    nowMs = Date.now(),
  } = {},
) {
  assertNowMs(nowMs);

  const row = await db
    .prepare(READ_SQL)
    .first();

  return redactLease(
    decodeLease(row),
    nowMs,
  );
}

export const publicationLeaseSql = Object.freeze({
  acquire: ACQUIRE_SQL,
  auditAcquire: AUDIT_ACQUIRE_SQL,
  read: READ_SQL,
  auditRelease: AUDIT_RELEASE_SQL,
  release: RELEASE_SQL,
});
