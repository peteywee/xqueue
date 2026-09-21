const READ_HALT_SQL = `
SELECT
  singleton_id,
  halted,
  generation,
  reason,
  actor_class,
  updated_at
FROM publication_halt_state
WHERE singleton_id = 1
LIMIT 1
`;

const SET_HALT_SQL = `
UPDATE publication_halt_state
SET
  halted = 1,
  generation = generation + 1,
  reason = ?1,
  actor_class = 'automation',
  updated_at = ?2
WHERE singleton_id = 1
  AND halted = 0
  AND generation = ?3
`;

const DIRECT_CHANGES_SQL = 'SELECT changes() AS direct_changes';

function failClosed(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    halted: true,
    failClosed: true,
    reason,
    ...extra,
  });
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function decodeHaltState(row) {
  if (!row) return failClosed('halt_state_missing');

  const singletonId = Number(row.singleton_id);
  const halted = Number(row.halted);
  const generation = positiveInteger(row.generation);
  const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
  const actorClass = typeof row.actor_class === 'string' ? row.actor_class : '';
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : '';

  if (
    singletonId !== 1 ||
    ![0, 1].includes(halted) ||
    generation === null ||
    reason.length === 0 ||
    !['migration', 'automation', 'owner'].includes(actorClass) ||
    updatedAt.length === 0
  ) {
    return failClosed('halt_state_invalid');
  }

  return Object.freeze({
    ok: true,
    halted: halted === 1,
    failClosed: false,
    reason,
    generation,
    actorClass,
    updatedAt,
  });
}

function isoNow(now) {
  if (Object.prototype.toString.call(now) !== '[object Date]') {
    throw new Error('now must be a Date');
  }
  const ms = now.getTime();
  if (!Number.isFinite(ms)) throw new Error('now must be valid');
  return now.toISOString();
}

function haltReason(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('halt reason is required');
  }
  return value.trim();
}

function directChanges(result) {
  const value = Number(result?.results?.[0]?.direct_changes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('D1 direct change count is missing or invalid');
  }
  return value;
}

export async function readGlobalPublicationHalt(db) {
  if (!db || typeof db.prepare !== 'function') {
    return failClosed('halt_store_unavailable');
  }

  try {
    const row = await db.prepare(READ_HALT_SQL).first();
    return decodeHaltState(row);
  } catch {
    return failClosed('halt_store_unavailable');
  }
}

export function publicationHaltVerdict(state) {
  if (!state?.ok) {
    return Object.freeze({
      ok: false,
      reason: state?.reason ?? 'halt_state_unavailable',
      halt: state ?? null,
    });
  }

  if (state.halted) {
    return Object.freeze({
      ok: false,
      reason: 'publication_halted',
      halt: state,
    });
  }

  return Object.freeze({
    ok: true,
    reason: null,
    halt: state,
  });
}

export async function setGlobalPublicationHaltByAutomation(
  db,
  {
    reason,
    expectedGeneration = null,
    now = new Date(),
  } = {},
) {
  if (
    !db ||
    typeof db.prepare !== 'function' ||
    typeof db.batch !== 'function'
  ) {
    throw new Error('halt store is unavailable');
  }

  const normalizedReason = haltReason(reason);
  const at = isoNow(now);
  const current = await readGlobalPublicationHalt(db);

  if (!current.ok) {
    throw new Error(current.reason);
  }

  if (current.halted) {
    return Object.freeze({ changed: false, state: current });
  }

  const expected =
    expectedGeneration === null
      ? current.generation
      : positiveInteger(expectedGeneration);

  if (expected === null || expected !== current.generation) {
    throw new Error('stale halt generation');
  }

  const results = await db.batch([
    db.prepare(SET_HALT_SQL).bind(normalizedReason, at, expected),
    db.prepare(DIRECT_CHANGES_SQL),
    db.prepare(READ_HALT_SQL),
  ]);

  const changed = directChanges(results?.[1]);
  const row = results?.[2]?.results?.[0] ?? null;
  const next = decodeHaltState(row);

  if (!next.ok) {
    throw new Error(next.reason);
  }

  if (changed === 1) {
    if (
      !next.halted ||
      next.generation !== expected + 1 ||
      next.actorClass !== 'automation' ||
      next.reason !== normalizedReason
    ) {
      throw new Error('halt set write/readback mismatch');
    }

    return Object.freeze({ changed: true, state: next });
  }

  if (changed === 0 && next.halted) {
    return Object.freeze({ changed: false, state: next });
  }

  throw new Error('halt set compare-and-set failed');
}

export const publicationHaltSql = Object.freeze({
  read: READ_HALT_SQL,
  setByAutomation: SET_HALT_SQL,
  directChanges: DIRECT_CHANGES_SQL,
});
