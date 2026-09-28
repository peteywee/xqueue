const ALLOWED_WRITE_TABLES = new Set([
  'queue_content',
  'queue_content_revisions',
  'queue_content_events',
  'queue_assignments',
  'queue_assignment_events',
  'queue_deferrals',
  'queue_deferral_events',
  'queue_intake_frontier',
  'queue_intake_operations',
  'queue_intake_items',
  'queue_runtime_revisions',
  'publication_state',
  'publication_events',
]);

const FORBIDDEN_SQL = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM|DROP|ALTER|CREATE|REINDEX)\b/i;
const WRITE_RE = /^\s*(?:INSERT(?:\s+OR\s+(?:IGNORE|ABORT|REPLACE|FAIL|ROLLBACK))?\s+INTO|UPDATE|REPLACE\s+INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

function requiredString(value, label, max = 4096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(label + ' is required');
  }
  if (value.length > max) throw new Error(label + ' is too long');
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function exactSha(value) {
  const sha = requiredString(value, 'candidateSha', 40).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('candidateSha must be exact 40-character Git SHA');
  }
  return sha;
}

function exactDeploymentId(value) {
  const deploymentId = requiredString(value, 'deploymentId', 256);
  if (!/^cloudflare-worker:xqueue-publisher-production:version:[0-9a-f-]{36}$/i.test(deploymentId)) {
    throw new Error('deploymentId is not an exact publisher Worker version identity');
  }
  return deploymentId;
}

export function validateMutationStatement(sql) {
  const text = requiredString(sql, 'SQL statement', 200_000).trim();
  if (FORBIDDEN_SQL.test(text)) {
    throw new Error('transaction/schema-control SQL is forbidden in production control batches');
  }

  const write = text.match(WRITE_RE);
  if (write) {
    const table = write[1].toLowerCase();
    if (!ALLOWED_WRITE_TABLES.has(table)) {
      throw new Error('production control write table is not allowed: ' + table);
    }
    return Object.freeze({ kind: 'write', table, sql: text });
  }

  if (!/^\s*SELECT\b/i.test(text)) {
    throw new Error('production control batch statements must be SELECT or approved queue mutations');
  }

  return Object.freeze({ kind: 'read', table: null, sql: text });
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') throw new Error('JSON body is required');
  const statements = body.statements;
  if (!Array.isArray(statements) || statements.length < 1 || statements.length > 96) {
    throw new Error('statements must contain 1..96 SQL statements');
  }

  const expected = body.expected;
  if (!expected || typeof expected !== 'object') {
    throw new Error('expected production guard is required');
  }

  return Object.freeze({
    operationKind: requiredString(body.operationKind, 'operationKind', 64),
    statements: statements.map((statement) => validateMutationStatement(statement).sql),
    expected: Object.freeze({
      haltGeneration: positiveInteger(expected.haltGeneration, 'haltGeneration'),
      candidateSha: exactSha(expected.candidateSha),
      deploymentId: exactDeploymentId(expected.deploymentId),
    }),
  });
}

function productionGuard(db, expected) {
  return db.prepare(
    `SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM publication_halt_state
        WHERE singleton_id=1
          AND halted=1
          AND generation=?1
          AND actor_class='owner'
      )
      AND EXISTS (
        SELECT 1 FROM authority_state
        WHERE singleton_id=1
          AND owner='cloudflare'
          AND transition_state='stable'
          AND lower(candidate_sha)=?2
          AND deployment_id=?3
      )
      AND NOT EXISTS (
        SELECT 1 FROM publication_state
        WHERE status IN ('prepared','publishing','needs_reconciliation')
      )
      AND NOT EXISTS (
        SELECT 1 FROM publication_leases
        WHERE owner_token IS NOT NULL
          AND expires_at_ms > CAST(strftime('%s','now') AS INTEGER) * 1000
      )
      AND EXISTS (
        SELECT 1 FROM runtime_metadata
        WHERE key='state.snapshot_json'
          AND json_extract(value,'$.inflight') IS NULL
      )
      THEN 1
      ELSE abs(-9223372036854775808)
    END AS xqueue_production_guard`,
  ).bind(
    expected.haltGeneration,
    expected.candidateSha,
    expected.deploymentId,
  );
}

async function executeBatch(env, request) {
  const supplied = request.headers.get('authorization') ?? '';
  const expectedToken = 'Bearer ' + String(env.XQUEUE_CONTROL_TOKEN ?? '');
  if (
    !env.XQUEUE_CONTROL_TOKEN ||
    supplied.length !== expectedToken.length ||
    supplied !== expectedToken
  ) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = normalizeBody(await request.json());
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  try {
    const prepared = [
      productionGuard(env.DB, body.expected),
      ...body.statements.map((statement) => env.DB.prepare(statement)),
    ];
    const results = await env.DB.batch(prepared);
    return json({
      ok: true,
      operationKind: body.operationKind,
      guard: results[0] ?? null,
      results: results.slice(1),
    });
  } catch (error) {
    return json(
      {
        ok: false,
        operationKind: body.operationKind,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 409 },
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ready' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'xqueue-production-control-local',
        publicationCapable: false,
      });
    }

    if (url.pathname === '/batch' && request.method === 'POST') {
      return executeBatch(env, request);
    }

    return json({ ok: false, error: 'not_found' }, { status: 404 });
  },
};
