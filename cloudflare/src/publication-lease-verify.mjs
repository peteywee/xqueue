import { publicationLeaseSql } from './publication-lease.mjs';

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export async function verifyPublicationLease(
  db,
  lease,
  { nowMs = Date.now() } = {},
) {
  if (!db || typeof db.prepare !== 'function') return false;
  if (!lease || typeof lease !== 'object') return false;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;

  const row = await db
    .prepare(publicationLeaseSql.read)
    .first();

  if (!row) return false;

  const generation = safeInteger(row.generation);
  const acquiredAtMs = safeInteger(row.acquired_at_ms);
  const expiresAtMs = safeInteger(row.expires_at_ms);

  return (
    typeof row.owner_token === 'string' &&
    row.owner_token === lease.ownerToken &&
    typeof row.acquisition_id === 'string' &&
    row.acquisition_id === lease.acquisitionId &&
    generation === lease.generation &&
    acquiredAtMs === lease.acquiredAtMs &&
    expiresAtMs === lease.expiresAtMs &&
    expiresAtMs > nowMs
  );
}
