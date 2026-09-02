#!/usr/bin/env node
// r2-media-upload.mjs — deterministic, additive, non-publishing R2 upload helper.
//
// UPLOADING MEDIA IS NOT PUBLICATION AUTHORITY. Local systemd remains the sole publisher.
// This script MUST NEVER post to X, must never touch X credentials, and must never trigger a
// scheduler. All it does is copy the exact bytes named in media-manifest.json into the
// `xqueue-media` R2 bucket under their manifest keys, then verify the result.
//
// Safety properties, all deliberate:
//   * refuses to run without a valid, digest-intact manifest
//   * refuses if a local source's size or SHA-256 no longer matches the manifest
//   * uploads ONLY the keys named in the manifest, ONLY to the bucket `xqueue-media`
//   * idempotent — the same bytes go to the same keys, so a re-run is a no-op in effect
//   * NEVER deletes, prunes, syncs or mirrors; there is no such mode and there never should be
//   * DEFAULTS TO DRY RUN; a real upload requires an explicit --confirm
//   * post-upload verification downloads the remote bytes read-only and re-hashes them locally

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_PATH,
  loadManifest,
  verifyManifestIntegrity,
} from './build-media-manifest.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUCKET = 'xqueue-media';

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function contentTypeFor(extension) {
  // Own-property lookup only: a plain-object index would resolve '__proto__' or 'constructor' off
  // the prototype chain and hand a junk value to --content-type instead of refusing.
  const key = String(extension).toLowerCase();
  if (!Object.hasOwn(CONTENT_TYPES, key)) {
    throw new Error(`Unsupported media extension: ${extension}`);
  }
  return CONTENT_TYPES[key];
}

/** The exact argv `wrangler r2 object put` is invoked with. No other bucket is ever named. */
export function uploadCommand(object) {
  return [
    'wrangler',
    'r2',
    'object',
    'put',
    `${BUCKET}/${object.r2Key}`,
    '--file',
    object.localSource,
    '--content-type',
    contentTypeFor(object.extension),
    '--remote',
  ];
}

/** The exact read-only argv used to fetch remote bytes for independent verification. */
export function downloadCommand(object, destination) {
  return [
    'wrangler',
    'r2',
    'object',
    'get',
    `${BUCKET}/${object.r2Key}`,
    '--file',
    destination,
    '--remote',
  ];
}

/** Re-hashes each local source and compares it to the manifest. Any drift aborts everything. */
export function checkLocalSources(manifest, { root = ROOT } = {}) {
  const problems = [];

  for (const object of manifest.objects) {
    const path = join(root, object.localSource);

    if (!existsSync(path)) {
      problems.push(`${object.r2Key}: local source is missing: ${object.localSource}`);
      continue;
    }

    const byteSize = statSync(path).size;
    if (byteSize !== object.byteSize) {
      problems.push(
        `${object.r2Key}: local source size drifted (manifest ${object.byteSize}B, on disk ${byteSize}B)`,
      );
      continue;
    }

    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (sha256 !== object.sha256) {
      problems.push(
        `${object.r2Key}: local source sha256 drifted (manifest ${object.sha256}, on disk ${sha256})`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Pure verification of bytes fetched back from R2. */
export function verifyRemoteBytes(object, bytes) {
  const byteSize = bytes.byteLength;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sizeMatch = byteSize === object.byteSize;
  const hashMatch = sha256 === object.sha256;

  return {
    byteSize,
    sha256,
    sizeMatch,
    hashMatch,
    ok: sizeMatch && hashMatch,
    reason: !sizeMatch ? 'size_mismatch' : !hashMatch ? 'hash_mismatch' : null,
  };
}

/**
 * Read-only post-upload verification. Wrangler downloads the exact remote object to an isolated
 * temporary file; this process then verifies byte size and SHA-256 against the manifest.
 */
function verifyUploaded(object) {
  const verifyDir = mkdtempSync(join(tmpdir(), 'xqueue-r2-verify-'));
  const destination = join(verifyDir, 'object.bin');

  try {
    const [, ...argvRest] = downloadCommand(object, destination);
    const result = spawnSync('wrangler', argvRest, {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const output = (result.stdout ?? '') + (result.stderr ?? '');

    if (result.status !== 0 || !existsSync(destination)) {
      return {
        r2Key: object.r2Key,
        ok: false,
        reason: 'download_failed',
        status: result.status,
        output,
      };
    }

    const verification = verifyRemoteBytes(object, readFileSync(destination));

    return {
      r2Key: object.r2Key,
      status: result.status,
      output,
      ...verification,
    };
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  return {
    dryRun: !argv.includes('--confirm'),
    confirm: argv.includes('--confirm'),
    explicitDryRun: argv.includes('--dry-run'),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const { dryRun, confirm, explicitDryRun } = parseArgs(argv);

  if (confirm && explicitDryRun) {
    console.error('r2-media-upload: --dry-run and --confirm are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = loadManifest(MANIFEST_PATH);
  } catch (error) {
    console.error(`r2-media-upload: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const integrity = verifyManifestIntegrity(manifest);
  if (!integrity.ok) {
    console.error(
      `r2-media-upload: refusing to upload — manifest failed its integrity check (${integrity.reason}). ` +
        'Regenerate it with: node scripts/build-media-manifest.mjs',
    );
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(manifest.objects) || manifest.objects.length === 0) {
    console.error('r2-media-upload: refusing to upload — manifest names no objects.');
    process.exitCode = 1;
    return;
  }

  const sources = checkLocalSources(manifest);
  if (!sources.ok) {
    console.error(
      `r2-media-upload: refusing to upload — ${sources.problems.length} local source mismatch(es):\n  - ` +
        sources.problems.join('\n  - '),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Bucket: ${BUCKET} (the only bucket this script will ever write to)`);
  console.log(`Objects: ${manifest.objects.length}   manifestSha256: ${manifest.manifestSha256}`);
  console.log('Mode: this script never deletes, prunes, syncs or mirrors — it only puts named keys.');

  if (dryRun) {
    console.log('\nDRY RUN (default). Nothing will be uploaded. Re-run with --confirm to upload.');
    console.log('Commands that would run:');
    for (const object of manifest.objects) {
      console.log(`  ${uploadCommand(object).join(' ')}`);
    }
    return;
  }

  const failures = [];
  for (const object of manifest.objects) {
    const [, ...argvRest] = uploadCommand(object);
    console.log(`put ${BUCKET}/${object.r2Key}  (${object.byteSize}B)`);

    const result = spawnSync('wrangler', argvRest, { encoding: 'utf8', stdio: 'inherit' });
    if (result.status !== 0) {
      failures.push(`${object.r2Key}: wrangler exited ${result.status ?? 'null'}`);
    }
  }

  if (failures.length > 0) {
    console.error(`r2-media-upload: ${failures.length} upload(s) failed:\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nVerifying uploaded objects by downloading and re-hashing remote bytes (read-only)…');
  const unverified = [];
  for (const object of manifest.objects) {
    const check = verifyUploaded(object);
    console.log(
      `  ${check.ok ? 'ok     ' : 'FAILED '} ${check.r2Key}` +
        (check.reason ? ` (${check.reason})` : ''),
    );
    if (!check.ok) unverified.push(`${check.r2Key}: ${check.reason ?? 'unverified'}`);
  }

  if (unverified.length > 0) {
    console.error(`r2-media-upload: post-upload verification failed for:\n  - ${unverified.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${manifest.objects.length} object(s) uploaded and byte-verified. Nothing was deleted.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
