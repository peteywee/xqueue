// media-verify.mjs — READ-ONLY verification of the xqueue media bucket.
//
// Worker-compatible: zero Node built-in imports, no filesystem, no network beyond the R2 binding.
// It talks to `env.MEDIA` using ONLY `head`, `get` and `list`. It never calls `delete` and never
// calls the write API — this module has no authority to change the bucket, and extra objects it
// does not recognise are reported and deliberately left untouched.
//
// This module has no publication authority. It does not post anything anywhere.
//
// Hash source, in preference order, documented per object as `hashSource`:
//   1. 'r2_checksum'        — object.checksums.sha256 recorded by R2 itself (cheapest, no body read)
//   2. 'custom_metadata'    — object.customMetadata.sha256 set at upload time
//   3. 'body_digest'        — last resort: read the body and digest it with crypto.subtle
// If none of the three yields a digest, the object is NOT verified: it fails with 'no_hash_available'.
// Absence of evidence is never treated as success.
//
// TRUST BOUNDARY. Sources 1 and 2 are ASSERTIONS BY THE BUCKET about bytes this module never reads;
// only source 3 is an observation of the bytes themselves. A bucket that reports a checksum it does
// not honour is therefore believed. Every object records which it was as `hashTrust`
// ('bucket_asserted' | 'body_observed') and the summary counts the observed ones in
// `bodyObservedCount`, so a caller can require real evidence when the trust level matters.

export const KEY_ROOT = 'media/figures';
export const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

const R2_KEY_PATTERN = new RegExp(`^${KEY_ROOT}/figure-\\d{4}\\.(${ALLOWED_EXTENSIONS.join('|')})$`);

const HEX = '0123456789abcdef';

function toHex(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
  }

  let bytes = null;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input && typeof input === 'object' && input.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.buffer, input.byteOffset ?? 0, input.byteLength);
  }

  if (!bytes || bytes.length !== 32) return null;

  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

async function digestHex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return toHex(digest);
}

/** Byte-for-byte the same canonical form as scripts/build-media-manifest.mjs. */
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

export async function computeManifestSha256(objects) {
  const encoded = new TextEncoder().encode(canonicalizeManifestObjects(objects));
  return digestHex(encoded);
}

export function expectedKeys(manifest) {
  const keys = new Set();
  for (const object of manifest?.objects ?? []) {
    if (typeof object?.r2Key === 'string') keys.add(object.r2Key);
  }
  return keys;
}

/**
 * Structural checks that do not need R2 at all. A manifest that fails any of these is rejected
 * whole — no partial verification, no optimistic pass.
 */
export async function inspectManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: 'manifest_malformed' };
  }
  if (!Array.isArray(manifest.objects)) {
    return { ok: false, reason: 'manifest_malformed' };
  }

  const seenFigures = new Set();
  const seenKeys = new Set();

  for (const object of manifest.objects) {
    if (
      !object ||
      typeof object !== 'object' ||
      typeof object.r2Key !== 'string' ||
      typeof object.sha256 !== 'string' ||
      typeof object.logicalMediaId !== 'string' ||
      !Number.isInteger(object.figure) ||
      !Number.isInteger(object.byteSize)
    ) {
      return { ok: false, reason: 'manifest_malformed' };
    }
    if (seenFigures.has(object.figure)) {
      return { ok: false, reason: 'duplicate_figure', figure: object.figure };
    }
    if (seenKeys.has(object.r2Key)) {
      return { ok: false, reason: 'duplicate_r2_key', r2Key: object.r2Key };
    }
    seenFigures.add(object.figure);
    seenKeys.add(object.r2Key);
  }

  if (typeof manifest.manifestSha256 === 'string') {
    const recomputed = await computeManifestSha256(manifest.objects);
    if (recomputed !== manifest.manifestSha256) {
      return { ok: false, reason: 'manifest_digest_mismatch' };
    }
  } else {
    return { ok: false, reason: 'manifest_digest_missing' };
  }

  return { ok: true, reason: null };
}

function failedObject(object, reason, extra = {}) {
  return {
    r2Key: object?.r2Key ?? null,
    logicalMediaId: object?.logicalMediaId ?? null,
    postId: object?.postId ?? null,
    figure: Number.isInteger(object?.figure) ? object.figure : null,
    expected: {
      byteSize: Number.isInteger(object?.byteSize) ? object.byteSize : null,
      sha256: typeof object?.sha256 === 'string' ? object.sha256 : null,
    },
    present: false,
    sizeMatch: false,
    hashMatch: false,
    ok: false,
    reason,
    hashSource: null,
    hashTrust: null,
    ...extra,
  };
}

async function resolveHash(bucket, key, head) {
  const fromChecksum = toHex(head?.checksums?.sha256);
  if (fromChecksum) {
    return { sha256: fromChecksum, hashSource: 'r2_checksum', hashTrust: 'bucket_asserted' };
  }

  const fromMetadata = toHex(head?.customMetadata?.sha256);
  if (fromMetadata) {
    return { sha256: fromMetadata, hashSource: 'custom_metadata', hashTrust: 'bucket_asserted' };
  }

  const body = await bucket.get(key);
  if (!body || typeof body.arrayBuffer !== 'function') {
    return { sha256: null, hashSource: null, hashTrust: null };
  }

  const bytes = await body.arrayBuffer();
  const digested = await digestHex(bytes);
  return digested
    ? { sha256: digested, hashSource: 'body_digest', hashTrust: 'body_observed' }
    : { sha256: null, hashSource: null, hashTrust: null };
}

async function verifyOne(bucket, object) {
  if (!R2_KEY_PATTERN.test(object.r2Key)) {
    return failedObject(object, 'malformed_r2_key');
  }
  if (object.r2Key !== `${KEY_ROOT}/${object.logicalMediaId}.${object.extension}`) {
    return failedObject(object, 'malformed_r2_key');
  }
  if (object.byteSize <= 0) {
    return failedObject(object, 'manifest_malformed');
  }

  const base = failedObject(object, 'unverified');

  let head;
  try {
    head = await bucket.head(object.r2Key);
  } catch {
    return { ...base, reason: 'r2_unreachable' };
  }

  if (!head) return { ...base, reason: 'missing' };

  const actualSize = Number(head.size);
  base.present = true;
  base.actual = { byteSize: Number.isFinite(actualSize) ? actualSize : null, sha256: null };

  if (actualSize === 0) {
    return { ...base, reason: 'zero_byte_object' };
  }
  if (!Number.isFinite(actualSize) || actualSize !== object.byteSize) {
    return { ...base, reason: 'size_mismatch' };
  }

  base.sizeMatch = true;

  let resolved;
  try {
    resolved = await resolveHash(bucket, object.r2Key, head);
  } catch {
    return { ...base, reason: 'r2_unreachable' };
  }

  if (!resolved.sha256) {
    return { ...base, reason: 'no_hash_available' };
  }

  base.actual.sha256 = resolved.sha256;
  base.hashSource = resolved.hashSource;
  base.hashTrust = resolved.hashTrust;

  if (resolved.sha256 !== String(object.sha256).toLowerCase()) {
    return { ...base, reason: 'hash_mismatch' };
  }

  return { ...base, hashMatch: true, ok: true, reason: null };
}

export const MAX_LIST_PAGES = 100;

/**
 * Lists bucket objects that the manifest does not require. Reporting only — nothing is deleted,
 * nothing is rewritten. Returns { ok, objects: [{key, size}], count, complete, reason }.
 *
 * `complete` is false when the walk stopped before the bucket was exhausted — the page ceiling was
 * hit, or R2 reported `truncated` without handing back a cursor. An incomplete listing UNDER-reports
 * strays, so it must never be mistaken for an observed absence of them.
 */
export async function listUnrelatedObjects(env, manifest) {
  const bucket = env?.MEDIA;
  if (!bucket || typeof bucket.list !== 'function') {
    return { ok: false, objects: [], count: 0, complete: false, reason: 'r2_unreachable' };
  }

  const required = expectedKeys(manifest);
  const found = [];
  let complete = false;

  try {
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await bucket.list(cursor ? { cursor } : {});
      for (const object of result?.objects ?? []) {
        if (!required.has(object.key)) {
          found.push({ key: object.key, size: Number(object.size ?? 0) });
        }
      }
      if (!result?.truncated) {
        complete = true;
        break;
      }
      if (!result?.cursor) break;
      cursor = result.cursor;
    }
  } catch {
    return { ok: false, objects: [], count: 0, complete: false, reason: 'r2_unreachable' };
  }

  found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, objects: found, count: found.length, complete, reason: null };
}

/** The fail-closed shape every result starts from: ok false, nothing verified, nothing claimed. */
function emptySummary() {
  return {
    ok: false,
    requiredCount: 0,
    verifiedCount: 0,
    missingCount: 0,
    sizeMismatchCount: 0,
    hashMismatchCount: 0,
    unrelatedObjectCount: 0,
    unrelatedObjects: [],
    unrelatedListing: { ok: false, complete: false, reason: 'r2_unreachable' },
    bodyObservedCount: 0,
    objects: [],
    failures: [],
    reason: null,
    readOnly: true,
  };
}

async function verifyMediaObjectsInner(env, manifest) {
  const empty = emptySummary();

  const inspection = await inspectManifest(manifest).catch(() => ({
    ok: false,
    reason: 'manifest_malformed',
  }));

  if (!inspection.ok) {
    const requiredCount = Array.isArray(manifest?.objects) ? manifest.objects.length : 0;
    return {
      ...empty,
      requiredCount,
      reason: inspection.reason,
      failures: [failedObject(null, inspection.reason)],
    };
  }

  const bucket = env?.MEDIA;
  if (!bucket || typeof bucket.head !== 'function') {
    const failures = manifest.objects.map((o) => failedObject(o, 'r2_unreachable'));
    return {
      ...empty,
      requiredCount: manifest.objects.length,
      missingCount: 0,
      reason: 'r2_unreachable',
      objects: failures,
      failures,
    };
  }

  const objects = [];
  for (const object of manifest.objects) {
    let result;
    try {
      result = await verifyOne(bucket, object);
    } catch {
      result = failedObject(object, 'r2_unreachable');
    }
    objects.push(result);
  }

  const unrelated = await listUnrelatedObjects(env, manifest);
  const failures = objects.filter((o) => !o.ok);

  const summary = {
    ...empty,
    requiredCount: manifest.objects.length,
    verifiedCount: objects.filter((o) => o.ok).length,
    missingCount: objects.filter((o) => o.reason === 'missing').length,
    sizeMismatchCount: objects.filter(
      (o) => o.reason === 'size_mismatch' || o.reason === 'zero_byte_object',
    ).length,
    hashMismatchCount: objects.filter((o) => o.reason === 'hash_mismatch').length,
    unrelatedObjectCount: unrelated.count,
    unrelatedObjects: unrelated.objects,
    unrelatedListing: { ok: unrelated.ok, complete: unrelated.complete, reason: unrelated.reason },
    bodyObservedCount: objects.filter((o) => o.hashTrust === 'body_observed').length,
    objects,
    failures,
    reason: failures.length === 0 ? null : (failures[0]?.reason ?? 'unverified'),
    readOnly: true,
  };

  summary.ok =
    summary.requiredCount > 0 &&
    summary.verifiedCount === summary.requiredCount &&
    failures.length === 0;

  // A manifest that requires nothing can never be evidence that the bucket is correct. It is not ok,
  // and it must say why rather than reporting a reasonless failure.
  if (summary.requiredCount === 0 && summary.reason === null) {
    summary.reason = 'empty_required_set';
  }

  return summary;
}

/**
 * Verifies every object the manifest requires. Read-only.
 *
 * `ok` starts false and only becomes true when every required object is present with a matching
 * size AND a matching SHA-256 — see the TRUST BOUNDARY note above for what "matching" rests on per
 * object (`hashTrust`). Unrelated objects are reported but never affect `ok` and are never removed.
 *
 * Never throws. Any unexpected failure — including a manifest whose own property access raises —
 * collapses to a fail-closed summary rather than a rejected promise.
 */
export async function verifyMediaObjects(env, manifest) {
  try {
    return await verifyMediaObjectsInner(env, manifest);
  } catch {
    return {
      ...emptySummary(),
      reason: 'manifest_malformed',
      failures: [failedObject(null, 'manifest_malformed')],
    };
  }
}
