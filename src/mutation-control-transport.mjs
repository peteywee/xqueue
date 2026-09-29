const BOOKMARK_RE = /^[A-Za-z0-9_-]{8,}$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(label + ' is required');
  return value;
}

export function timeTravelBookmarkUrl({ accountId, databaseId }) {
  const account = requiredString(accountId, 'accountId');
  const database = requiredString(databaseId, 'databaseId');
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/time_travel/bookmark`;
}

export async function getD1TimeTravelBookmark({
  fetchImpl = globalThis.fetch,
  accountId,
  databaseId,
  apiToken,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const token = requiredString(apiToken, 'apiToken');
  let response;
  try {
    response = await fetchImpl(timeTravelBookmarkUrl({ accountId, databaseId }), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
  } catch (error) {
    const wrapped = new Error('D1 Time Travel bookmark request failed');
    wrapped.code = 'CHECKPOINT_CORRUPT';
    wrapped.cause = error;
    throw wrapped;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const wrapped = new Error('D1 Time Travel bookmark response was not JSON');
    wrapped.code = 'CHECKPOINT_CORRUPT';
    wrapped.cause = error;
    throw wrapped;
  }

  const bookmark = payload?.result?.bookmark;
  if (response.ok !== true || payload?.success !== true || typeof bookmark !== 'string' || !BOOKMARK_RE.test(bookmark)) {
    const wrapped = new Error('D1 Time Travel bookmark response was not usable');
    wrapped.code = 'CHECKPOINT_CORRUPT';
    throw wrapped;
  }
  return bookmark;
}

function ensureDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new Error('D1 database binding with prepare() and batch() is required');
  }
  return db;
}

export function createD1MutationTransport({ db, fetchImpl, accountId, databaseId, apiToken }) {
  const d1 = ensureDb(db);
  const checkpointArgs = { fetchImpl, accountId, databaseId, apiToken };

  return Object.freeze({
    prepare(sql) {
      return d1.prepare(requiredString(sql, 'sql'));
    },

    async captureCheckpoint() {
      return getD1TimeTravelBookmark(checkpointArgs);
    },

    async readHaltState() {
      return d1.prepare(
        'SELECT halted,generation,reason,actor_class,updated_at FROM mutation_lane_halt_state WHERE singleton_id=1',
      ).first();
    },

    async readLaneState() {
      return d1.prepare(
        'SELECT generation,active_operation_id,actor_class,updated_at FROM mutation_lane_state WHERE singleton_id=1',
      ).first();
    },

    async readRuntimeState() {
      return d1.prepare(
        'SELECT generation,revision_digest,source_operation_id,created_at FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1',
      ).first();
    },

    async readOperation(operationId) {
      return d1.prepare('SELECT * FROM mutation_operations WHERE operation_id=?').bind(requiredString(operationId, 'operationId')).first();
    },

    async readOperationItems(operationId) {
      const result = await d1.prepare(
        'SELECT * FROM mutation_operation_items WHERE operation_id=? ORDER BY item_key',
      ).bind(requiredString(operationId, 'operationId')).all();
      return Array.isArray(result) ? result : (result?.results ?? []);
    },

    async readPublicationSafety() {
      const authority = await d1.prepare(
        'SELECT owner,generation,transition_state,candidate_sha,deployment_id,updated_at ' +
        'FROM authority_state WHERE singleton_id=1',
      ).first();
      const unresolved = await d1.prepare(
        "SELECT COUNT(*) AS unresolved FROM publication_state " +
        "WHERE status IN ('prepared','publishing','needs_reconciliation')",
      ).first();
      const leases = await d1.prepare(
        'SELECT COUNT(*) AS active_leases FROM publication_leases ' +
        'WHERE owner_token IS NOT NULL ' +
        "AND expires_at_ms > CAST(strftime('%s','now') AS INTEGER) * 1000",
      ).first();
      const runtime = await d1.prepare(
        "SELECT json_extract(value, '$.inflight') AS inflight " +
        "FROM runtime_metadata WHERE key='state.snapshot_json'",
      ).first();

      return Object.freeze({
        authority: authority ?? null,
        unresolvedAttemptCount: Number(unresolved?.unresolved ?? -1),
        activeLeaseCount: Number(leases?.active_leases ?? -1),
        runtimeSnapshotObserved: runtime !== null,
        inflight: runtime?.inflight ?? null,
      });
    },

    async batch(statements) {
      if (!Array.isArray(statements) || statements.length === 0) throw new Error('mutation batch statements are required');
      for (const statement of statements) {
        if (!statement || typeof statement.run !== 'function') throw new Error('mutation batch requires prepared D1 statements');
      }
      return d1.batch(statements);
    },
  });
}

export function classifyD1TransportException(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code) return code;
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (message.includes('timeout') || message.includes('network') || message.includes('fetch')) return 'D1_BATCH_AMBIGUOUS';
  const duplicateSlot =
    message.includes('unique') &&
    (
      message.includes('slot') ||
      (
        message.includes('queue_assignments.target_account') &&
        message.includes('queue_assignments.resolved_at')
      ) ||
      message.includes('queue_assignments_dispatchable_slot_uq')
    );
  if (duplicateSlot) return 'DUPLICATE_SLOT';
  if (message.includes('runtime') && message.includes('stale')) return 'STALE_RUNTIME';
  if (message.includes('assignment') && message.includes('stale')) return 'STALE_ASSIGNMENT';
  if (message.includes('contended') || message.includes('locked')) return 'MUTATION_LANE_CONTENDED';
  return 'UNMAPPED';
}
