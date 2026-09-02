const LEASE_NAME = 'publisher';

export const MAX_PUBLICATION_LEASE_TTL_MS = 20 * 60 * 1000;
export const MIN_PUBLICATION_LEASE_TTL_MS = 1000;

const RETURNING_COLUMNS = `
  lease_name,
  owner_token,
  acquisition_id,
  generation,
  acquired_at_ms,
  expires_at_ms,
  updated_at_ms
`;

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
WHERE
  publication_leases.owner_token IS NULL OR
  publication_leases.expires_at_ms <= excluded.acquired_at_ms
RETURNING ${RETURNING_COLUMNS}
`;

const READ_SQL = `
SELECT
${RETURNING_COLUMNS}
FROM publication_leases
WHERE lease_name = '${LEASE_NAME}'
LIMIT 1
`;

const RELEASE_SQL = `
UPDATE publication_leases
SET
  owner_token = NULL,
  acquisition_id = NULL,
  expires_at_ms = ?4,
  updated_at_ms = ?4
WHERE lease_name = '${LEASE_NAME}'
  AND owner_token = ?1
  AND acquisition_id = ?2
  AND generation = ?3
RETURNING ${RETURNING_COLUMNS}
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

function firstResult(result) {
  return result?.results?.[0] ?? null;
}

function decodeLeaseRow(row) {
  if (!row) return null;

  return {
    leaseName: String(row.lease_name),
    ownerToken:
      row.owner_token === null
        ? null
        : String(row.owner_token),
    acquisitionId:
      row.acquisition_id === null
        ? null
        : String(row.acquisition_id),
    generation: Number(row.generation),
    acquiredAtMs: Number(row.acquired_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function activeLease(row) {
  if (!row?.ownerToken || !row?.acquisitionId) {
    return null;
  }

  return row;
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

function sameLease(a, b) {
  return Boolean(
    a &&
    b &&
    a.leaseName === b.leaseName &&
    a.ownerToken === b.ownerToken &&
    a.acquisitionId === b.acquisitionId &&
    a.generation === b.generation &&
    a.acquiredAtMs === b.acquiredAtMs &&
    a.expiresAtMs === b.expiresAtMs &&
    a.updatedAtMs === b.updatedAtMs
  );
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
    db.prepare(READ_SQL),
  ]);

  const written = activeLease(
    decodeLeaseRow(firstResult(results?.[0])),
  );
  const current = activeLease(
    decodeLeaseRow(firstResult(results?.[1])),
  );

  if (written !== null) {
    const identityMatches =
      written.ownerToken === ownerToken &&
      written.acquisitionId === acquisitionId &&
      written.acquiredAtMs === nowMs &&
      written.expiresAtMs === expiresAtMs;

    if (identityMatches && sameLease(written, current)) {
      return {
        acquired: true,
        lease: current,
      };
    }

    throw new Error(
      'D1 lease acquisition produced inconsistent write/read results',
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

  if (!Number.isSafeInteger(lease.acquiredAtMs) || lease.acquiredAtMs < 0) {
    throw new Error('lease.acquiredAtMs must be a non-negative safe integer');
  }

  if (nowMs < lease.acquiredAtMs) {
    throw new Error('release time cannot precede lease acquisition');
  }

  const results = await db.batch([
    db.prepare(RELEASE_SQL).bind(
      lease.ownerToken,
      lease.acquisitionId,
      lease.generation,
      nowMs,
    ),
    db.prepare(READ_SQL),
  ]);

  const writeRow = decodeLeaseRow(firstResult(results?.[0]));
  const current = activeLease(
    decodeLeaseRow(firstResult(results?.[1])),
  );

  if (writeRow !== null) {
    if (
      writeRow.ownerToken === null &&
      writeRow.acquisitionId === null &&
      writeRow.generation === lease.generation &&
      writeRow.updatedAtMs === nowMs &&
      current === null
    ) {
      return {
        released: true,
        current: null,
      };
    }

    throw new Error(
      'D1 lease release produced inconsistent write/read results',
    );
  }

  return {
    released: false,
    current: redactLease(current, nowMs),
  };
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
    activeLease(decodeLeaseRow(row)),
    nowMs,
  );
}

export const publicationLeaseSql = Object.freeze({
  acquire: ACQUIRE_SQL,
  read: READ_SQL,
  release: RELEASE_SQL,
});
