import { createHash } from 'node:crypto';

import { renderPost } from './parse.mjs';
import { resolveUniqueWallClock } from './schedule-slot.mjs';

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function canonicalInstant(value, label) {
  requiredString(value, label);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return value;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlInteger(value) {
  if (value === null || value === undefined) return 'NULL';
  if (!Number.isSafeInteger(value)) throw new Error('SQL integer is invalid');
  return String(value);
}

export function buildContinuousQueueShadow(
  queue,
  {
    policyVersion,
    targetAccount = 'PatrickCra94338',
  } = {},
) {
  if (!Array.isArray(queue) || queue.length === 0) {
    throw new Error('queue must be a non-empty array');
  }

  positiveInteger(policyVersion, 'policyVersion');
  requiredString(targetAccount, 'targetAccount');

  const content = [];
  const revisions = [];
  const assignments = [];
  const ids = new Set();
  const slots = new Set();

  for (const post of queue) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) {
      throw new Error('queue contains a non-object post');
    }

    const contentId = requiredString(post.id, 'post id');
    if (ids.has(contentId)) {
      throw new Error(`duplicate post id: ${contentId}`);
    }
    ids.add(contentId);

    const pillar = requiredString(post.pillar, `${contentId} pillar`);
    if (!['A', 'B', 'C', 'D'].includes(pillar)) {
      throw new Error(`${contentId} pillar is invalid`);
    }

    const title = requiredString(post.title, `${contentId} title`);
    const body = requiredString(post.body, `${contentId} body`);
    const resolvedAt = canonicalInstant(
      post.scheduledAt,
      `${contentId} scheduledAt`,
    );
    const scheduledDate = requiredString(
      post.scheduledDate,
      `${contentId} scheduledDate`,
    );
    const scheduledTime = requiredString(
      post.scheduledTime,
      `${contentId} scheduledTime`,
    );
    const timezone = requiredString(post.timezone, `${contentId} timezone`);

    const derived = resolveUniqueWallClock({
      scheduledDate,
      scheduledTime,
      timezone,
    }).toISOString();

    if (derived !== resolvedAt) {
      throw new Error(
        `${contentId} resolved UTC mismatch: committed ${resolvedAt}, derived ${derived}`,
      );
    }

    const slotKey = `${targetAccount}\u0000${resolvedAt}`;
    if (slots.has(slotKey)) {
      throw new Error(
        `duplicate active slot for ${targetAccount}: ${resolvedAt}`,
      );
    }
    slots.add(slotKey);

    const publicationText = renderPost(post);
    const contentDigest = sha256Hex(publicationText);
    const sourceRef =
      typeof post.sourceFile === 'string' && post.sourceFile.length > 0
        ? `${post.sourceFile}${Number.isSafeInteger(post.sourceLine) ? `:${post.sourceLine}` : ''}`
        : null;

    content.push({
      content_id: contentId,
      pillar,
      current_revision: 1,
      status: 'active',
      generation: 1,
    });

    revisions.push({
      content_id: contentId,
      revision: 1,
      title,
      body,
      publication_text: publicationText,
      content_digest: contentDigest,
      figure: post.figure ?? null,
      source_ref: sourceRef,
    });

    assignments.push({
      assignment_id: contentId,
      assignment_version: 1,
      content_id: contentId,
      content_revision: 1,
      content_digest: contentDigest,
      target_account: targetAccount,
      policy_version: policyVersion,
      resolved_at: resolvedAt,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      timezone,
      slot_label: post.slot ?? null,
      status: 'active',
      superseded_by_version: null,
      generation: 1,
    });
  }

  return Object.freeze({
    format: 1,
    policy_version: policyVersion,
    target_account: targetAccount,
    count: queue.length,
    content,
    revisions,
    assignments,
  });
}

export function shadowManifestJson(model) {
  return `${JSON.stringify(model, null, 2)}\n`;
}

export function shadowManifestSha256(model) {
  return sha256Hex(shadowManifestJson(model));
}

export function renderShadowBackfillSql(
  model,
  {
    recordedAt,
  } = {},
) {
  canonicalInstant(recordedAt, 'recordedAt');

  if (
    !model ||
    !Array.isArray(model.content) ||
    !Array.isArray(model.revisions) ||
    !Array.isArray(model.assignments) ||
    model.content.length !== model.count ||
    model.revisions.length !== model.count ||
    model.assignments.length !== model.count
  ) {
    throw new Error('shadow model is malformed');
  }

  const lines = [
    '-- GENERATED SHADOW BACKFILL — DO NOT HAND-EDIT.',
    '-- Non-authoritative #88 seed. Applying it does not change publication authority.',
    `-- model_sha256: ${shadowManifestSha256(model)}`,
    `-- recorded_at: ${recordedAt}`,
    '',
  ];

  for (const row of model.content) {
    lines.push(
      'INSERT OR ABORT INTO queue_content ' +
      '(content_id, pillar, current_revision, status, generation, created_at, updated_at) VALUES (' +
      [
        sqlString(row.content_id),
        sqlString(row.pillar),
        sqlInteger(row.current_revision),
        sqlString(row.status),
        sqlInteger(row.generation),
        sqlString(recordedAt),
        sqlString(recordedAt),
      ].join(', ') +
      ');',
    );
  }

  for (const row of model.revisions) {
    lines.push(
      'INSERT OR ABORT INTO queue_content_revisions ' +
      '(content_id, revision, title, body, publication_text, content_digest, figure, source_ref, created_at) VALUES (' +
      [
        sqlString(row.content_id),
        sqlInteger(row.revision),
        sqlString(row.title),
        sqlString(row.body),
        sqlString(row.publication_text),
        sqlString(row.content_digest),
        sqlInteger(row.figure),
        sqlString(row.source_ref),
        sqlString(recordedAt),
      ].join(', ') +
      ');',
    );

    lines.push(
      'INSERT INTO queue_content_events ' +
      '(content_id, revision, event_type, event_at, detail) VALUES (' +
      [
        sqlString(row.content_id),
        sqlInteger(row.revision),
        sqlString('shadow_backfilled'),
        sqlString(recordedAt),
        sqlString(JSON.stringify({ contentDigest: row.content_digest })),
      ].join(', ') +
      ');',
    );
  }

  for (const row of model.assignments) {
    lines.push(
      'INSERT OR ABORT INTO queue_assignments ' +
      '(assignment_id, assignment_version, content_id, content_revision, content_digest, target_account, policy_version, resolved_at, scheduled_date, scheduled_time, timezone, slot_label, status, superseded_by_version, generation, created_at, updated_at) VALUES (' +
      [
        sqlString(row.assignment_id),
        sqlInteger(row.assignment_version),
        sqlString(row.content_id),
        sqlInteger(row.content_revision),
        sqlString(row.content_digest),
        sqlString(row.target_account),
        sqlInteger(row.policy_version),
        sqlString(row.resolved_at),
        sqlString(row.scheduled_date),
        sqlString(row.scheduled_time),
        sqlString(row.timezone),
        sqlString(row.slot_label),
        sqlString(row.status),
        sqlInteger(row.superseded_by_version),
        sqlInteger(row.generation),
        sqlString(recordedAt),
        sqlString(recordedAt),
      ].join(', ') +
      ');',
    );

    lines.push(
      'INSERT INTO queue_assignment_events ' +
      '(assignment_id, assignment_version, event_type, event_at, detail) VALUES (' +
      [
        sqlString(row.assignment_id),
        sqlInteger(row.assignment_version),
        sqlString('shadow_backfilled'),
        sqlString(recordedAt),
        sqlString(JSON.stringify({
          contentDigest: row.content_digest,
          policyVersion: row.policy_version,
          resolvedAt: row.resolved_at,
        })),
      ].join(', ') +
      ');',
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}
