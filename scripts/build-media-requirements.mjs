#!/usr/bin/env node
// build-media-requirements.mjs — Tier 1 media artifact.
//
// Derives the EXACT set of media objects the production queue requires, using nothing but the
// canonical queue regenerated in-process from config/schedule-policy.json + content/.
// It never reads queue.json from disk, and it never inspects real media bytes, so its output is
// fully derivable, deterministic, and safe to commit.
//
// This script has no publication authority. It uploads nothing and posts nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIREMENTS_PATH = join(ROOT, 'cloudflare', 'generated', 'media-requirements.json');

export const REQUIREMENTS_FORMAT = 1;
export const KEY_ROOT = 'media/figures';
export const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** `figure-0001` — the figure number zero-padded to 4 digits. */
export function logicalMediaId(figure) {
  if (!Number.isInteger(figure) || figure < 0) {
    throw new Error(`figure must be a non-negative integer, received: ${String(figure)}`);
  }
  return `figure-${String(figure).padStart(4, '0')}`;
}

export function keyPrefixFor(figure) {
  return `${KEY_ROOT}/${logicalMediaId(figure)}`;
}

/** Regenerate the canonical queue in-process. Never reads queue.json. */
export function regenerateQueue({ root = ROOT } = {}) {
  const policyPath = join(root, 'config', 'schedule-policy.json');
  if (!existsSync(policyPath)) {
    throw new Error(`Production schedule policy is missing: ${policyPath}`);
  }

  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const posts = loadLibrary(join(root, 'content'));

  const queue = schedule(posts, {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });

  return { policy, queue };
}

export function buildMediaRequirements({ root = ROOT } = {}) {
  const { policy, queue } = regenerateQueue({ root });

  const objects = [];
  const seenFigures = new Map();
  const duplicates = [];

  for (const post of queue) {
    if (post.figure == null) continue;

    if (!Number.isInteger(post.figure)) {
      throw new Error(`Post ${post.id} references a non-integer figure: ${String(post.figure)}`);
    }

    const previous = seenFigures.get(post.figure);
    if (previous) {
      duplicates.push({ figure: post.figure, postIds: [previous, post.id] });
      continue;
    }
    seenFigures.set(post.figure, post.id);

    objects.push({
      postId: post.id,
      figure: post.figure,
      logicalMediaId: logicalMediaId(post.figure),
      keyPrefix: keyPrefixFor(post.figure),
    });
  }

  if (duplicates.length > 0) {
    const detail = duplicates
      .map((d) => `figure ${d.figure} referenced by ${d.postIds.join(' and ')}`)
      .join('; ');
    throw new Error(
      `Refusing to build media requirements: a figure is shared by more than one post (${detail}). ` +
        'Each figure must map to exactly one post — resolve this in content/ before regenerating.',
    );
  }

  objects.sort((a, b) => a.figure - b.figure);

  return {
    format: REQUIREMENTS_FORMAT,
    generatedFrom: {
      policyVersion: policy.version,
      campaignStart: policy.campaignStart,
      timezone: policy.timezone,
    },
    queueCount: queue.length,
    requiredCount: objects.length,
    allowedExtensions: [...ALLOWED_EXTENSIONS],
    objects,
  };
}

/** Canonical bytes: 2-space pretty print with a trailing newline. */
export function serializeRequirements(requirements) {
  return `${JSON.stringify(requirements, null, 2)}\n`;
}

export function loadRequirements(path = REQUIREMENTS_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `Media requirements are missing: ${path}. Run: node scripts/build-media-requirements.mjs`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const requirements = buildMediaRequirements();
  writeFileSync(REQUIREMENTS_PATH, serializeRequirements(requirements));

  console.log(
    `Media requirements: ${requirements.requiredCount} object(s) required by ${requirements.queueCount} queued posts.`,
  );
  for (const object of requirements.objects) {
    console.log(`  ${object.postId}  figure ${object.figure}  ${object.keyPrefix}`);
  }
  console.log(`Wrote ${REQUIREMENTS_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
