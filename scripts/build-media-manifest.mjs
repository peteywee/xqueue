#!/usr/bin/env node
// build-media-manifest.mjs — Tier 2 media artifact.
//
// Binds each Tier 1 requirement to a REAL local media file and records its true extension, byte size
// and SHA-256. Because it depends on bytes that are deliberately not in git (media/* is gitignored),
// its output is NOT committed: it is regenerated on the machine that actually holds the figures.
//
// Fail-closed by construction. It never invents a filename, a size, or a hash. Any missing figure,
// ambiguous match, or empty file aborts the whole manifest with a non-zero exit.
//
// This script has no publication authority. It uploads nothing and posts nothing.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_EXTENSIONS,
  KEY_ROOT,
  REQUIREMENTS_PATH,
  loadRequirements,
} from './build-media-requirements.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = join(ROOT, 'media-manifest.json');
export const MANIFEST_FORMAT = 1;

export function defaultMediaDir({ root = ROOT, env = process.env } = {}) {
  return env.MEDIA_DIR ?? join(root, 'media');
}

/**
 * Resolve one figure number to its local source file.
 *
 * The match convention is src/cli.mjs `figurePath`:
 *   /(?:figure[-_]?)?0*<n>\.(png|jpg|jpeg|gif|webp)$/i
 * over the entries of MEDIA_DIR, with ONE deliberate difference beyond returning every candidate
 * rather than the first: the number must not be preceded by another digit.
 *
 * The CLI pattern is unanchored, so `0*1\.png$` also matches `figure-11.png`, `figure-21.png` and
 * `figure-101.png`. In a real media directory holding figures 1..30 that makes figures 1 and 9
 * ambiguous, and this builder — correctly refusing ambiguity — could then never produce a manifest
 * at all. The `[^0-9]` boundary removes exactly those digit-suffix collisions and nothing else: the
 * accepted set is a strict subset of the CLI's, so a name this resolves is always a name the CLI
 * would also accept. A name it no longer matches fails loudly as "no local source file found".
 */
export function findFigureCandidates(mediaDir, figure) {
  if (!existsSync(mediaDir)) return null;

  if (!Number.isInteger(figure) || figure < 0) {
    throw new Error(`figure must be a non-negative integer, received: ${String(figure)}`);
  }

  const pattern = new RegExp(
    `^(?:.*[^0-9])?0*${figure}\\.(${ALLOWED_EXTENSIONS.join('|')})$`,
    'i',
  );

  return readdirSync(mediaDir)
    .filter((name) => pattern.test(name))
    .sort();
}

export function extensionOf(fileName) {
  const match = fileName.match(new RegExp(`\\.(${ALLOWED_EXTENSIONS.join('|')})$`, 'i'));
  if (!match) {
    throw new Error(`Local media file has no allowed extension: ${fileName}`);
  }
  return match[1].toLowerCase();
}

export function r2KeyFor(logicalMediaId, extension) {
  return `${KEY_ROOT}/${logicalMediaId}.${extension}`;
}

/** Stable serialization used for the manifest digest — object order and key order are fixed. */
export function canonicalizeManifestObjects(objects) {
  return `${JSON.stringify(
    objects.map((o) => ({
      postId: o.postId,
      figure: o.figure,
      logicalMediaId: o.logicalMediaId,
      r2Key: o.r2Key,
      extension: o.extension,
      byteSize: o.byteSize,
      sha256: o.sha256,
    })),
    null,
    2,
  )}\n`;
}

export function manifestSha256(objects) {
  return createHash('sha256').update(canonicalizeManifestObjects(objects), 'utf8').digest('hex');
}

export function buildMediaManifest({
  root = ROOT,
  mediaDir = defaultMediaDir({ root }),
  requirementsPath = REQUIREMENTS_PATH,
} = {}) {
  const requirements = loadRequirements(requirementsPath);
  const problems = [];
  const objects = [];

  if (!existsSync(mediaDir)) {
    throw new Error(
      `Media directory does not exist: ${mediaDir}. ` +
        'Set MEDIA_DIR to the directory holding the real figure files, or place them in ./media.',
    );
  }

  for (const requirement of requirements.objects) {
    const candidates = findFigureCandidates(mediaDir, requirement.figure) ?? [];

    if (candidates.length === 0) {
      problems.push(
        `figure ${requirement.figure} (post ${requirement.postId}, ${requirement.logicalMediaId}): ` +
          `no local source file found in ${mediaDir}`,
      );
      continue;
    }

    if (candidates.length > 1) {
      problems.push(
        `figure ${requirement.figure} (post ${requirement.postId}, ${requirement.logicalMediaId}): ` +
          `ambiguous — ${candidates.length} candidate files match (${candidates.join(', ')})`,
      );
      continue;
    }

    const fileName = candidates[0];
    const localSource = join(mediaDir, fileName);

    // A directory or a dangling symlink named like a figure would otherwise escape as a raw EISDIR
    // or ENOENT from statSync/readFileSync, losing the figure and post the operator needs to fix.
    const stats = lstatSync(localSource, { throwIfNoEntry: false });
    const resolved = stats?.isSymbolicLink()
      ? statSync(localSource, { throwIfNoEntry: false })
      : stats;

    if (!resolved || !resolved.isFile()) {
      problems.push(
        `figure ${requirement.figure} (post ${requirement.postId}, ${requirement.logicalMediaId}): ` +
          `local source is not a regular file: ${localSource}`,
      );
      continue;
    }

    const byteSize = resolved.size;

    if (byteSize === 0) {
      problems.push(
        `figure ${requirement.figure} (post ${requirement.postId}, ${requirement.logicalMediaId}): ` +
          `local source is empty (0 bytes): ${localSource}`,
      );
      continue;
    }

    const extension = extensionOf(fileName);
    const bytes = readFileSync(localSource);

    objects.push({
      postId: requirement.postId,
      figure: requirement.figure,
      logicalMediaId: requirement.logicalMediaId,
      localSource: relative(root, localSource).replaceAll('\\', '/'),
      extension,
      r2Key: r2KeyFor(requirement.logicalMediaId, extension),
      byteSize,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to build a media manifest: ${problems.length} of ${requirements.objects.length} ` +
        `required figure(s) could not be resolved from real local files.\n  - ${problems.join('\n  - ')}\n` +
        'A manifest is only valid when every required figure resolves to exactly one real, non-empty ' +
        'local file. Nothing was written.',
    );
  }

  objects.sort((a, b) => a.figure - b.figure);

  return {
    format: MANIFEST_FORMAT,
    requirementsFormat: requirements.format,
    generatedFrom: requirements.generatedFrom,
    bucket: 'xqueue-media',
    mediaDir: relative(root, mediaDir).replaceAll('\\', '/') || '.',
    requiredCount: requirements.requiredCount,
    resolvedCount: objects.length,
    objects,
    manifestSha256: manifestSha256(objects),
  };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function loadManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `Media manifest is missing: ${path}. Run: node scripts/build-media-manifest.mjs`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Re-derives the digest and compares it to the recorded one. */
export function verifyManifestIntegrity(manifest) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.objects)) {
    return { ok: false, reason: 'manifest_malformed' };
  }
  const recomputed = manifestSha256(manifest.objects);
  if (recomputed !== manifest.manifestSha256) {
    return { ok: false, reason: 'manifest_digest_mismatch', expected: manifest.manifestSha256, actual: recomputed };
  }
  return { ok: true, reason: null };
}

function main() {
  const mediaDir = defaultMediaDir();
  let manifest;

  try {
    manifest = buildMediaManifest({ mediaDir });
  } catch (error) {
    console.error(`media-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(MANIFEST_PATH, serializeManifest(manifest));

  console.log(
    `Media manifest: ${manifest.resolvedCount}/${manifest.requiredCount} required object(s) resolved from ${mediaDir}.`,
  );
  for (const object of manifest.objects) {
    console.log(`  ${object.postId}  figure ${object.figure}  ${object.r2Key}  ${object.byteSize}B  ${object.sha256}`);
  }
  console.log(`manifestSha256: ${manifest.manifestSha256}`);
  console.log(`Wrote ${MANIFEST_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
