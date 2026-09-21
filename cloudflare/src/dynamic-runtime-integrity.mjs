// dynamic-runtime-integrity.mjs — read-only verification of the durable
// continuous-queue content, assignment, revision, and media model.
//
// This module is intentionally NON-AUTHORITATIVE until #46. It can prove that
// D1 + R2 contain a coherent runtime queue without changing which publication
// path production uses.
//
// Worker-compatible: no node: imports. D1 access is SELECT-only and R2 access
// is delegated to the existing read-only media verifier.

import {
  computeManifestSha256,
  verifyMediaObjects,
} from './media-verify.mjs';

export const DYNAMIC_RUNTIME_FORMAT = 1;

export const RUNTIME_STATE_SQL = `
SELECT
  generation,
  revision_digest,
  active_assignment_count,
  approved_unscheduled_count,
  media_required_count,
  media_ready_count,
  source_operation_id,
  created_at AS updated_at
FROM queue_runtime_revisions
ORDER BY generation DESC
LIMIT 1
`;

export const ACTIVE_ASSIGNMENTS_SQL = `
SELECT
  a.assignment_id,
  a.assignment_version,
  a.content_id,
  a.content_revision,
  a.content_digest,
  a.target_account,
  a.policy_version,
  a.resolved_at,
  a.scheduled_date,
  a.scheduled_time,
  a.timezone,
  a.slot_label,
  a.status,
  a.lifecycle_state,
  a.superseded_by_version,
  a.generation AS assignment_generation,
  c.pillar,
  c.intake_state,
  r.title,
  r.body,
  r.publication_text,
  r.content_digest AS revision_content_digest,
  r.figure,
  r.source_ref
FROM queue_assignments a
JOIN queue_content c
  ON c.content_id = a.content_id
JOIN queue_content_revisions r
  ON r.content_id = a.content_id
 AND r.revision = a.content_revision
WHERE a.status = 'active'
  AND a.lifecycle_state = 'scheduled'
ORDER BY
  a.target_account,
  a.resolved_at,
  a.content_id,
  a.assignment_version
`;

export const DEFERRED_ASSIGNMENTS_SQL = `
SELECT
  a.assignment_id,
  a.assignment_version,
  a.content_id,
  a.content_revision,
  a.content_digest,
  a.target_account,
  a.policy_version,
  a.resolved_at,
  a.scheduled_date,
  a.scheduled_time,
  a.timezone,
  a.slot_label,
  a.status,
  a.lifecycle_state,
  a.superseded_by_version,
  a.generation AS assignment_generation,
  d.reason AS deferral_reason,
  d.deferred_at,
  d.state AS deferral_state,
  c.pillar,
  c.intake_state,
  r.title,
  r.body,
  r.publication_text,
  r.content_digest AS revision_content_digest,
  r.figure,
  r.source_ref
FROM queue_assignments a
JOIN queue_deferrals d
  ON d.content_id = a.content_id
 AND d.assignment_id = a.assignment_id
 AND d.assignment_version = a.assignment_version
JOIN queue_content c
  ON c.content_id = a.content_id
JOIN queue_content_revisions r
  ON r.content_id = a.content_id
 AND r.revision = a.content_revision
WHERE
  a.status = 'active'
  AND a.lifecycle_state = 'deferred'
  AND d.state = 'pending_replacement'
ORDER BY a.resolved_at, a.content_id, a.assignment_version
`;

export const APPROVED_UNSCHEDULED_SQL = `
SELECT
  c.content_id,
  c.current_revision AS content_revision,
  c.pillar,
  c.intake_state,
  r.title,
  r.body,
  r.publication_text,
  r.content_digest,
  r.figure,
  r.source_ref
FROM queue_content c
JOIN queue_content_revisions r
  ON r.content_id = c.content_id
 AND r.revision = c.current_revision
LEFT JOIN queue_assignments a
  ON a.content_id = c.content_id
 AND a.status = 'active'
WHERE
  c.status = 'active'
  AND c.intake_state = 'approved_unscheduled'
  AND a.content_id IS NULL
ORDER BY c.content_id
`;

export const CURRENT_MEDIA_SQL = `
SELECT
  m.content_id,
  m.content_revision,
  m.media_ordinal,
  m.figure,
  m.logical_media_id,
  m.r2_key,
  m.extension,
  m.mime_type,
  m.byte_size,
  m.sha256,
  m.status,
  m.generation AS media_generation
FROM queue_media_objects m
JOIN queue_content c
  ON c.content_id = m.content_id
 AND c.current_revision = m.content_revision
WHERE
  c.status = 'active'
  AND m.status <> 'retired'
ORDER BY
  m.content_id,
  m.content_revision,
  m.media_ordinal
`;

export const REVISION_HEAD_SQL = `
SELECT
  generation,
  revision_digest,
  active_assignment_count,
  approved_unscheduled_count,
  media_required_count,
  media_ready_count,
  previous_revision_digest,
  source_operation_id,
  created_at
FROM queue_runtime_revisions
ORDER BY generation DESC
LIMIT 2
`;

const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

function integer(value, label, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return number;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function digestString(value, label) {
  const text = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${label} must be a sha256 hex digest`);
  }
  return text;
}

function canonicalInstant(value, label) {
  requiredString(value, label);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return value;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sortByJson(rows) {
  return [...rows].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

function assignmentIdentity(row) {
  return {
    assignment_id: row.assignment_id,
    assignment_version: Number(row.assignment_version),
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    content_digest: row.content_digest,
    target_account: row.target_account,
    policy_version: Number(row.policy_version),
    resolved_at: row.resolved_at,
    scheduled_date: row.scheduled_date,
    scheduled_time: row.scheduled_time,
    timezone: row.timezone,
    slot_label: row.slot_label ?? null,
    generation: Number(row.assignment_generation),
  };
}

function deferredIdentity(row) {
  return {
    assignment_id: row.assignment_id,
    assignment_version: Number(row.assignment_version),
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    content_digest: row.content_digest,
    policy_version: Number(row.policy_version),
    prior_resolved_at: row.resolved_at,
    reason: row.deferral_reason,
    deferred_at: row.deferred_at,
    generation: Number(row.assignment_generation),
  };
}

function unscheduledIdentity(row) {
  return {
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    content_digest: row.content_digest,
    pillar: row.pillar,
    figure: row.figure == null ? null : Number(row.figure),
  };
}

function mediaIdentity(row) {
  return {
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    media_ordinal: Number(row.media_ordinal),
    figure: row.figure == null ? null : Number(row.figure),
    logical_media_id: row.logical_media_id,
    r2_key: row.r2_key,
    extension: row.extension,
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    sha256: row.sha256,
    status: row.status,
    generation: Number(row.media_generation),
  };
}

export function canonicalRuntimePayload({
  assignments,
  deferred = [],
  approvedUnscheduled,
  media,
}) {
  const payload = {
    format: DYNAMIC_RUNTIME_FORMAT,
    assignments: sortByJson(assignments.map(assignmentIdentity)),
    approved_unscheduled: sortByJson(
      approvedUnscheduled.map(unscheduledIdentity),
    ),
    media: sortByJson(media.map(mediaIdentity)),
  };

  if (deferred.length > 0) {
    payload.deferred = sortByJson(deferred.map(deferredIdentity));
  }

  return payload;
}

export async function runtimeRevisionDigest(rows) {
  const payload = canonicalRuntimePayload(rows);
  return sha256Hex(JSON.stringify(payload));
}

function currentContentKey(contentId, revision) {
  return `${contentId}\u0000${revision}`;
}

async function validateContentDigest(row, label) {
  const publicationText = requiredString(
    row.publication_text,
    `${label} publication_text`,
  );
  const stored = digestString(
    row.revision_content_digest ?? row.content_digest,
    `${label} revision content digest`,
  );
  const observed = await sha256Hex(publicationText);
  if (observed !== stored) {
    throw new Error(`${label} publication text digest mismatch`);
  }
  return stored;
}

function validateMediaRow(row, label) {
  requiredString(row.content_id, `${label} content_id`);
  integer(row.content_revision, `${label} content_revision`, { min: 1 });
  integer(row.media_ordinal, `${label} media_ordinal`);
  if (row.figure !== null && row.figure !== undefined) {
    integer(row.figure, `${label} figure`, { min: 1 });
  }
  const logicalMediaId = requiredString(
    row.logical_media_id,
    `${label} logical_media_id`,
  );
  const r2Key = requiredString(row.r2_key, `${label} r2_key`);
  const extension = requiredString(row.extension, `${label} extension`).toLowerCase();
  const mimeType = requiredString(row.mime_type, `${label} mime_type`).toLowerCase();
  integer(row.byte_size, `${label} byte_size`, { min: 1 });
  digestString(row.sha256, `${label} sha256`);
  integer(row.media_generation, `${label} media_generation`, { min: 1 });

  if (!Object.hasOwn(MIME_BY_EXTENSION, extension)) {
    throw new Error(`${label} extension is unsupported`);
  }
  if (MIME_BY_EXTENSION[extension] !== mimeType) {
    throw new Error(`${label} MIME does not match extension`);
  }
  if (!['pending', 'ready'].includes(row.status)) {
    throw new Error(`${label} status is invalid`);
  }

  const expectedKey = `media/figures/${logicalMediaId}.${extension}`;
  if (r2Key !== expectedKey) {
    throw new Error(`${label} R2 key is not canonical`);
  }
}

export async function buildDynamicRuntimeSnapshot({
  assignments = [],
  deferred = [],
  approvedUnscheduled = [],
  media = [],
} = {}) {
  if (
    !Array.isArray(assignments) ||
    !Array.isArray(deferred) ||
    !Array.isArray(approvedUnscheduled) ||
    !Array.isArray(media)
  ) {
    throw new Error('runtime rows must be arrays');
  }

  const contentIds = new Set();
  const slots = new Set();
  const currentContent = new Map();
  const requirements = new Map();

  for (const [index, row] of assignments.entries()) {
    const label = `assignment ${index + 1}`;
    requiredString(row.assignment_id, `${label} id`);
    integer(row.assignment_version, `${label} version`, { min: 1 });
    const contentId = requiredString(row.content_id, `${label} content_id`);
    const contentRevision = integer(
      row.content_revision,
      `${label} content_revision`,
      { min: 1 },
    );
    const assignmentDigest = digestString(
      row.content_digest,
      `${label} content_digest`,
    );
    const revisionDigest = await validateContentDigest(row, label);

    if (assignmentDigest !== revisionDigest) {
      throw new Error(`${label} assignment/content digest mismatch`);
    }
    if (row.status !== 'active') {
      throw new Error(`${label} is not active`);
    }
    if (row.intake_state !== 'scheduled') {
      throw new Error(`${label} content is not scheduled`);
    }

    requiredString(row.target_account, `${label} target_account`);
    integer(row.policy_version, `${label} policy_version`, { min: 1 });
    canonicalInstant(row.resolved_at, `${label} resolved_at`);
    requiredString(row.scheduled_date, `${label} scheduled_date`);
    requiredString(row.scheduled_time, `${label} scheduled_time`);
    requiredString(row.timezone, `${label} timezone`);
    integer(row.assignment_generation, `${label} generation`, { min: 1 });

    if (contentIds.has(contentId)) {
      throw new Error(`duplicate active content: ${contentId}`);
    }
    contentIds.add(contentId);

    const slotKey = `${row.target_account}\u0000${row.resolved_at}`;
    if (slots.has(slotKey)) {
      throw new Error(
        `duplicate active slot: ${row.target_account} @ ${row.resolved_at}`,
      );
    }
    slots.add(slotKey);

    const key = currentContentKey(contentId, contentRevision);
    currentContent.set(key, {
      contentId,
      contentRevision,
      figure: row.figure == null ? null : integer(row.figure, `${label} figure`, { min: 1 }),
      scheduled: true,
    });
  }


  for (const [index, row] of deferred.entries()) {
    const label = `deferred assignment ${index + 1}`;
    requiredString(row.assignment_id, `${label} id`);
    integer(row.assignment_version, `${label} version`, { min: 1 });
    const contentId = requiredString(row.content_id, `${label} content_id`);
    const contentRevision = integer(
      row.content_revision,
      `${label} content_revision`,
      { min: 1 },
    );
    const assignmentDigest = digestString(
      row.content_digest,
      `${label} content_digest`,
    );
    const revisionDigest = await validateContentDigest(row, label);

    if (assignmentDigest !== revisionDigest) {
      throw new Error(`${label} assignment/content digest mismatch`);
    }
    if (row.status !== 'active' || row.lifecycle_state !== 'deferred') {
      throw new Error(`${label} lifecycle mismatch`);
    }
    if (row.deferral_state !== 'pending_replacement') {
      throw new Error(`${label} deferral projection mismatch`);
    }
    canonicalInstant(row.resolved_at, `${label} resolved_at`);
    canonicalInstant(row.deferred_at, `${label} deferred_at`);
    requiredString(row.deferral_reason, `${label} reason`);

    if (contentIds.has(contentId)) {
      throw new Error(`content has multiple current scheduling states: ${contentId}`);
    }
    contentIds.add(contentId);

    const key = currentContentKey(contentId, contentRevision);
    currentContent.set(key, {
      contentId,
      contentRevision,
      figure: row.figure == null ? null : integer(row.figure, `${label} figure`, { min: 1 }),
      scheduled: false,
      deferred: true,
    });
  }

  for (const [index, row] of approvedUnscheduled.entries()) {
    const label = `approved-unscheduled ${index + 1}`;
    const contentId = requiredString(row.content_id, `${label} content_id`);
    const contentRevision = integer(
      row.content_revision,
      `${label} content_revision`,
      { min: 1 },
    );
    if (row.intake_state !== 'approved_unscheduled') {
      throw new Error(`${label} lifecycle state mismatch`);
    }
    if (contentIds.has(contentId)) {
      throw new Error(
        `content is both scheduled and approved-unscheduled: ${contentId}`,
      );
    }

    await validateContentDigest(row, label);

    const key = currentContentKey(contentId, contentRevision);
    if (currentContent.has(key)) {
      throw new Error(`duplicate current content revision: ${contentId}`);
    }
    currentContent.set(key, {
      contentId,
      contentRevision,
      figure: row.figure == null ? null : integer(row.figure, `${label} figure`, { min: 1 }),
      scheduled: false,
    });
  }

  const mediaByContent = new Map();

  for (const [index, row] of media.entries()) {
    const label = `media ${index + 1}`;
    validateMediaRow(row, label);

    const key = currentContentKey(
      row.content_id,
      Number(row.content_revision),
    );
    if (!currentContent.has(key)) {
      throw new Error(
        `media is bound to a non-current content revision: ${row.content_id}`,
      );
    }

    const list = mediaByContent.get(key) ?? [];
    list.push(row);
    mediaByContent.set(key, list);
  }

  let mediaRequiredCount = 0;
  let mediaReadyCount = 0;

  for (const [key, content] of currentContent.entries()) {
    const rows = mediaByContent.get(key) ?? [];

    if (content.figure == null) {
      if (rows.length > 0) {
        throw new Error(
          `unexpected media binding for content without figure: ${content.contentId}`,
        );
      }
      continue;
    }

    mediaRequiredCount++;

    if (rows.length !== 1) {
      throw new Error(
        `media binding multiplicity for ${content.contentId}: expected 1, got ${rows.length}`,
      );
    }

    const mediaRow = rows[0];
    if (Number(mediaRow.figure) !== content.figure) {
      throw new Error(
        `media figure mismatch for ${content.contentId}`,
      );
    }
    if (mediaRow.status !== 'ready') {
      throw new Error(
        `media is not ready for ${content.contentId}`,
      );
    }

    mediaReadyCount++;
  }

  const digest = await runtimeRevisionDigest({
    assignments,
    deferred,
    approvedUnscheduled,
    media,
  });

  return Object.freeze({
    format: DYNAMIC_RUNTIME_FORMAT,
    revision_digest: digest,
    active_assignment_count: assignments.length,
    deferred_count: deferred.length,
    approved_unscheduled_count: approvedUnscheduled.length,
    media_required_count: mediaRequiredCount,
    media_ready_count: mediaReadyCount,
    assignments,
    deferred,
    approvedUnscheduled,
    media,
  });
}

function d1Rows(result) {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

async function all(db, sql) {
  const statement = db?.prepare?.(sql);
  if (!statement || typeof statement.all !== 'function') {
    throw new Error('D1 query interface is unavailable');
  }
  return d1Rows(await statement.all());
}

async function first(db, sql) {
  const statement = db?.prepare?.(sql);
  if (!statement) throw new Error('D1 query interface is unavailable');
  if (typeof statement.first === 'function') return await statement.first();
  const rows = d1Rows(await statement.all());
  return rows[0] ?? null;
}

export async function readDynamicRuntimeRows(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is not available');
  }

  const [assignments, deferred, approvedUnscheduled, media] = await Promise.all([
    all(db, ACTIVE_ASSIGNMENTS_SQL),
    all(db, DEFERRED_ASSIGNMENTS_SQL),
    all(db, APPROVED_UNSCHEDULED_SQL),
    all(db, CURRENT_MEDIA_SQL),
  ]);

  return { assignments, deferred, approvedUnscheduled, media };
}

export async function readRuntimeState(db) {
  return first(db, RUNTIME_STATE_SQL);
}

export async function readRuntimeRevisionHead(db) {
  return all(db, REVISION_HEAD_SQL);
}

function sameRuntimeState(a, b) {
  if (!a || !b) return false;
  return (
    Number(a.generation) === Number(b.generation) &&
    a.revision_digest === b.revision_digest &&
    Number(a.active_assignment_count) === Number(b.active_assignment_count) &&
    Number(a.approved_unscheduled_count) === Number(b.approved_unscheduled_count) &&
    Number(a.media_required_count) === Number(b.media_required_count) &&
    Number(a.media_ready_count) === Number(b.media_ready_count)
  );
}

function validateStateShape(state) {
  if (!state) throw new Error('runtime revision state is missing');
  const generation = integer(state.generation, 'runtime generation', { min: 1 });
  const revisionDigest = digestString(
    state.revision_digest,
    'runtime revision digest',
  );
  return {
    generation,
    revisionDigest,
    activeAssignmentCount: integer(
      state.active_assignment_count,
      'runtime active assignment count',
    ),
    approvedUnscheduledCount: integer(
      state.approved_unscheduled_count,
      'runtime approved-unscheduled count',
    ),
    mediaRequiredCount: integer(
      state.media_required_count,
      'runtime media required count',
    ),
    mediaReadyCount: integer(
      state.media_ready_count,
      'runtime media ready count',
    ),
  };
}

function validateRevisionHead(rows, state) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('runtime revision history is missing');
  }

  const latest = rows[0];
  if (
    Number(latest.generation) !== state.generation ||
    latest.revision_digest !== state.revisionDigest
  ) {
    throw new Error('runtime revision history head does not match current state');
  }

  if (state.generation === 1) {
    if (latest.previous_revision_digest != null) {
      throw new Error('runtime generation 1 has a previous digest');
    }
    return;
  }

  if (rows.length < 2) {
    throw new Error('runtime revision history predecessor is missing');
  }

  const previous = rows[1];
  if (
    Number(previous.generation) !== state.generation - 1 ||
    latest.previous_revision_digest !== previous.revision_digest
  ) {
    throw new Error('runtime revision history chain is broken');
  }
}

export async function dynamicMediaManifest(mediaRows) {
  const ready = mediaRows
    .filter((row) => row.status === 'ready')
    .map((row) => ({
      postId: row.content_id,
      figure: Number(row.figure),
      logicalMediaId: row.logical_media_id,
      r2Key: row.r2_key,
      extension: row.extension,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
    }));

  return {
    format: 2,
    objects: ready,
    manifestSha256: await computeManifestSha256(ready),
  };
}

function fail(reason, extra = {}) {
  return Object.freeze({
    ok: false,
    authoritative: false,
    readOnly: true,
    reason,
    generation: null,
    revisionDigest: null,
    activeAssignmentCount: null,
    approvedUnscheduledCount: null,
    deferredCount: null,
    mediaRequiredCount: null,
    mediaReadyCount: null,
    media: null,
    ...extra,
  });
}

export async function verifyDynamicRuntime(
  env,
  {
    expectedGeneration = null,
    expectedRevisionDigest = null,
    verifyMedia = true,
  } = {},
) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    return fail('dynamic_d1_unavailable');
  }

  let stateBefore;
  try {
    stateBefore = await readRuntimeState(db);
  } catch {
    return fail('dynamic_schema_unavailable');
  }

  if (!stateBefore) return fail('runtime_revision_missing');

  let state;
  try {
    state = validateStateShape(stateBefore);
  } catch {
    return fail('runtime_revision_invalid');
  }

  if (
    expectedGeneration !== null &&
    Number(expectedGeneration) !== state.generation
  ) {
    return fail('stale_runtime_revision', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
    });
  }
  if (
    expectedRevisionDigest !== null &&
    expectedRevisionDigest !== state.revisionDigest
  ) {
    return fail('stale_runtime_revision', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
    });
  }

  let rows;
  let head;
  let stateAfter;

  try {
    rows = await readDynamicRuntimeRows(db);
    head = await readRuntimeRevisionHead(db);
    stateAfter = await readRuntimeState(db);
  } catch {
    return fail('dynamic_snapshot_unavailable', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
    });
  }

  if (!sameRuntimeState(stateBefore, stateAfter)) {
    return fail('dynamic_snapshot_changed_during_read', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
    });
  }

  try {
    validateRevisionHead(head, state);
  } catch {
    return fail('runtime_revision_history_invalid', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
    });
  }

  let snapshot;
  try {
    snapshot = await buildDynamicRuntimeSnapshot(rows);
  } catch (error) {
    return fail('dynamic_snapshot_invalid', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (snapshot.revision_digest !== state.revisionDigest) {
    return fail('runtime_revision_digest_mismatch', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
      observedRevisionDigest: snapshot.revision_digest,
    });
  }

  if (
    snapshot.active_assignment_count !== state.activeAssignmentCount ||
    snapshot.approved_unscheduled_count !== state.approvedUnscheduledCount ||
    snapshot.media_required_count !== state.mediaRequiredCount ||
    snapshot.media_ready_count !== state.mediaReadyCount
  ) {
    return fail('runtime_revision_count_mismatch', {
      generation: state.generation,
      revisionDigest: state.revisionDigest,
      activeAssignmentCount: snapshot.active_assignment_count,
      approvedUnscheduledCount: snapshot.approved_unscheduled_count,
      mediaRequiredCount: snapshot.media_required_count,
      mediaReadyCount: snapshot.media_ready_count,
    });
  }

  let mediaVerdict = {
    ok: true,
    requiredCount: 0,
    verifiedCount: 0,
    readOnly: true,
    reason: null,
    objects: [],
  };

  if (verifyMedia && snapshot.media_required_count > 0) {
    const manifest = await dynamicMediaManifest(rows.media);
    mediaVerdict = await verifyMediaObjects(env, manifest);

    if (
      !mediaVerdict.ok ||
      mediaVerdict.requiredCount !== snapshot.media_required_count ||
      mediaVerdict.verifiedCount !== snapshot.media_ready_count
    ) {
      return fail('dynamic_media_verification_failed', {
        generation: state.generation,
        revisionDigest: state.revisionDigest,
        activeAssignmentCount: snapshot.active_assignment_count,
        approvedUnscheduledCount: snapshot.approved_unscheduled_count,
        mediaRequiredCount: snapshot.media_required_count,
        mediaReadyCount: snapshot.media_ready_count,
        media: mediaVerdict,
      });
    }
  }

  return Object.freeze({
    ok: true,
    authoritative: false,
    readOnly: true,
    reason: null,
    generation: state.generation,
    revisionDigest: state.revisionDigest,
    activeAssignmentCount: snapshot.active_assignment_count,
    approvedUnscheduledCount: snapshot.approved_unscheduled_count,
    deferredCount: snapshot.deferred_count,
    mediaRequiredCount: snapshot.media_required_count,
    mediaReadyCount: snapshot.media_ready_count,
    media: mediaVerdict,
  });
}
