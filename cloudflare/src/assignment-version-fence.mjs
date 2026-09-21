function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is required');
  }
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function digest(value, label) {
  const text = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(label + ' must be sha256 hex');
  }
  return text;
}

export function normalizeAssignmentFence(expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error('assignment fence identity is required');
  }

  return Object.freeze({
    assignment_id: requiredString(expected.assignment_id, 'assignment_id'),
    assignment_version: positiveInteger(
      expected.assignment_version,
      'assignment_version',
    ),
    content_id: requiredString(expected.content_id, 'content_id'),
    policy_version: positiveInteger(expected.policy_version, 'policy_version'),
    content_digest: digest(expected.content_digest, 'content_digest'),
  });
}

export function compareAssignmentFence(expected, current) {
  let fence;
  try {
    fence = normalizeAssignmentFence(expected);
  } catch {
    return Object.freeze({ ok: false, reason: 'invalid_expected_assignment' });
  }

  if (!current || typeof current !== 'object') {
    return Object.freeze({ ok: false, reason: 'current_assignment_missing' });
  }

  const ok =
    current.status === 'active' &&
    current.lifecycle_state === 'scheduled' &&
    current.assignment_id === fence.assignment_id &&
    Number(current.assignment_version) === fence.assignment_version &&
    current.content_id === fence.content_id &&
    Number(current.policy_version) === fence.policy_version &&
    current.content_digest === fence.content_digest;

  return ok
    ? Object.freeze({ ok: true, reason: null, assignment: current })
    : Object.freeze({
        ok: false,
        reason: 'stale_assignment_identity',
        assignment: current,
      });
}

export async function verifyCurrentAssignmentFence(db, expected) {
  if (!db || typeof db.prepare !== 'function') {
    return Object.freeze({ ok: false, reason: 'assignment_store_unavailable' });
  }

  let fence;
  try {
    fence = normalizeAssignmentFence(expected);
  } catch {
    return Object.freeze({ ok: false, reason: 'invalid_expected_assignment' });
  }

  try {
    const result = await db.prepare(
      [
        'SELECT assignment_id,assignment_version,content_id,content_digest,',
        'target_account,policy_version,resolved_at,status,lifecycle_state,generation',
        'FROM queue_assignments',
        "WHERE assignment_id=?1 AND status='active' AND lifecycle_state='scheduled'",
        'ORDER BY assignment_version DESC LIMIT 2',
      ].join(' '),
    ).bind(fence.assignment_id).all();

    const rows = Array.isArray(result) ? result : (result?.results ?? []);
    if (rows.length === 0) {
      return Object.freeze({ ok: false, reason: 'current_assignment_missing' });
    }
    if (rows.length !== 1) {
      return Object.freeze({ ok: false, reason: 'assignment_multiplicity' });
    }

    return compareAssignmentFence(fence, rows[0]);
  } catch {
    return Object.freeze({ ok: false, reason: 'assignment_store_unavailable' });
  }
}
