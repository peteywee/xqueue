import { createHash } from 'node:crypto';

export const OWNER_OPERATION_FORMAT = 1;
export const OWNER_OPERATION_SCOPE = 'preview-only-until-dynamic-cutover';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function sha256Hex(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function str(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}
function pos(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`);
  return n;
}
function instant(value, label) {
  str(value, label);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return value;
}
function nowIso(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('now must be valid');
    return value.toISOString();
  }
  return instant(value, 'now');
}
function sha(value, label) {
  const v = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(v)) throw new Error(`${label} must be a sha256 hex digest`);
  return v;
}
function reason(value) {
  const v = str(value, 'owner reason').trim();
  if (v.length > 1000) throw new Error('owner reason is too long');
  return v;
}
function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}
function qi(value) { return String(pos(value, 'SQL integer')); }
function op(kind, material) {
  const payload_digest = sha256Hex(JSON.stringify({ format: OWNER_OPERATION_FORMAT, kind, ...material }));
  return { payload_digest, operation_id: `owner-${kind}-${payload_digest.slice(0, 24)}` };
}

function publicationGuard(state, contentId) {
  if (state == null) return null;
  if (state.post_id !== undefined && state.post_id !== contentId) {
    throw new Error('publication_state post_id does not match content');
  }
  if (state.status !== 'scheduled') {
    throw new Error(`future owner operation refused: publication_state is ${state.status}`);
  }
  if (state.attempt_id != null) {
    throw new Error('future owner operation refused: publication attempt is already bound');
  }
  return { generation: pos(state.generation, 'publication_state generation') };
}

function baseGuard(content, assignment) {
  if (!content || typeof content !== 'object') throw new Error('content snapshot is required');
  if (!assignment || typeof assignment !== 'object') throw new Error('active assignment snapshot is required');
  const contentId = str(content.content_id, 'content_id');
  if (!ID_RE.test(contentId)) throw new Error('content_id is invalid');
  if (content.status !== 'active') throw new Error('content is not active');
  if (assignment.content_id !== contentId) throw new Error('assignment content_id does not match content');
  if (assignment.status !== 'active') throw new Error('assignment is not active');
  return {
    contentId,
    currentRevision: pos(content.current_revision, 'content current_revision'),
    contentGeneration: pos(content.generation, 'content generation'),
    assignmentVersion: pos(assignment.assignment_version, 'assignment version'),
    assignmentGeneration: pos(assignment.generation ?? assignment.assignment_generation, 'assignment generation'),
    assignmentContentRevision: pos(assignment.content_revision, 'assignment content_revision'),
    assignmentDigest: sha(assignment.content_digest, 'assignment content_digest'),
    resolvedAt: instant(assignment.resolved_at, 'assignment resolved_at'),
  };
}

export function assertFutureOwnerMutable({ content, activeAssignment, publicationState = null, now = new Date() }) {
  const base = baseGuard(content, activeAssignment);
  const at = nowIso(now);
  if (base.resolvedAt <= at) throw new Error('future owner operation refused: assignment is due or past due');
  return Object.freeze({ ...base, now: at, publication: publicationGuard(publicationState, base.contentId) });
}

function revisionMaterial({ content, currentRevision, latestRevision, title, body, figure, sourceRef }) {
  if (!currentRevision || typeof currentRevision !== 'object') throw new Error('current revision snapshot is required');
  if (currentRevision.content_id !== content.content_id) throw new Error('current revision content_id mismatch');
  if (Number(currentRevision.revision) !== Number(content.current_revision)) {
    throw new Error('current revision does not match content.current_revision');
  }
  const next = {
    title: title === undefined ? String(currentRevision.title ?? '') : String(title),
    body: body === undefined ? str(currentRevision.body, 'current revision body') : str(body, 'new body'),
    figure: figure === undefined
      ? (currentRevision.figure == null ? null : Number(currentRevision.figure))
      : (figure == null ? null : pos(figure, 'new figure')),
    source_ref: sourceRef === undefined
      ? (currentRevision.source_ref ?? null)
      : (sourceRef == null ? null : String(sourceRef)),
  };
  next.publication_text = next.body;
  next.content_digest = sha256Hex(next.publication_text);
  if (content.pillar === 'B' && !/not legal advice/i.test(next.body)) {
    throw new Error('pillar B revision must already include the approved legal disclaimer');
  }
  const oldMaterial = JSON.stringify({
    title: String(currentRevision.title ?? ''), body: currentRevision.body,
    publication_text: currentRevision.publication_text,
    figure: currentRevision.figure == null ? null : Number(currentRevision.figure),
    source_ref: currentRevision.source_ref ?? null,
  });
  const newMaterial = JSON.stringify({
    title: next.title, body: next.body, publication_text: next.publication_text,
    figure: next.figure, source_ref: next.source_ref,
  });
  if (oldMaterial === newMaterial) throw new Error('revision is a no-op');
  const latest = latestRevision == null ? Number(content.current_revision) : pos(latestRevision.revision, 'latest revision');
  if (latest < Number(content.current_revision)) throw new Error('latest revision is behind current revision');
  return { revision: latest + 1, ...next };
}

export function planContentRevision({
  content, currentRevision, latestRevision = null, activeAssignment, publicationState = null,
  title, body, figure, sourceRef, reason: why, now = new Date(),
}) {
  const g = assertFutureOwnerMutable({ content, activeAssignment, publicationState, now });
  const currentDigest = sha(currentRevision?.content_digest, 'current revision content_digest');
  const publicationText = str(currentRevision?.publication_text, 'current revision publication_text');
  if (sha256Hex(publicationText) !== currentDigest) throw new Error('current revision publication_text digest mismatch');
  if (Number(currentRevision?.revision) !== g.assignmentContentRevision || currentDigest !== g.assignmentDigest) {
    throw new Error('current revision is not the exact revision bound by the active assignment');
  }
  const next = revisionMaterial({ content, currentRevision, latestRevision, title, body, figure, sourceRef });
  const material = {
    content_id: g.contentId,
    expected_content_generation: g.contentGeneration,
    bound_assignment_id: activeAssignment.assignment_id,
    bound_assignment_version: g.assignmentVersion,
    bound_assignment_generation: g.assignmentGeneration,
    bound_content_revision: g.assignmentContentRevision,
    bound_content_digest: g.assignmentDigest,
    publication_state_generation: g.publication?.generation ?? null,
    from_revision: g.currentRevision,
    to_revision: next.revision,
    to_content_digest: next.content_digest,
    reason: reason(why),
  };
  return Object.freeze({
    format: OWNER_OPERATION_FORMAT, kind: 'revise', scope: OWNER_OPERATION_SCOPE,
    ...op('revise', material), ...material,
    revision: Object.freeze({ content_id: g.contentId, ...next }), planned_at: g.now,
  });
}

function targetRevision(contentId, row) {
  if (!row || typeof row !== 'object') throw new Error('target revision snapshot is required');
  if (row.content_id !== contentId) throw new Error('target revision content_id mismatch');
  const revision = pos(row.revision, 'target revision');
  const content_digest = sha(row.content_digest, 'target content_digest');
  const publication_text = str(row.publication_text, 'target revision publication_text');
  if (sha256Hex(publication_text) !== content_digest) throw new Error('target revision publication_text digest mismatch');
  return { ...row, revision, content_digest, figure: row.figure == null ? null : pos(row.figure, 'target figure') };
}
function targetMedia(target, row) {
  if (target.figure == null) return null;
  if (!row || typeof row !== 'object') throw new Error('target revision media is required before rebind');
  const media = {
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    media_ordinal: Number(row.media_ordinal ?? 0),
    figure: Number(row.figure),
    logical_media_id: str(row.logical_media_id, 'target media logical_media_id'),
    r2_key: str(row.r2_key, 'target media r2_key'),
    extension: str(row.extension, 'target media extension'),
    mime_type: str(row.mime_type, 'target media mime_type'),
    byte_size: pos(row.byte_size, 'target media byte_size'),
    sha256: sha(row.sha256, 'target media sha256'),
    status: row.status,
    generation: pos(row.generation ?? row.media_generation, 'target media generation'),
  };
  if (media.content_id !== target.content_id || media.content_revision !== target.revision ||
      media.figure !== target.figure || media.status !== 'ready' ||
      !Number.isSafeInteger(media.media_ordinal) || media.media_ordinal < 0) {
    throw new Error('target revision media is not ready and exact');
  }
  return Object.freeze(media);
}

export function planAssignmentRebind({
  content, activeAssignment, targetRevision: revision, targetMedia: media = null,
  publicationState = null, reason: why, now = new Date(),
}) {
  const g = assertFutureOwnerMutable({ content, activeAssignment, publicationState, now });
  const target = targetRevision(g.contentId, revision);
  if (target.revision <= g.assignmentContentRevision) throw new Error('rebind target must be a newer content revision');
  const boundMedia = targetMedia(target, media);
  const material = {
    content_id: g.contentId,
    assignment_id: activeAssignment.assignment_id,
    from_assignment_version: g.assignmentVersion,
    to_assignment_version: g.assignmentVersion + 1,
    expected_assignment_generation: g.assignmentGeneration,
    expected_content_generation: g.contentGeneration,
    publication_state_generation: g.publication?.generation ?? null,
    from_content_revision: g.assignmentContentRevision,
    from_content_digest: g.assignmentDigest,
    to_content_revision: target.revision,
    to_content_digest: target.content_digest,
    policy_version: pos(activeAssignment.policy_version, 'policy version'),
    resolved_at: g.resolvedAt,
    target_account: str(activeAssignment.target_account, 'target account'),
    reason: reason(why),
    target_media: boundMedia,
  };
  return Object.freeze({
    format: OWNER_OPERATION_FORMAT, kind: 'rebind', scope: OWNER_OPERATION_SCOPE,
    ...op('rebind', material), ...material,
    scheduled_date: str(activeAssignment.scheduled_date, 'scheduled_date'),
    scheduled_time: str(activeAssignment.scheduled_time, 'scheduled_time'),
    timezone: str(activeAssignment.timezone, 'timezone'),
    slot_label: activeAssignment.slot_label ?? null,
    planned_at: g.now,
  });
}

export function planAssignmentCancel({ content, activeAssignment, publicationState = null, reason: why, now = new Date() }) {
  const g = assertFutureOwnerMutable({ content, activeAssignment, publicationState, now });
  const material = {
    content_id: g.contentId,
    assignment_id: activeAssignment.assignment_id,
    assignment_version: g.assignmentVersion,
    expected_assignment_generation: g.assignmentGeneration,
    expected_content_generation: g.contentGeneration,
    content_revision: g.assignmentContentRevision,
    content_digest: g.assignmentDigest,
    publication_state_generation: g.publication?.generation ?? null,
    reason: reason(why),
  };
  return Object.freeze({
    format: OWNER_OPERATION_FORMAT, kind: 'cancel', scope: OWNER_OPERATION_SCOPE,
    ...op('cancel', material), ...material, planned_at: g.now,
  });
}

function pubSql(plan) {
  if (plan.publication_state_generation == null) return '';
  return ` AND EXISTS (
    SELECT 1 FROM publication_state ps
    WHERE ps.post_id=${q(plan.content_id)} AND ps.status='scheduled'
      AND ps.attempt_id IS NULL AND ps.generation=${qi(plan.publication_state_generation)}
  )`;
}
function mediaSql(plan) {
  const m = plan.target_media;
  if (!m) return '';
  return ` AND EXISTS (
    SELECT 1 FROM queue_media_objects m
    WHERE m.content_id=${q(m.content_id)} AND m.content_revision=${qi(m.content_revision)}
      AND m.media_ordinal=${m.media_ordinal} AND m.figure=${qi(m.figure)}
      AND m.logical_media_id=${q(m.logical_media_id)} AND m.r2_key=${q(m.r2_key)}
      AND m.extension=${q(m.extension)} AND m.mime_type=${q(m.mime_type)}
      AND m.byte_size=${qi(m.byte_size)} AND m.sha256=${q(m.sha256)}
      AND m.status='ready' AND m.generation=${qi(m.generation)}
  )`;
}
function at(value) { return instant(value, 'recordedAt'); }

export function renderRevisionCreateSql(plan, { recordedAt = new Date().toISOString() } = {}) {
  if (plan?.kind !== 'revise') throw new Error('revise plan is required');
  const t = at(recordedAt);
  const r = plan.revision;
  const detail = JSON.stringify({ operationId: plan.operation_id, reason: plan.reason,
    fromRevision: plan.from_revision, toRevision: plan.to_revision,
    contentDigest: r.content_digest, assignmentVersion: plan.bound_assignment_version });
  return `
INSERT OR IGNORE INTO queue_content_revisions
(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at)
SELECT ${q(r.content_id)},${qi(r.revision)},${q(r.title)},${q(r.body)},${q(r.publication_text)},${q(r.content_digest)},${r.figure == null ? 'NULL' : qi(r.figure)},${q(r.source_ref)},${q(t)}
WHERE EXISTS (
  SELECT 1 FROM queue_content c JOIN queue_assignments a ON a.content_id=c.content_id
  WHERE c.content_id=${q(plan.content_id)} AND c.status='active'
    AND c.current_revision=${qi(plan.from_revision)} AND c.generation=${qi(plan.expected_content_generation)}
    AND a.assignment_id=${q(plan.bound_assignment_id)} AND a.assignment_version=${qi(plan.bound_assignment_version)}
    AND a.generation=${qi(plan.bound_assignment_generation)} AND a.content_revision=${qi(plan.bound_content_revision)}
    AND a.content_digest=${q(plan.bound_content_digest)} AND a.status='active' AND a.resolved_at>${DB_NOW}${pubSql(plan)}
);
INSERT INTO queue_content_events (content_id,revision,event_type,event_at,detail)
SELECT ${q(plan.content_id)},${qi(plan.to_revision)},'revision_created',${q(t)},${q(detail)}
WHERE EXISTS (
  SELECT 1 FROM queue_content_revisions
  WHERE content_id=${q(plan.content_id)} AND revision=${qi(plan.to_revision)}
    AND content_digest=${q(plan.to_content_digest)} AND created_at=${q(t)}
) AND NOT EXISTS (
  SELECT 1 FROM queue_content_events
  WHERE content_id=${q(plan.content_id)} AND revision=${qi(plan.to_revision)}
    AND event_type='revision_created' AND detail=${q(detail)}
);
`;
}

export function renderRebindSql(plan, { recordedAt = new Date().toISOString() } = {}) {
  if (plan?.kind !== 'rebind') throw new Error('rebind plan is required');
  const t = at(recordedAt);
  const supersede = JSON.stringify({ operationId: plan.operation_id, reason: plan.reason,
    fromAssignmentVersion: plan.from_assignment_version, toAssignmentVersion: plan.to_assignment_version,
    fromContentDigest: plan.from_content_digest, toContentDigest: plan.to_content_digest });
  const activate = JSON.stringify({ operationId: plan.operation_id, reason: plan.reason,
    revision: plan.to_content_revision, assignmentVersion: plan.to_assignment_version,
    contentDigest: plan.to_content_digest });
  return `
UPDATE queue_assignments SET status='superseded',superseded_by_version=${qi(plan.to_assignment_version)},
  generation=generation+1,updated_at=${q(t)}
WHERE assignment_id=${q(plan.assignment_id)} AND assignment_version=${qi(plan.from_assignment_version)}
  AND content_id=${q(plan.content_id)} AND content_revision=${qi(plan.from_content_revision)}
  AND content_digest=${q(plan.from_content_digest)} AND generation=${qi(plan.expected_assignment_generation)}
  AND status='active' AND resolved_at>${DB_NOW}
  AND EXISTS (SELECT 1 FROM queue_content c WHERE c.content_id=${q(plan.content_id)} AND c.status='active'
    AND c.current_revision=${qi(plan.from_content_revision)} AND c.generation=${qi(plan.expected_content_generation)})
  AND EXISTS (SELECT 1 FROM queue_content_revisions r WHERE r.content_id=${q(plan.content_id)}
    AND r.revision=${qi(plan.to_content_revision)} AND r.content_digest=${q(plan.to_content_digest)})${mediaSql(plan)}${pubSql(plan)};

INSERT OR IGNORE INTO queue_assignments
(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,policy_version,
 resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,superseded_by_version,generation,created_at,updated_at)
SELECT ${q(plan.assignment_id)},${qi(plan.to_assignment_version)},${q(plan.content_id)},${qi(plan.to_content_revision)},
 ${q(plan.to_content_digest)},${q(plan.target_account)},${qi(plan.policy_version)},${q(plan.resolved_at)},
 ${q(plan.scheduled_date)},${q(plan.scheduled_time)},${q(plan.timezone)},${q(plan.slot_label)},'active',NULL,1,${q(t)},${q(t)}
WHERE EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.from_assignment_version)} AND status='superseded'
  AND superseded_by_version=${qi(plan.to_assignment_version)})
AND EXISTS (SELECT 1 FROM queue_content_revisions WHERE content_id=${q(plan.content_id)}
  AND revision=${qi(plan.to_content_revision)} AND content_digest=${q(plan.to_content_digest)})
AND EXISTS (SELECT 1 FROM queue_content c WHERE c.content_id=${q(plan.content_id)} AND c.status='active'
  AND c.current_revision=${qi(plan.from_content_revision)} AND c.generation=${qi(plan.expected_content_generation)})${mediaSql(plan)}${pubSql(plan)};

UPDATE queue_content SET current_revision=${qi(plan.to_content_revision)},generation=generation+1,
  updated_at=${q(t)},intake_state='scheduled'
WHERE content_id=${q(plan.content_id)} AND current_revision=${qi(plan.from_content_revision)}
  AND generation=${qi(plan.expected_content_generation)}
  AND EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
    AND assignment_version=${qi(plan.to_assignment_version)} AND content_revision=${qi(plan.to_content_revision)}
    AND content_digest=${q(plan.to_content_digest)} AND status='active');

INSERT INTO queue_assignment_events (assignment_id,assignment_version,event_type,event_at,detail)
SELECT ${q(plan.assignment_id)},${qi(plan.from_assignment_version)},'owner_superseded',${q(t)},${q(supersede)}
WHERE EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.from_assignment_version)} AND status='superseded'
  AND superseded_by_version=${qi(plan.to_assignment_version)} AND generation=${qi(plan.expected_assignment_generation + 1)}
  AND updated_at=${q(t)})
AND EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.to_assignment_version)} AND content_revision=${qi(plan.to_content_revision)}
  AND content_digest=${q(plan.to_content_digest)} AND status='active' AND updated_at=${q(t)})
AND NOT EXISTS (SELECT 1 FROM queue_assignment_events WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.from_assignment_version)} AND event_type='owner_superseded' AND detail=${q(supersede)});

INSERT INTO queue_assignment_events (assignment_id,assignment_version,event_type,event_at,detail)
SELECT ${q(plan.assignment_id)},${qi(plan.to_assignment_version)},'owner_rebound',${q(t)},${q(activate)}
WHERE EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.to_assignment_version)} AND content_revision=${qi(plan.to_content_revision)}
  AND content_digest=${q(plan.to_content_digest)} AND status='active' AND updated_at=${q(t)})
AND NOT EXISTS (SELECT 1 FROM queue_assignment_events WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.to_assignment_version)} AND event_type='owner_rebound' AND detail=${q(activate)});

INSERT INTO queue_content_events (content_id,revision,event_type,event_at,detail)
SELECT ${q(plan.content_id)},${qi(plan.to_content_revision)},'revision_activated',${q(t)},${q(activate)}
WHERE EXISTS (SELECT 1 FROM queue_content WHERE content_id=${q(plan.content_id)}
  AND current_revision=${qi(plan.to_content_revision)} AND generation=${qi(plan.expected_content_generation + 1)}
  AND updated_at=${q(t)})
AND NOT EXISTS (SELECT 1 FROM queue_content_events WHERE content_id=${q(plan.content_id)}
  AND revision=${qi(plan.to_content_revision)} AND event_type='revision_activated' AND detail=${q(activate)});
`;
}

export function renderCancelSql(plan, { recordedAt = new Date().toISOString() } = {}) {
  if (plan?.kind !== 'cancel') throw new Error('cancel plan is required');
  const t = at(recordedAt);
  const detail = JSON.stringify({ operationId: plan.operation_id, reason: plan.reason,
    assignmentVersion: plan.assignment_version, contentRevision: plan.content_revision,
    contentDigest: plan.content_digest });
  const publicationSql = plan.publication_state_generation == null ? '' : `
UPDATE publication_state SET status='skipped',skipped_at=${q(t)},skip_reason=${q(plan.reason)},
  updated_at=${q(t)},generation=generation+1
WHERE post_id=${q(plan.content_id)} AND status='scheduled' AND attempt_id IS NULL
  AND generation=${qi(plan.publication_state_generation)}
  AND EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
    AND assignment_version=${qi(plan.assignment_version)} AND status='cancelled'
    AND generation=${qi(plan.expected_assignment_generation + 1)} AND updated_at=${q(t)});
INSERT INTO publication_events (post_id,event_type,event_at,detail)
SELECT ${q(plan.content_id)},'owner_cancelled',${q(t)},${q(detail)}
WHERE EXISTS (SELECT 1 FROM publication_state WHERE post_id=${q(plan.content_id)} AND status='skipped'
  AND skip_reason=${q(plan.reason)} AND skipped_at=${q(t)} AND generation=${qi(plan.publication_state_generation + 1)})
AND NOT EXISTS (SELECT 1 FROM publication_events WHERE post_id=${q(plan.content_id)}
  AND event_type='owner_cancelled' AND detail=${q(detail)});`;
  return `
UPDATE queue_assignments SET status='cancelled',generation=generation+1,updated_at=${q(t)}
WHERE assignment_id=${q(plan.assignment_id)} AND assignment_version=${qi(plan.assignment_version)}
  AND content_id=${q(plan.content_id)} AND content_revision=${qi(plan.content_revision)}
  AND content_digest=${q(plan.content_digest)} AND generation=${qi(plan.expected_assignment_generation)}
  AND status='active' AND resolved_at>${DB_NOW}
  AND EXISTS (SELECT 1 FROM queue_content c WHERE c.content_id=${q(plan.content_id)} AND c.status='active'
    AND c.current_revision=${qi(plan.content_revision)} AND c.generation=${qi(plan.expected_content_generation)})${pubSql(plan)};
UPDATE queue_content SET status='retired',generation=generation+1,updated_at=${q(t)}
WHERE content_id=${q(plan.content_id)} AND current_revision=${qi(plan.content_revision)}
  AND generation=${qi(plan.expected_content_generation)}
  AND EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
    AND assignment_version=${qi(plan.assignment_version)} AND status='cancelled');
${publicationSql}
INSERT INTO queue_assignment_events (assignment_id,assignment_version,event_type,event_at,detail)
SELECT ${q(plan.assignment_id)},${qi(plan.assignment_version)},'owner_cancelled',${q(t)},${q(detail)}
WHERE EXISTS (SELECT 1 FROM queue_assignments WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.assignment_version)} AND status='cancelled'
  AND generation=${qi(plan.expected_assignment_generation + 1)} AND updated_at=${q(t)})
AND NOT EXISTS (SELECT 1 FROM queue_assignment_events WHERE assignment_id=${q(plan.assignment_id)}
  AND assignment_version=${qi(plan.assignment_version)} AND event_type='owner_cancelled' AND detail=${q(detail)});
INSERT INTO queue_content_events (content_id,revision,event_type,event_at,detail)
SELECT ${q(plan.content_id)},${qi(plan.content_revision)},'owner_cancelled',${q(t)},${q(detail)}
WHERE EXISTS (SELECT 1 FROM queue_content WHERE content_id=${q(plan.content_id)} AND status='retired'
  AND generation=${qi(plan.expected_content_generation + 1)} AND updated_at=${q(t)})
AND NOT EXISTS (SELECT 1 FROM queue_content_events WHERE content_id=${q(plan.content_id)}
  AND revision=${qi(plan.content_revision)} AND event_type='owner_cancelled' AND detail=${q(detail)});
`;
}

function same(a, b) { return a === b || (a == null && b == null); }
function fields(row, expected, names) { return names.every((name) => same(row?.[name], expected?.[name])); }

export function classifyRevisionReadback(plan, readback) {
  if (plan?.kind !== 'revise') throw new Error('revise plan is required');
  const { revision, assignment, content } = readback ?? {};
  if (!revision) return 'missing';
  const exactRevision = fields(revision, plan.revision,
    ['content_id','revision','title','body','publication_text','content_digest','figure','source_ref']);
  const stillBound = assignment && assignment.status === 'active' &&
    Number(assignment.assignment_version) === plan.bound_assignment_version &&
    Number(assignment.content_revision) === plan.bound_content_revision && assignment.content_digest === plan.bound_content_digest;
  return exactRevision && stillBound && Number(content?.current_revision) === plan.from_revision ? 'complete' : 'conflict';
}

export function classifyRebindReadback(plan, readback) {
  if (plan?.kind !== 'rebind') throw new Error('rebind plan is required');
  const prior = readback?.priorAssignment, current = readback?.activeAssignment, content = readback?.content;
  if (!prior && !current) return 'missing';
  const oldOk = prior && prior.status === 'superseded' &&
    Number(prior.assignment_version) === plan.from_assignment_version && Number(prior.superseded_by_version) === plan.to_assignment_version;
  const newOk = current && fields(current, {
    assignment_id: plan.assignment_id, assignment_version: plan.to_assignment_version,
    content_id: plan.content_id, content_revision: plan.to_content_revision, content_digest: plan.to_content_digest,
    target_account: plan.target_account, policy_version: plan.policy_version, resolved_at: plan.resolved_at,
    scheduled_date: plan.scheduled_date, scheduled_time: plan.scheduled_time, timezone: plan.timezone,
    slot_label: plan.slot_label, status: 'active',
  }, ['assignment_id','assignment_version','content_id','content_revision','content_digest','target_account','policy_version',
    'resolved_at','scheduled_date','scheduled_time','timezone','slot_label','status']);
  const contentOk = content?.status === 'active' && Number(content.current_revision) === plan.to_content_revision;
  return oldOk && newOk && contentOk ? 'complete' : 'conflict';
}

export function classifyCancelReadback(plan, readback) {
  if (plan?.kind !== 'cancel') throw new Error('cancel plan is required');
  const assignment = readback?.assignment, content = readback?.content, publication = readback?.publicationState;
  if (!assignment && !content) return 'missing';
  const assignmentOk = assignment && fields(assignment, {
    assignment_id: plan.assignment_id, assignment_version: plan.assignment_version,
    content_id: plan.content_id, content_revision: plan.content_revision,
    content_digest: plan.content_digest, status: 'cancelled',
  }, ['assignment_id','assignment_version','content_id','content_revision','content_digest','status']);
  const contentOk = content?.content_id === plan.content_id && content.status === 'retired';
  const publicationOk = plan.publication_state_generation == null ||
    (publication?.status === 'skipped' && publication.skip_reason === plan.reason);
  return assignmentOk && contentOk && publicationOk ? 'complete' : 'conflict';
}
