// continuous-queue-runtime-write.mjs — SQL rendering for governed dynamic
// runtime revision/media mutations. No publication side effects live here.

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function digest(value, label) {
  const text = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${label} must be sha256 hex`);
  }
  return text;
}

function integer(value, label, min = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return number;
}

function canonicalInstant(value, label) {
  requiredString(value, label);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return value;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function nextRuntimeRevision({
  currentState,
  snapshot,
  sourceOperationId = null,
  recordedAt,
}) {
  canonicalInstant(recordedAt, 'recordedAt');
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('runtime snapshot is required');
  }

  const revisionDigest = digest(
    snapshot.revision_digest,
    'snapshot revision digest',
  );

  const counts = {
    active_assignment_count: integer(
      snapshot.active_assignment_count,
      'active assignment count',
    ),
    approved_unscheduled_count: integer(
      snapshot.approved_unscheduled_count,
      'approved-unscheduled count',
    ),
    media_required_count: integer(
      snapshot.media_required_count,
      'media required count',
    ),
    media_ready_count: integer(
      snapshot.media_ready_count,
      'media ready count',
    ),
  };

  if (!currentState) {
    return Object.freeze({
      generation: 1,
      revision_digest: revisionDigest,
      ...counts,
      previous_revision_digest: null,
      source_operation_id: sourceOperationId,
      created_at: recordedAt,
    });
  }

  const currentGeneration = integer(
    currentState.generation,
    'current runtime generation',
    1,
  );
  const currentDigest = digest(
    currentState.revision_digest,
    'current runtime revision digest',
  );

  if (revisionDigest === currentDigest) {
    throw new Error('runtime snapshot digest did not change');
  }

  return Object.freeze({
    generation: currentGeneration + 1,
    revision_digest: revisionDigest,
    ...counts,
    previous_revision_digest: currentDigest,
    source_operation_id: sourceOperationId,
    created_at: recordedAt,
  });
}

export function renderRuntimeRevisionInsertSql(revision) {
  const generation = integer(revision?.generation, 'revision generation', 1);
  const revisionDigest = digest(
    revision?.revision_digest,
    'revision digest',
  );
  const previous =
    revision?.previous_revision_digest == null
      ? null
      : digest(revision.previous_revision_digest, 'previous revision digest');
  canonicalInstant(revision?.created_at, 'revision created_at');

  if (
    (generation === 1 && previous !== null) ||
    (generation > 1 && previous === null)
  ) {
    throw new Error('runtime revision predecessor shape is invalid');
  }

  return (
    'INSERT INTO queue_runtime_revisions (' +
    'generation,revision_digest,active_assignment_count,' +
    'approved_unscheduled_count,media_required_count,media_ready_count,' +
    'previous_revision_digest,source_operation_id,created_at' +
    ') VALUES (' +
    [
      String(generation),
      sqlString(revisionDigest),
      String(integer(revision.active_assignment_count, 'active assignment count')),
      String(integer(revision.approved_unscheduled_count, 'approved-unscheduled count')),
      String(integer(revision.media_required_count, 'media required count')),
      String(integer(revision.media_ready_count, 'media ready count')),
      sqlString(previous),
      sqlString(revision.source_operation_id ?? null),
      sqlString(revision.created_at),
    ].join(',') +
    ');\n'
  );
}

export function renderMediaInsertSql(
  rows,
  {
    recordedAt,
    eventType = 'runtime_media_bound',
  } = {},
) {
  canonicalInstant(recordedAt, 'recordedAt');
  requiredString(eventType, 'eventType');
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('media rows are required');
  }

  const lines = [];

  for (const [index, row] of rows.entries()) {
    const label = `media row ${index + 1}`;
    const contentId = requiredString(row.content_id, `${label} content_id`);
    const contentRevision = integer(
      row.content_revision,
      `${label} content_revision`,
      1,
    );
    const mediaOrdinal = integer(
      row.media_ordinal ?? 0,
      `${label} media_ordinal`,
    );
    const figure =
      row.figure == null ? null : integer(row.figure, `${label} figure`, 1);
    const logicalMediaId = requiredString(
      row.logical_media_id,
      `${label} logical_media_id`,
    );
    const r2Key = requiredString(row.r2_key, `${label} r2_key`);
    const extension = requiredString(row.extension, `${label} extension`);
    const mimeType = requiredString(row.mime_type, `${label} mime_type`);
    const byteSize = integer(row.byte_size, `${label} byte_size`, 1);
    const sha256 = digest(row.sha256, `${label} sha256`);
    const status = row.status ?? 'ready';
    if (!['pending', 'ready', 'retired'].includes(status)) {
      throw new Error(`${label} status is invalid`);
    }
    const generation = integer(
      row.generation ?? 1,
      `${label} generation`,
      1,
    );

    lines.push(
      'INSERT OR ABORT INTO queue_media_objects (' +
      'content_id,content_revision,media_ordinal,figure,logical_media_id,' +
      'r2_key,extension,mime_type,byte_size,sha256,status,generation,' +
      'created_at,updated_at' +
      ') VALUES (' +
      [
        sqlString(contentId),
        String(contentRevision),
        String(mediaOrdinal),
        figure == null ? 'NULL' : String(figure),
        sqlString(logicalMediaId),
        sqlString(r2Key),
        sqlString(extension),
        sqlString(mimeType),
        String(byteSize),
        sqlString(sha256),
        sqlString(status),
        String(generation),
        sqlString(recordedAt),
        sqlString(recordedAt),
      ].join(',') +
      ');',
    );

    lines.push(
      'INSERT INTO queue_media_events (' +
      'content_id,content_revision,media_ordinal,event_type,event_at,detail' +
      ') VALUES (' +
      [
        sqlString(contentId),
        String(contentRevision),
        String(mediaOrdinal),
        sqlString(eventType),
        sqlString(recordedAt),
        sqlString(JSON.stringify({
          r2Key,
          byteSize,
          sha256,
          mimeType,
          status,
        })),
      ].join(',') +
      ');',
    );
  }

  return `${lines.join('\n')}\n`;
}
